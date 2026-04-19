//! Filesystem built-ins. Every call resolves paths against an optional
//! `workspace_root` so the agent operates on the user's project, not the
//! whole disk. Write paths get no extra sandboxing here — the permission
//! system (`commands::permissions`) is the security boundary.

use std::path::{Path, PathBuf};

use globset::GlobBuilder;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::SearcherBuilder;
use ignore::WalkBuilder;
use serde_json::Value;

/// Maximum lines returned in a single `read_file` call unless `limit` is set.
const DEFAULT_READ_LIMIT: usize = 2000;
/// Default cap on grep / glob result lines to avoid dumping a whole repo.
const DEFAULT_HEAD_LIMIT: usize = 250;
/// Hard cap on `write_file` content. Large writes are almost always wrong
/// (the model dumping giant blobs) and risk filling the user's disk.
const MAX_WRITE_BYTES: usize = 10 * 1024 * 1024;

/// Read a text file and return its contents prefixed with line numbers.
pub async fn read_file(args: &Value, workspace_root: Option<&Path>) -> Result<String, String> {
    let path = require_path(args, "read_file")?;
    let path = resolve_path(&path, workspace_root)?;
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(DEFAULT_READ_LIMIT)
        .max(1);

    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("read_file {}: {}", path.display(), e))?;

    let lines: Vec<&str> = content.split('\n').collect();
    // `split('\n')` produces a trailing empty string for files ending in \n;
    // trim it so the line count matches the user's mental model.
    let total = if lines.last() == Some(&"") {
        lines.len().saturating_sub(1)
    } else {
        lines.len()
    };
    let end = offset.saturating_add(limit).min(total);

    let mut out = String::new();
    if offset >= total && total > 0 {
        return Ok(format!(
            "(empty slice: offset {} >= line count {})\n",
            offset, total
        ));
    }
    for i in offset..end {
        out.push_str(&format!("{:>6}\t{}\n", i + 1, lines[i]));
    }
    if end < total {
        out.push_str(&format!(
            "\n... truncated at line {} of {} (pass offset={} to continue)\n",
            end, total, end
        ));
    }
    Ok(out)
}

/// Walk files under `path` (or workspace root) and return those matching the
/// glob pattern. Honors `.gitignore`.
pub async fn glob(args: &Value, workspace_root: Option<&Path>) -> Result<String, String> {
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or("glob: missing `pattern`")?
        .to_string();
    let root = resolve_search_root(args, workspace_root)?;

    let matcher = GlobBuilder::new(&pattern)
        .literal_separator(false)
        .build()
        .map_err(|e| format!("glob: invalid pattern `{}`: {}", pattern, e))?
        .compile_matcher();

    let root_for_thread = root.clone();
    let matches: Vec<PathBuf> = tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        for entry in WalkBuilder::new(&root_for_thread).build().flatten() {
            if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                continue;
            }
            let path = entry.path();
            let rel = path.strip_prefix(&root_for_thread).unwrap_or(path);
            if matcher.is_match(rel) {
                out.push(path.to_path_buf());
            }
        }
        out
    })
    .await
    .map_err(|e| format!("glob: walker panicked: {}", e))?;

    if matches.is_empty() {
        return Ok(format!("No files matched `{}` under {}\n", pattern, root.display()));
    }

    let mut out = String::new();
    for p in &matches {
        out.push_str(&p.display().to_string());
        out.push('\n');
    }
    Ok(out)
}

/// Regex content search across workspace files. Three output modes:
///  - `files_with_matches` (default): list of paths that contain ≥1 match
///  - `content`: file:line:text for each match (with `-n`, `-A`, `-B` the
///    expected extras)
///  - `count`: per-file match counts
pub async fn grep(args: &Value, workspace_root: Option<&Path>) -> Result<String, String> {
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or("grep: missing `pattern`")?
        .to_string();
    let root = resolve_search_root(args, workspace_root)?;
    let glob_filter = args
        .get("glob")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let output_mode = args
        .get("output_mode")
        .and_then(Value::as_str)
        .unwrap_or("files_with_matches")
        .to_string();
    let case_insensitive = args
        .get("case_insensitive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let line_numbers = args
        .get("line_numbers")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let head_limit = args
        .get("head_limit")
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(DEFAULT_HEAD_LIMIT)
        .max(1);

    // Pre-compile matchers outside the walker thread so errors surface early.
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(case_insensitive)
        .build(&pattern)
        .map_err(|e| format!("grep: invalid regex `{}`: {}", pattern, e))?;

    let glob_matcher = glob_filter
        .as_ref()
        .map(|g| {
            GlobBuilder::new(g)
                .literal_separator(false)
                .build()
                .map(|b| b.compile_matcher())
                .map_err(|e| format!("grep: invalid glob `{}`: {}", g, e))
        })
        .transpose()?;

    let root_for_thread = root.clone();
    let mode = output_mode.clone();
    let out = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut searcher = SearcherBuilder::new()
            .line_number(line_numbers)
            .multi_line(false)
            .build();

        let mut buf = String::new();
        let mut emitted = 0usize;

        'outer: for entry in WalkBuilder::new(&root_for_thread).build().flatten() {
            if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                continue;
            }
            let path = entry.path();
            if let Some(gm) = &glob_matcher {
                let rel = path.strip_prefix(&root_for_thread).unwrap_or(path);
                if !gm.is_match(rel) {
                    continue;
                }
            }

            match mode.as_str() {
                "files_with_matches" => {
                    let mut hit = false;
                    let _ = searcher.search_path(
                        &matcher,
                        path,
                        UTF8(|_lnum, _line| {
                            hit = true;
                            Ok(false) // stop after first match
                        }),
                    );
                    if hit {
                        buf.push_str(&path.display().to_string());
                        buf.push('\n');
                        emitted += 1;
                    }
                }
                "count" => {
                    let mut n = 0usize;
                    let _ = searcher.search_path(
                        &matcher,
                        path,
                        UTF8(|_lnum, _line| {
                            n += 1;
                            Ok(true)
                        }),
                    );
                    if n > 0 {
                        buf.push_str(&format!("{}:{}\n", path.display(), n));
                        emitted += 1;
                    }
                }
                "content" => {
                    let mut wrote_any = false;
                    let path_disp = path.display().to_string();
                    let _ = searcher.search_path(
                        &matcher,
                        path,
                        UTF8(|lnum, line| {
                            if emitted >= head_limit {
                                return Ok(false);
                            }
                            let line = line.trim_end_matches('\n');
                            if line_numbers {
                                buf.push_str(&format!("{}:{}:{}\n", path_disp, lnum, line));
                            } else {
                                buf.push_str(&format!("{}:{}\n", path_disp, line));
                            }
                            emitted += 1;
                            wrote_any = true;
                            Ok(true)
                        }),
                    );
                    let _ = wrote_any;
                }
                other => return Err(format!("grep: unknown output_mode `{}`", other)),
            }

            if emitted >= head_limit {
                buf.push_str(&format!(
                    "\n... truncated at {} (pass head_limit to raise)\n",
                    head_limit
                ));
                break 'outer;
            }
        }

        if buf.is_empty() {
            buf.push_str("No matches.\n");
        }
        Ok(buf)
    })
    .await
    .map_err(|e| format!("grep: searcher panicked: {}", e))??;

    Ok(out)
}

/// Create or overwrite a file. Creates parent directories as needed.
pub async fn write_file(args: &Value, workspace_root: Option<&Path>) -> Result<String, String> {
    let path = require_path(args, "write_file")?;
    let path = resolve_path(&path, workspace_root)?;
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .ok_or("write_file: missing `content`")?
        .to_string();

    if content.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "write_file: content is {} bytes, exceeds {} limit — write in smaller chunks",
            content.len(),
            MAX_WRITE_BYTES
        ));
    }

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("write_file: create parent {}: {}", parent.display(), e))?;
    }

    let existed = path.exists();
    tokio::fs::write(&path, &content)
        .await
        .map_err(|e| format!("write_file {}: {}", path.display(), e))?;

    let action = if existed { "Updated" } else { "Created" };
    Ok(format!(
        "{} {} ({} bytes).\n",
        action,
        path.display(),
        content.len()
    ))
}

/// Replace an exact string in a file. Fails unless `old_string` occurs
/// exactly once (or `replace_all` is true). Preserves the file's original
/// line-ending style so mixed-EOL repos don't drift.
pub async fn edit_file(args: &Value, workspace_root: Option<&Path>) -> Result<String, String> {
    let path = require_path(args, "edit_file")?;
    let path = resolve_path(&path, workspace_root)?;
    let old_string = args
        .get("old_string")
        .and_then(Value::as_str)
        .ok_or("edit_file: missing `old_string`")?
        .to_string();
    let new_string = args
        .get("new_string")
        .and_then(Value::as_str)
        .ok_or("edit_file: missing `new_string`")?
        .to_string();
    let replace_all = args
        .get("replace_all")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if old_string.is_empty() {
        return Err("edit_file: `old_string` must be non-empty".into());
    }
    if old_string == new_string {
        return Err("edit_file: `old_string` and `new_string` are identical".into());
    }

    let original = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("edit_file {}: {}", path.display(), e))?;

    let count = count_occurrences(&original, &old_string);
    if count == 0 {
        return Err(format!(
            "edit_file: `old_string` not found in {}",
            path.display()
        ));
    }
    if count > 1 && !replace_all {
        return Err(format!(
            "edit_file: `old_string` occurs {} times in {} — pass `replace_all: true` or \
             extend the context until the match is unique",
            count,
            path.display()
        ));
    }

    // Detect and preserve CRLF if the file uses it. `str::replace` is purely
    // byte-level so the replacement inherits whatever EOLs are in
    // `new_string`; normalize to match the file so users don't see mixed
    // line endings after an edit.
    let uses_crlf = detect_crlf(&original);
    let effective_old = if uses_crlf {
        to_crlf(&old_string)
    } else {
        old_string.clone()
    };
    let effective_new = if uses_crlf {
        to_crlf(&new_string)
    } else {
        new_string.clone()
    };

    // Re-count with CRLF-normalized needle in case the caller passed LF but
    // the file is CRLF. If the normalized count differs we trust that, since
    // it matches what the user sees on disk.
    let effective_count = count_occurrences(&original, &effective_old);
    if effective_count == 0 {
        return Err(format!(
            "edit_file: `old_string` not found in {} after line-ending normalization",
            path.display()
        ));
    }
    if effective_count > 1 && !replace_all {
        return Err(format!(
            "edit_file: `old_string` occurs {} times in {} — pass `replace_all: true` or \
             extend the context until the match is unique",
            effective_count,
            path.display()
        ));
    }

    let updated = if replace_all {
        original.replace(&effective_old, &effective_new)
    } else {
        original.replacen(&effective_old, &effective_new, 1)
    };

    tokio::fs::write(&path, &updated)
        .await
        .map_err(|e| format!("edit_file: write {}: {}", path.display(), e))?;

    Ok(format!(
        "Edited {} ({} replacement{}).\n",
        path.display(),
        effective_count,
        if effective_count == 1 { "" } else { "s" }
    ))
}

fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut n = 0usize;
    let mut start = 0usize;
    while let Some(pos) = haystack[start..].find(needle) {
        n += 1;
        start += pos + needle.len();
    }
    n
}

fn detect_crlf(s: &str) -> bool {
    // A single CRLF anywhere is enough to consider the file CRLF-style. We
    // don't support mixed-ending files explicitly; they'll just get whatever
    // the first encountered style dictates.
    s.contains("\r\n")
}

fn to_crlf(s: &str) -> String {
    // Convert any LF not preceded by CR into CRLF. We walk byte-by-byte
    // because `str::replace` on "\n" → "\r\n" would double existing CRLFs.
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() + 16);
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\n' && (i == 0 || bytes[i - 1] != b'\r') {
            out.push(b'\r');
            out.push(b'\n');
        } else {
            out.push(b);
        }
        i += 1;
    }
    // Safe: we only inserted ASCII CR bytes between valid UTF-8 codepoints.
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

// ─── helpers ───────────────────────────────────────────────────────────

fn require_path(args: &Value, tool: &str) -> Result<String, String> {
    args.get("path")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| format!("{}: missing `path`", tool))
}

/// Turn a user-provided string into an absolute path. Relative paths resolve
/// against `workspace_root`; if no root is configured and the path is
/// relative, we error out rather than guessing cwd (the agent's cwd is the
/// Tauri process, not what the user means).
fn resolve_path(raw: &str, workspace_root: Option<&Path>) -> Result<PathBuf, String> {
    let p = Path::new(raw);
    if p.is_absolute() {
        return Ok(p.to_path_buf());
    }
    match workspace_root {
        Some(root) => Ok(root.join(p)),
        None => Err(format!(
            "path `{}` is relative and no workspace root is set — configure one in Settings",
            raw
        )),
    }
}

fn resolve_search_root(
    args: &Value,
    workspace_root: Option<&Path>,
) -> Result<PathBuf, String> {
    if let Some(p) = args.get("path").and_then(Value::as_str) {
        return resolve_path(p, workspace_root);
    }
    workspace_root
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            "no search path given and no workspace root set — configure one in Settings"
                .to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn make_tree() -> TempDir {
        let td = tempfile::tempdir().unwrap();
        let root = td.path();
        std::fs::write(root.join("a.txt"), "alpha\nbeta\ngamma\n").unwrap();
        std::fs::write(root.join("b.md"), "# Header\nhello world\n").unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("lib.rs"), "fn main() {}\n").unwrap();
        td
    }

    #[tokio::test]
    async fn read_file_numbers_lines() {
        let td = make_tree();
        let out = read_file(&json!({ "path": "a.txt" }), Some(td.path())).await.unwrap();
        assert!(out.contains("     1\talpha"));
        assert!(out.contains("     3\tgamma"));
    }

    #[tokio::test]
    async fn read_file_offset_limit() {
        let td = make_tree();
        let out = read_file(
            &json!({ "path": "a.txt", "offset": 1, "limit": 1 }),
            Some(td.path()),
        )
        .await
        .unwrap();
        assert!(out.contains("     2\tbeta"));
        assert!(!out.contains("alpha"));
        assert!(out.contains("truncated at line 2"));
    }

    #[tokio::test]
    async fn read_file_rejects_relative_without_root() {
        let err = read_file(&json!({ "path": "foo.txt" }), None).await.unwrap_err();
        assert!(err.contains("workspace root"));
    }

    #[tokio::test]
    async fn glob_finds_files() {
        let td = make_tree();
        let out = glob(&json!({ "pattern": "**/*.rs" }), Some(td.path())).await.unwrap();
        assert!(out.contains("lib.rs"));
        assert!(!out.contains("a.txt"));
    }

    #[tokio::test]
    async fn grep_files_with_matches() {
        let td = make_tree();
        let out = grep(
            &json!({ "pattern": "hello", "output_mode": "files_with_matches" }),
            Some(td.path()),
        )
        .await
        .unwrap();
        assert!(out.contains("b.md"));
        assert!(!out.contains("a.txt"));
    }

    #[tokio::test]
    async fn grep_content_prints_lines() {
        let td = make_tree();
        let out = grep(
            &json!({ "pattern": "beta", "output_mode": "content" }),
            Some(td.path()),
        )
        .await
        .unwrap();
        assert!(out.contains("a.txt:2:beta"));
    }

    #[tokio::test]
    async fn grep_count_mode() {
        let td = make_tree();
        // Add a file with multiple matches
        std::fs::write(td.path().join("many.txt"), "x\nx\nx\n").unwrap();
        let out = grep(
            &json!({ "pattern": "x", "output_mode": "count" }),
            Some(td.path()),
        )
        .await
        .unwrap();
        assert!(out.contains("many.txt:3"));
    }

    #[tokio::test]
    async fn write_file_creates_new_file() {
        let td = make_tree();
        let out = write_file(
            &json!({ "path": "nested/dir/hello.txt", "content": "hi\n" }),
            Some(td.path()),
        )
        .await
        .unwrap();
        assert!(out.contains("Created"));
        let written = std::fs::read_to_string(td.path().join("nested/dir/hello.txt")).unwrap();
        assert_eq!(written, "hi\n");
    }

    #[tokio::test]
    async fn write_file_overwrites_existing() {
        let td = make_tree();
        write_file(
            &json!({ "path": "a.txt", "content": "new\n" }),
            Some(td.path()),
        )
        .await
        .unwrap();
        let written = std::fs::read_to_string(td.path().join("a.txt")).unwrap();
        assert_eq!(written, "new\n");
    }

    #[tokio::test]
    async fn write_file_rejects_oversized_content() {
        let td = make_tree();
        let big = "x".repeat(MAX_WRITE_BYTES + 1);
        let err = write_file(
            &json!({ "path": "big.txt", "content": big }),
            Some(td.path()),
        )
        .await
        .unwrap_err();
        assert!(err.contains("exceeds"));
    }

    #[tokio::test]
    async fn edit_file_unique_replacement() {
        let td = make_tree();
        let out = edit_file(
            &json!({
                "path": "a.txt",
                "old_string": "beta",
                "new_string": "BETA",
            }),
            Some(td.path()),
        )
        .await
        .unwrap();
        assert!(out.contains("1 replacement"));
        let after = std::fs::read_to_string(td.path().join("a.txt")).unwrap();
        assert_eq!(after, "alpha\nBETA\ngamma\n");
    }

    #[tokio::test]
    async fn edit_file_ambiguous_without_replace_all() {
        let td = make_tree();
        std::fs::write(td.path().join("dup.txt"), "cat\ncat\ndog\n").unwrap();
        let err = edit_file(
            &json!({
                "path": "dup.txt",
                "old_string": "cat",
                "new_string": "CAT",
            }),
            Some(td.path()),
        )
        .await
        .unwrap_err();
        assert!(err.contains("occurs 2 times"));
    }

    #[tokio::test]
    async fn edit_file_replace_all() {
        let td = make_tree();
        std::fs::write(td.path().join("dup.txt"), "cat\ncat\ndog\n").unwrap();
        let out = edit_file(
            &json!({
                "path": "dup.txt",
                "old_string": "cat",
                "new_string": "CAT",
                "replace_all": true,
            }),
            Some(td.path()),
        )
        .await
        .unwrap();
        assert!(out.contains("2 replacements"));
        let after = std::fs::read_to_string(td.path().join("dup.txt")).unwrap();
        assert_eq!(after, "CAT\nCAT\ndog\n");
    }

    #[tokio::test]
    async fn edit_file_missing_old_string_errors() {
        let td = make_tree();
        let err = edit_file(
            &json!({
                "path": "a.txt",
                "old_string": "nope",
                "new_string": "whatever",
            }),
            Some(td.path()),
        )
        .await
        .unwrap_err();
        assert!(err.contains("not found"));
    }

    #[tokio::test]
    async fn edit_file_preserves_crlf() {
        let td = make_tree();
        std::fs::write(td.path().join("crlf.txt"), "one\r\ntwo\r\nthree\r\n").unwrap();
        edit_file(
            &json!({
                "path": "crlf.txt",
                "old_string": "two",
                "new_string": "TWO",
            }),
            Some(td.path()),
        )
        .await
        .unwrap();
        let after = std::fs::read(td.path().join("crlf.txt")).unwrap();
        // The file was CRLF — expect CRLF everywhere still.
        assert_eq!(after, b"one\r\nTWO\r\nthree\r\n");
    }
}
