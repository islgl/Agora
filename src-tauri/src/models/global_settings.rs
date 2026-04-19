use serde::{Deserialize, Serialize};

/// Single-row table holding provider endpoints, shared API key, feature
/// capability toggles, and app-wide preferences.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettings {
    pub api_key: String,
    pub base_url_openai: String,
    pub base_url_anthropic: String,
    pub base_url_gemini: String,
    #[serde(default)]
    pub tavily_api_key: String,
    #[serde(default = "default_true")]
    pub web_search_enabled: bool,
    /// "off" | "first" | "every"
    #[serde(default = "default_auto_title_mode")]
    pub auto_title_mode: String,
    /// Extended-thinking effort: `"off" | "low" | "medium" | "high" | "max"`.
    /// Mapped to each provider's native parameter by the provider code;
    /// requests to models that don't support thinking are silently retried
    /// without the parameter.
    #[serde(default = "default_thinking_effort")]
    pub thinking_effort: String,
    /// Absolute path the agent's FS/Bash tools resolve relative paths against.
    /// Empty = no workspace configured; relative paths from the model will
    /// error out until the user sets one in Settings.
    #[serde(default)]
    pub workspace_root: String,
    /// When true, read-only built-ins (`read_file`, `glob`, `grep`,
    /// `read_task_output`) skip the approval prompt.
    #[serde(default = "default_true")]
    pub auto_approve_readonly: bool,
    /// JSON blob of hook config. Structure: `{ preToolUse?: [...],
    /// postToolUse?: [...] }`. Kept as a string so the frontend owns the
    /// schema and Rust doesn't need to re-derive it on every settings write.
    #[serde(default = "default_hooks_json")]
    pub hooks_json: String,
}

fn default_true() -> bool {
    true
}

fn default_auto_title_mode() -> String {
    "every".to_string()
}

fn default_thinking_effort() -> String {
    "off".to_string()
}

fn default_hooks_json() -> String {
    "{}".to_string()
}
