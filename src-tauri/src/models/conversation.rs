use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub model_id: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub title_locked: bool,
    /// Agent operating mode. "chat" (default) | "plan" (readonly) |
    /// "execute" (writes auto-allowed session-wide). Phase C.
    #[serde(default = "default_mode")]
    pub mode: String,
}

fn default_mode() -> String {
    "chat".to_string()
}
