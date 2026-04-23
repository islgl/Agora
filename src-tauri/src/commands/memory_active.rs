//! Active memory writer — the `remember` tool path (triggered by
//! remember-intent user turns in any language).
//!
//! Phase 2 of the personal-assistant work. The `remember` synthesized
//! tool in the frontend calls `append_to_memory` to land a line into one
//! of the four user-editable Brand files (SOUL / USER / TOOLS / MEMORY).
//!
//! Two guardrails live here rather than in the LLM:
//!
//! 1. **Secret denylist** — regex-match high-entropy token shapes
//!    (`sk-…`, GitHub PATs, Google API keys, Slack tokens). The LLM
//!    should never suggest persisting these, but users paste quickly
//!    and models occasionally cooperate with bad ideas; code-layer
//!    refusal means "remember my API key" reliably fails.
//! 2. **Path whitelist** — only the four editable Brand files are
//!    writable via this command. AGENTS.md is system-managed; anything
//!    else is a bug.

use std::fs;
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::paths;

const WRITABLE_FILES: &[&str] = &["SOUL.md", "USER.md", "TOOLS.md", "MEMORY.md"];

/// Patterns that smell like secrets. Deliberately narrow — we'd rather
/// miss a funky one than false-positive on normal prose. When a hit
/// lands, the write is refused outright; we don't try to redact in
/// place because partial writes feel worse than a hard no.
static SECRET_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    let sources = [
        // OpenAI / Anthropic: sk-ant-... sk-proj-... sk-... (18+ chars after)
        r"\b(sk|pk)-[A-Za-z0-9_\-]{18,}\b",
        // GitHub personal access tokens
        r"\bghp_[A-Za-z0-9]{36,}\b",
        r"\bgithub_pat_[A-Za-z0-9_]{80,}\b",
        // Slack bot / user tokens
        r"\bxox[baprs]-[A-Za-z0-9\-]{10,}\b",
        // Google API keys
        r"\bAIza[0-9A-Za-z_\-]{35}\b",
        // AWS access key ids
        r"\bAKIA[0-9A-Z]{16}\b",
        // Generic 40+ hex secret (SSH, password hashes)
        r"\b[0-9a-f]{40,}\b",
    ];
    sources.iter().map(|s| Regex::new(s).unwrap()).collect()
});

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RememberResult {
    /// True when the write actually landed on disk.
    pub written: bool,
    /// The file (relative to config/) the line was written to.
    pub file: String,
    /// User-facing reason when the write was skipped (secret detected,
    /// empty content, etc.).
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn append_to_memory(
    app: AppHandle,
    file: String,
    content: String,
    section: Option<String>,
) -> Result<RememberResult, String> {
    if !WRITABLE_FILES.contains(&file.as_str()) {
        return Err(format!(
            "{file} is not a writable memory file (allowed: {:?})",
            WRITABLE_FILES
        ));
    }

    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(RememberResult {
            written: false,
            file,
            reason: Some("empty content".into()),
        });
    }

    if contains_secret(trimmed) {
        return Ok(RememberResult {
            written: false,
            file,
            reason: Some(
                "Refused: content looks like a secret (API key / token). \
                 If it's a real credential, store it in Settings → Providers. \
                 If it's a false positive, edit the file by hand."
                    .into(),
            ),
        });
    }

    let dir = paths::config_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    let path = dir.join(&file);

    append_line(&path, trimmed, section.as_deref())?;

    Ok(RememberResult {
        written: true,
        file,
        reason: None,
    })
}

fn contains_secret(s: &str) -> bool {
    SECRET_PATTERNS.iter().any(|re| re.is_match(s))
}

/// Append `line` to `path`, optionally under a `## {section}` heading.
/// Creates the file / section on demand. Idempotent: if the exact line
/// (trimmed) already exists in the file, this is a no-op.
fn append_line(path: &Path, line: &str, section: Option<&str>) -> Result<(), String> {
    let existing = if path.exists() {
        fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?
    } else {
        String::new()
    };

    // Dedup: skip if the line is already in the file verbatim.
    for existing_line in existing.lines() {
        if existing_line.trim() == line {
            return Ok(());
        }
    }

    let bullet = if line.starts_with('-') || line.starts_with('*') {
        line.to_string()
    } else {
        format!("- {line}")
    };

    let new_contents = match section {
        Some(sec) if !sec.is_empty() => inject_under_section(&existing, sec, &bullet),
        _ => {
            let mut buf = existing.clone();
            if !buf.is_empty() && !buf.ends_with('\n') {
                buf.push('\n');
            }
            if !buf.is_empty() && !buf.ends_with("\n\n") {
                buf.push('\n');
            }
            buf.push_str(&bullet);
            buf.push('\n');
            buf
        }
    };

    fs::write(path, new_contents).map_err(|e| format!("write {}: {e}", path.display()))
}

fn inject_under_section(existing: &str, section: &str, bullet: &str) -> String {
    let heading = format!("## {section}");
    if let Some(idx) = existing.find(&heading) {
        // Insert immediately after the heading line. Preserve any
        // existing content underneath.
        let after_heading = idx + heading.len();
        let nl = existing[after_heading..]
            .find('\n')
            .map(|n| after_heading + n + 1)
            .unwrap_or(existing.len());
        let mut out = String::with_capacity(existing.len() + bullet.len() + 8);
        out.push_str(&existing[..nl]);
        out.push_str(bullet);
        out.push('\n');
        out.push_str(&existing[nl..]);
        return out;
    }
    // Section doesn't exist — create it at the end of the file.
    let mut buf = existing.to_string();
    if !buf.is_empty() && !buf.ends_with('\n') {
        buf.push('\n');
    }
    if !buf.is_empty() {
        buf.push('\n');
    }
    buf.push_str(&heading);
    buf.push('\n');
    buf.push_str(bullet);
    buf.push('\n');
    buf
}

#[tauri::command]
pub async fn delete_memory_line(
    app: AppHandle,
    file: String,
    line: String,
) -> Result<bool, String> {
    if !WRITABLE_FILES.contains(&file.as_str()) {
        return Err(format!("{file} is not a writable memory file"));
    }
    let path: PathBuf = paths::config_dir(&app)?.join(&file);
    if !path.exists() {
        return Ok(false);
    }
    let existing =
        fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let target = line.trim();
    let mut removed = false;
    let kept: Vec<&str> = existing
        .lines()
        .filter(|l| {
            if !removed && l.trim() == target {
                removed = true;
                false
            } else {
                true
            }
        })
        .collect();
    if !removed {
        return Ok(false);
    }
    let new_contents = kept.join("\n") + "\n";
    fs::write(&path, new_contents).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_get_blocked() {
        assert!(contains_secret(
            "my key is sk-ant-api03-abc123def456ghi789jkl"
        ));
        assert!(contains_secret(
            "token ghp_1234567890abcdefghijklmnopqrstuvwxyzA1"
        ));
        // Google API key pattern: AIza + exactly 35 chars (39 total).
        assert!(contains_secret("AIzaSyB0123456789abcdefghijklmnopqrstuv"));
        assert!(contains_secret("AKIAIOSFODNN7EXAMPLE"));
        assert!(contains_secret(
            "hash f3b1c2d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0"
        ));
    }

    #[test]
    fn normal_prose_not_flagged() {
        assert!(!contains_secret("用户习惯用 pnpm 而非 npm"));
        assert!(!contains_secret("call me Lionel"));
        assert!(!contains_secret("react hooks order matters"));
    }

    #[test]
    fn appends_bullet_when_section_missing() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("TOOLS.md");
        append_line(&p, "pnpm over npm", None).unwrap();
        let got = fs::read_to_string(&p).unwrap();
        assert!(got.contains("- pnpm over npm"));
    }

    #[test]
    fn dedup_does_not_double_write() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("TOOLS.md");
        append_line(&p, "pnpm over npm", None).unwrap();
        append_line(&p, "- pnpm over npm", None).unwrap();
        let got = fs::read_to_string(&p).unwrap();
        assert_eq!(got.matches("pnpm over npm").count(), 1);
    }

    #[test]
    fn section_heading_created_on_demand() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("USER.md");
        append_line(&p, "姓名: Lionel", Some("身份")).unwrap();
        let got = fs::read_to_string(&p).unwrap();
        assert!(got.contains("## 身份"));
        assert!(got.contains("- 姓名: Lionel"));
    }

    #[test]
    fn section_reused_across_calls() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("USER.md");
        append_line(&p, "时区: CST", Some("身份")).unwrap();
        append_line(&p, "职业: SWE", Some("身份")).unwrap();
        let got = fs::read_to_string(&p).unwrap();
        // Single heading, both bullets present.
        assert_eq!(got.matches("## 身份").count(), 1);
        assert!(got.contains("- 时区: CST"));
        assert!(got.contains("- 职业: SWE"));
    }

    #[test]
    fn delete_removes_single_match_only() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("MEMORY.md");
        fs::write(&p, "- keep me\n- delete me\n- keep me\n").unwrap();
        let ok = tests_support::run_delete(&p, "- delete me");
        assert!(ok);
        let got = fs::read_to_string(&p).unwrap();
        assert_eq!(got.matches("keep me").count(), 2);
        assert!(!got.contains("delete me"));
    }

    // Small helper so we can test the file-level logic without spinning
    // up a Tauri AppHandle. Mirrors the body of `delete_memory_line`.
    mod tests_support {
        use std::fs;
        use std::path::Path;

        pub fn run_delete(path: &Path, line: &str) -> bool {
            let existing = fs::read_to_string(path).unwrap();
            let target = line.trim();
            let mut removed = false;
            let kept: Vec<&str> = existing
                .lines()
                .filter(|l| {
                    if !removed && l.trim() == target {
                        removed = true;
                        false
                    } else {
                        true
                    }
                })
                .collect();
            if !removed {
                return false;
            }
            fs::write(path, kept.join("\n") + "\n").unwrap();
            true
        }
    }
}
