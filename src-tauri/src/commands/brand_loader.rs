//! Brand Layer loader.
//!
//! Five markdown files under `~/.agora/config/` carry the agent's identity:
//!
//! | File       | Role                                                 | User-editable |
//! |------------|------------------------------------------------------|---------------|
//! | SOUL.md    | Personality, tone, communication style               | yes           |
//! | USER.md    | Who the user is (name, timezone, role, context)      | yes           |
//! | TOOLS.md   | Tech/tooling preferences                             | yes           |
//! | MEMORY.md  | Active memory — LLM appends on remember-intent turns | yes           |
//! | AGENTS.md  | System safety guardrails                             | read-only     |
//!
//! All five are injected into the system prompt on every turn. Missing files
//! return an empty payload (so a fresh install doesn't crash); `ensure_defaults`
//! seeds SOUL.md and AGENTS.md with a sensible default on first run.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::paths;
use crate::state::RuntimeHandles;

const MAX_BYTES: usize = 64 * 1024;

pub const BRAND_FILES: &[&str] = &["SOUL.md", "USER.md", "TOOLS.md", "MEMORY.md", "AGENTS.md"];

const DEFAULT_SOUL_MD: &str = include_str!("../../templates/SOUL.md");
const DEFAULT_AGENTS_MD: &str = include_str!("../../templates/AGENTS.md");

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrandSection {
    pub path: Option<String>,
    pub content: String,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrandPayload {
    pub soul: BrandSection,
    pub user: BrandSection,
    pub tools: BrandSection,
    pub memory: BrandSection,
    pub agents: BrandSection,
    /// Absolute path to the config directory so the UI can offer an
    /// "Open in Finder" affordance without re-deriving it.
    pub config_dir: String,
}

#[tauri::command]
pub async fn read_brand(app: AppHandle) -> Result<BrandPayload, String> {
    let dir = paths::config_dir(&app)?;
    ensure_defaults(&dir).ok();
    Ok(load_all(&dir))
}

/// Read a single Brand file. Accepts any of the five names — including the
/// read-only `AGENTS.md` for viewing. `write_brand_file` is the write side
/// and still refuses AGENTS.md.
#[tauri::command]
pub async fn read_brand_file(app: AppHandle, file: String) -> Result<BrandSection, String> {
    if !BRAND_FILES.contains(&file.as_str()) {
        return Err(format!("unknown brand file: {file}"));
    }
    let dir = paths::config_dir(&app)?;
    ensure_defaults(&dir).ok();
    Ok(load_file(&dir.join(&file)))
}

/// Write one of the user-editable files (everything except AGENTS.md).
/// The command refuses AGENTS.md outright — that file is system-managed; if
/// a user really wants to hand-edit it they can do so on disk. Keeping the
/// UI read-only avoids accidental deletion of the safety rules.
#[tauri::command]
pub async fn write_brand_file(app: AppHandle, file: String, content: String) -> Result<(), String> {
    if !BRAND_FILES.contains(&file.as_str()) {
        return Err(format!("unknown brand file: {file}"));
    }
    if file == "AGENTS.md" {
        return Err("AGENTS.md is managed by the app and is not user-editable".into());
    }
    let dir = paths::config_dir(&app)?;
    let path = dir.join(&file);
    fs::write(&path, content).map_err(|e| format!("write {file}: {e}"))
}

/// Return a workspace-relative-looking absolute path for the config dir
/// so the frontend can hand it to `plugin-opener` (Open in Finder).
#[tauri::command]
pub async fn get_config_dir(
    handles: State<'_, RuntimeHandles>,
    app: AppHandle,
) -> Result<String, String> {
    let _ = handles; // keep signature symmetric with other loaders
    let dir = paths::config_dir(&app)?;
    Ok(dir.to_string_lossy().into_owned())
}

fn load_all(dir: &Path) -> BrandPayload {
    BrandPayload {
        soul: load_file(&dir.join("SOUL.md")),
        user: load_file(&dir.join("USER.md")),
        tools: load_file(&dir.join("TOOLS.md")),
        memory: load_file(&dir.join("MEMORY.md")),
        agents: load_file(&dir.join("AGENTS.md")),
        config_dir: dir.to_string_lossy().into_owned(),
    }
}

fn load_file(path: &Path) -> BrandSection {
    if !path.exists() {
        return BrandSection::default();
    }
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return BrandSection::default(),
    };
    let truncated = bytes.len() > MAX_BYTES;
    let slice = if truncated {
        &bytes[..MAX_BYTES]
    } else {
        &bytes[..]
    };
    let content = String::from_utf8_lossy(slice).trim().to_string();
    BrandSection {
        path: Some(path.to_string_lossy().into_owned()),
        content,
        truncated,
    }
}

/// Seed SOUL.md + AGENTS.md on first run. User-owned files (USER.md,
/// TOOLS.md, MEMORY.md) are left empty so a bare install doesn't pretend
/// to know the user — those are filled via the onboarding flow or by the
/// `remember` tool at runtime.
pub fn ensure_defaults(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create config dir: {e}"))?;
    write_if_missing(&dir.join("SOUL.md"), DEFAULT_SOUL_MD)?;
    write_if_missing(&dir.join("AGENTS.md"), DEFAULT_AGENTS_MD)?;
    Ok(())
}

fn write_if_missing(path: &PathBuf, content: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    fs::write(path, content).map_err(|e| format!("seed {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_payload_on_missing_dir() {
        let td = tempfile::tempdir().unwrap();
        let missing = td.path().join("does-not-exist");
        let payload = load_all(&missing);
        assert!(payload.soul.path.is_none());
        assert_eq!(payload.soul.content, "");
    }

    #[test]
    fn defaults_seed_only_system_files() {
        let td = tempfile::tempdir().unwrap();
        ensure_defaults(td.path()).unwrap();
        assert!(td.path().join("SOUL.md").exists());
        assert!(td.path().join("AGENTS.md").exists());
        // User-owned files stay absent until the user/LLM writes to them.
        assert!(!td.path().join("USER.md").exists());
        assert!(!td.path().join("TOOLS.md").exists());
        assert!(!td.path().join("MEMORY.md").exists());
    }

    #[test]
    fn defaults_not_overwritten_on_second_call() {
        let td = tempfile::tempdir().unwrap();
        fs::write(td.path().join("SOUL.md"), "user-edited SOUL").unwrap();
        ensure_defaults(td.path()).unwrap();
        let contents = fs::read_to_string(td.path().join("SOUL.md")).unwrap();
        assert_eq!(contents, "user-edited SOUL");
    }

    #[test]
    fn truncates_oversized_files() {
        let td = tempfile::tempdir().unwrap();
        let big = "x".repeat(MAX_BYTES + 1000);
        fs::write(td.path().join("MEMORY.md"), &big).unwrap();
        let got = load_file(&td.path().join("MEMORY.md"));
        assert!(got.truncated);
        assert!(got.content.len() <= MAX_BYTES);
    }

    #[test]
    fn loads_all_five_files() {
        let td = tempfile::tempdir().unwrap();
        for (name, body) in &[
            ("SOUL.md", "soul body"),
            ("USER.md", "user body"),
            ("TOOLS.md", "tools body"),
            ("MEMORY.md", "memory body"),
            ("AGENTS.md", "agents body"),
        ] {
            fs::write(td.path().join(name), body).unwrap();
        }
        let payload = load_all(td.path());
        assert_eq!(payload.soul.content, "soul body");
        assert_eq!(payload.user.content, "user body");
        assert_eq!(payload.tools.content, "tools body");
        assert_eq!(payload.memory.content, "memory body");
        assert_eq!(payload.agents.content, "agents body");
    }
}
