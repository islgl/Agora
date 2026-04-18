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
