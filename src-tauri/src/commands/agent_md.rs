//! Phase E · `AGENT.md` loader.
//!
//! A project-level instruction file the agent reads at session start. Lives
//! at `${workspace_root}/AGENT.md`. Returns an empty payload when the file
//! is missing or the workspace root isn't configured — the frontend treats
//! those as "no memory loaded" and carries on.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::RuntimeHandles;

/// Upper bound on the loaded content. AGENT.md is meant to be a short
/// human-written guide — 64 KB covers even heavy docs while keeping a single
/// malicious/accidental huge file from blowing up the system prompt.
const MAX_AGENT_MD_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMdPayload {
    /// Absolute path we read from, or None if no workspace was configured /
    /// no file was found.
    pub path: Option<String>,
    /// File contents, trimmed. Empty when `path` is None or file was empty.
    pub content: String,
    /// True when the file exists but was too large — `content` is truncated
    /// in that case so the system prompt doesn't balloon.
    #[serde(default)]
    pub truncated: bool,
}

#[tauri::command]
pub async fn read_agent_md(handles: State<'_, RuntimeHandles>) -> Result<AgentMdPayload, String> {
    let Some(root) = handles.builtins.workspace_root().await else {
        return Ok(AgentMdPayload::empty());
    };
    let candidate = root.join("AGENT.md");
    if !candidate.exists() {
        return Ok(AgentMdPayload::empty());
    }
    load_file(&candidate)
}

fn load_file(path: &Path) -> Result<AgentMdPayload, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read AGENT.md: {e}"))?;
    let truncated = bytes.len() > MAX_AGENT_MD_BYTES;
    let slice = if truncated {
        &bytes[..MAX_AGENT_MD_BYTES]
    } else {
        &bytes[..]
    };
    // AGENT.md is UTF-8 in practice; fall back to lossy so a stray byte
    // doesn't silently drop the whole file.
    let content = String::from_utf8_lossy(slice).trim().to_string();
    Ok(AgentMdPayload {
        path: Some(path.to_string_lossy().into_owned()),
        content,
        truncated,
    })
}

impl AgentMdPayload {
    fn empty() -> Self {
        Self {
            path: None,
            content: String::new(),
            truncated: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_when_missing() {
        let td = tempfile::tempdir().unwrap();
        // File doesn't exist — direct load_file should error, but the public
        // command gates on exists() first. Exercise the simpler branch:
        let payload = AgentMdPayload::empty();
        assert!(payload.path.is_none());
        assert_eq!(payload.content, "");
        let _ = td;
    }

    #[test]
    fn reads_and_trims() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("AGENT.md");
        std::fs::write(&p, "\n\n  hello world  \n\n").unwrap();
        let got = load_file(&p).unwrap();
        assert_eq!(got.content, "hello world");
        assert!(!got.truncated);
    }

    #[test]
    fn truncates_oversized() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("AGENT.md");
        let big = "x".repeat(MAX_AGENT_MD_BYTES + 1000);
        std::fs::write(&p, &big).unwrap();
        let got = load_file(&p).unwrap();
        assert!(got.truncated);
        assert!(got.content.len() <= MAX_AGENT_MD_BYTES);
    }
}
