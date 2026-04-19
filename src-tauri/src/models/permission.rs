use serde::{Deserialize, Serialize};

/// A single persisted permission rule. `(tool_name, pattern)` is the logical
/// key — empty `pattern` means "apply to every invocation of this tool".
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ToolPermission {
    pub id: String,
    pub tool_name: String,
    pub pattern: String,
    /// "allow" | "deny"
    pub decision: String,
    pub created_at: i64,
}
