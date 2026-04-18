#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Provider-agnostic description of a callable tool exposed to the LLM.
///
/// `name` is the fully-qualified id we expose to the model (e.g.
/// `mcp__filesystem__read_file` or `skill_read`). `source` lets the
/// `ToolInvoker` route calls back to the right runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema draft 2020-12. Provider adapters may sanitize before use.
    pub input_schema: Value,
    pub source: ToolSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolSource {
    Mcp {
        server_id: String,
        original_name: String,
    },
    SkillBuiltin {
        kind: SkillBuiltinKind,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillBuiltinKind {
    ReadSkill,
    ReadSkillFile,
    RunSkillScript,
}

/// A call the model wants to make. `id` is whatever the provider handed us
/// so we can echo it back on the follow-up turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub call_id: String,
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
}

impl ToolResult {
    pub fn ok(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            call_id: call_id.into(),
            content: content.into(),
            is_error: false,
        }
    }

    pub fn err(call_id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            call_id: call_id.into(),
            content: message.into(),
            is_error: true,
        }
    }
}
