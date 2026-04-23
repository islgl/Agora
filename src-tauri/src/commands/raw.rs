//! Raw Layer — the inbox for source materials the user drops at Agora.
//!
//! Phase 4 of the personal-assistant work. A file-watcher in
//! `wiki_watcher.rs` detects new entries; this module handles the text
//! extraction contract. Supported formats:
//!
//! | Extension            | Strategy                                 |
//! |----------------------|------------------------------------------|
//! | .md / .markdown / .txt | Read UTF-8 verbatim                   |
//! | .pdf                 | `pdf-extract` crate (native Rust)        |
//! | .html / .htm         | Very-lightweight `<tag>` stripper        |
//! | anything else        | Refuse with a clear reason               |
//!
//! Images and other binary formats are deliberately skipped — we leave
//! room for a future multimodal subagent path.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use walkdir::WalkDir;

use crate::paths;

const MAX_EXTRACT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawFile {
    pub rel_path: String,
    pub abs_path: String,
    pub size_bytes: u64,
    /// Unix timestamp (seconds) when the file was last modified.
    pub modified_at: i64,
    pub supported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedText {
    pub rel_path: String,
    pub text: String,
    pub truncated: bool,
    /// Hint for the ingest prompt — `md` / `pdf` / `html` / `txt`. Empty
    /// for unsupported formats.
    pub kind: String,
}

#[tauri::command]
pub async fn list_raw_files(app: AppHandle) -> Result<Vec<RawFile>, String> {
    let root = paths::raw_dir(&app)?;
    let mut out = Vec::new();
    if !root.exists() {
        return Ok(out);
    }
    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.path();
        if is_hidden(path) {
            continue;
        }
        let rel = path.strip_prefix(&root).ok().map(PathBuf::from);
        let rel = match rel {
            Some(r) => r,
            None => continue,
        };
        let meta = match fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        out.push(RawFile {
            rel_path: rel.to_string_lossy().replace('\\', "/"),
            abs_path: path.to_string_lossy().into_owned(),
            size_bytes: meta.len(),
            modified_at,
            supported: is_supported(path),
        });
    }
    // Newest first so the Raw inbox UI highlights recent drops.
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(out)
}

#[tauri::command]
pub async fn extract_raw_text(app: AppHandle, rel_path: String) -> Result<ExtractedText, String> {
    let root = paths::raw_dir(&app)?;
    let safe = sanitize_rel(&rel_path)?;
    let full = root.join(&safe);
    if !full.exists() {
        return Err(format!("raw file not found: {}", safe.display()));
    }
    extract_file(&full, &safe.to_string_lossy())
}

fn extract_file(path: &Path, rel: &str) -> Result<ExtractedText, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    let (kind, text) = match ext.as_str() {
        "md" | "markdown" | "txt" => ("md".to_string(), read_text_file(path)?),
        "pdf" => (
            "pdf".to_string(),
            pdf_extract::extract_text(path)
                .map_err(|e| format!("pdf-extract failed for {}: {e}", path.display()))?,
        ),
        "html" | "htm" => ("html".to_string(), strip_html(&read_text_file(path)?)),
        other => {
            return Err(format!(
                "unsupported format: .{other} (supported: md, txt, pdf, html)",
            ));
        }
    };

    let truncated = text.len() > MAX_EXTRACT_BYTES;
    let text = if truncated {
        text.chars().take(MAX_EXTRACT_BYTES).collect()
    } else {
        text
    };

    Ok(ExtractedText {
        rel_path: rel.replace('\\', "/"),
        text,
        truncated,
        kind,
    })
}

fn read_text_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Best-effort HTML → plain-text. Not a full renderer — strips tags,
/// collapses whitespace, decodes the few entities we see in practice.
/// For richer extraction users can convert to Markdown first.
fn strip_html(html: &str) -> String {
    static TAG_RE: once_cell::sync::Lazy<regex::Regex> =
        once_cell::sync::Lazy::new(|| regex::Regex::new(r"<[^>]+>").unwrap());
    static WS_RE: once_cell::sync::Lazy<regex::Regex> =
        once_cell::sync::Lazy::new(|| regex::Regex::new(r"\s+").unwrap());
    // Ignore <script> and <style> blocks entirely. Rust's regex crate
    // has no backreferences, so we run two passes rather than one.
    static SCRIPT_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
        regex::RegexBuilder::new(r"<script[^>]*>[\s\S]*?</script>")
            .case_insensitive(true)
            .build()
            .unwrap()
    });
    static STYLE_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
        regex::RegexBuilder::new(r"<style[^>]*>[\s\S]*?</style>")
            .case_insensitive(true)
            .build()
            .unwrap()
    });
    let cleaned = SCRIPT_RE.replace_all(html, " ");
    let cleaned = STYLE_RE.replace_all(&cleaned, " ");
    let no_tags = TAG_RE.replace_all(&cleaned, " ");
    let collapsed = WS_RE.replace_all(&no_tags, " ");
    collapsed
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .trim()
        .to_string()
}

fn is_supported(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .as_deref(),
        Some("md") | Some("markdown") | Some("txt") | Some("pdf") | Some("html") | Some("htm")
    )
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.'))
        .unwrap_or(false)
}

fn sanitize_rel(rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().trim_start_matches('/');
    if rel.is_empty() {
        return Err("rel_path must not be empty".into());
    }
    let path = PathBuf::from(rel);
    if path.is_absolute() {
        return Err("rel_path must be relative".into());
    }
    for comp in path.components() {
        use std::path::Component;
        if matches!(
            comp,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err(format!("rel_path escapes raw root: {rel}"));
        }
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_html_and_removes_scripts() {
        let html = r#"<html><head><style>body{color:red}</style></head>
            <body>Hello <b>world</b>! <script>alert(1)</script> &amp; go.</body></html>"#;
        let out = strip_html(html);
        assert!(!out.contains('<'));
        assert!(!out.contains("alert"));
        assert!(out.contains("Hello world"));
        assert!(out.contains("&"));
    }

    #[test]
    fn extracts_markdown_verbatim() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("note.md");
        fs::write(&p, "# Heading\n\nbody\n").unwrap();
        let got = extract_file(&p, "note.md").unwrap();
        assert_eq!(got.kind, "md");
        assert!(got.text.contains("# Heading"));
    }

    #[test]
    fn refuses_unsupported_format() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("blob.bin");
        fs::write(&p, &[0u8, 1, 2]).unwrap();
        let err = extract_file(&p, "blob.bin").unwrap_err();
        assert!(err.contains("unsupported"));
    }

    #[test]
    fn sanitize_rejects_parent_traversal() {
        assert!(sanitize_rel("../etc/passwd").is_err());
        assert!(sanitize_rel("articles/../../etc").is_err());
        assert!(sanitize_rel("articles/post.md").is_ok());
    }
}
