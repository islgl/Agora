#![allow(dead_code)]

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
}

/// Persisted MCP server entry. Stdio uses `command`/`args`/`env`; Http/Sse
/// use `url`/`headers`. The shape intentionally mirrors Claude Desktop's
/// `mcpServers` JSON so existing user configs are portable.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// When true and transport=stdio, the command runs via `$SHELL -lc` so
    /// interactive-shell PATH additions (nvm, pyenv, homebrew) resolve.
    #[serde(default)]
    pub login_shell: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub created_at: i64,
}

fn default_true() -> bool {
    true
}
