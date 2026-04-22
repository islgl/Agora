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
    /// ID of the model selected as "in use" in Settings → Models. Persists
    /// the user's "Use" click so a restart lands on the same model instead of
    /// falling back to the first config in the list. Empty = never set.
    #[serde(default)]
    pub active_model_id: String,
    /// Embedding provider of the *active* embedding config. Kept alongside
    /// `embedding_configs_json` so existing Rust code + older callers that
    /// only read these two fields still work. Always mirrors the active
    /// entry in the JSON blob when the frontend writes it.
    #[serde(default = "default_embedding_provider")]
    pub embedding_provider: String,
    /// Embedding model id of the active embedding config (e.g.
    /// `text-embedding-3-small`). Kept in sync with the active entry in
    /// `embedding_configs_json`.
    #[serde(default = "default_embedding_model")]
    pub embedding_model: String,
    /// JSON blob owning the embedding-config list + active id. Shape:
    /// `{"configs":[{"id","name","provider","model"}],"activeId":"…"}`.
    /// Frontend owns the schema; Rust treats this as opaque text. Seeded
    /// lazily by the frontend from the legacy `embedding_provider` /
    /// `embedding_model` fields on first load.
    #[serde(default = "default_embedding_configs_json")]
    pub embedding_configs_json: String,
    /// Shared endpoint for all embedding traffic. Empty = fall through to
    /// the chat `base_url_openai`. Downstream routing inside the gateway
    /// happens via each embedding config's `providerId` header, not a
    /// per-provider URL override.
    #[serde(default)]
    pub base_url_embedding_common: String,
    /// When true, the post-turn memory extractor runs.
    #[serde(default = "default_true")]
    pub auto_memory_enabled: bool,
    /// When true, pressing Option twice quickly should surface the app and
    /// start a fresh conversation in the background.
    #[serde(default = "default_true")]
    pub quick_launch_enabled: bool,
}

fn default_embedding_provider() -> String {
    "openai".to_string()
}

fn default_embedding_model() -> String {
    "text-embedding-3-small".to_string()
}

fn default_embedding_configs_json() -> String {
    "{}".to_string()
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
