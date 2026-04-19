use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    System,
}

/// A structured part of a message — text, a tool call the assistant made, or a
/// tool result fed back in. For turns without any tool activity, the top-level
/// `content` field is sufficient and `parts` stays `None`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MessagePart {
    Text {
        text: String,
    },
    /// Claude extended-thinking / OpenAI o-series reasoning. Rendered in a
    /// collapsible block above the main answer; NOT included in the provider
    /// request on follow-up turns (model generates fresh reasoning each time).
    Thinking {
        text: String,
    },
    /// Image attached to a user message. `data_url` is a full
    /// `data:<mime>;base64,...` URL so the SQLite round-trip is just a
    /// string; the separate `mime_type` is kept for provider conversion
    /// without re-parsing the URL.
    Image {
        #[serde(rename = "dataUrl")]
        data_url: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
    ToolCall {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        call_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
    /// Boundary marker emitted at the start of each streamText step. Used by
    /// the Plan renderer to group subsequent Thinking / ToolCall entries into
    /// per-step tasks. No payload beyond an id so React has a stable key.
    StepStart {
        id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub role: Role,
    pub content: String,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<MessagePart>>,
    /// Display name of the model that produced an assistant message. Null for
    /// user/system messages and for pre-existing messages written before this
    /// column was added.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    /// Prompt tokens consumed by the assistant turn (null when not reported).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u32>,
    /// Completion tokens produced by the assistant turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u32>,
    /// True when the user requested extended thinking but the target model
    /// didn't support it — UI surfaces a hint so the user isn't confused
    /// by the absence of a thinking block.
    #[serde(default, skip_serializing_if = "is_false")]
    pub thinking_skipped: bool,
    /// 0-based position among siblings sharing the same `parent_id` and role,
    /// ordered by `created_at`. Computed on load; never stored.
    #[serde(default)]
    pub sibling_index: u32,
    /// Total sibling count (including self). `1` means no alternatives.
    #[serde(default = "one")]
    pub sibling_count: u32,
    /// Message id of the immediate previous sibling (same parent + role), or
    /// None at the left edge. Used for `‹` navigation.
    #[serde(default)]
    pub prev_sibling_id: Option<String>,
    /// Message id of the immediate next sibling, or None at the right edge.
    #[serde(default)]
    pub next_sibling_id: Option<String>,
}

fn one() -> u32 {
    1
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Raw DB row. Sibling counters are populated by the load query, not the row
/// itself, so they default to 0/1.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MessageRow {
    pub id: String,
    pub conversation_id: String,
    pub parent_id: Option<String>,
    pub role: Role,
    pub content: String,
    pub created_at: i64,
    pub parts_json: Option<String>,
    pub model_name: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub thinking_skipped: bool,
}

impl MessageRow {
    pub fn into_message(self) -> Message {
        let parts = self
            .parts_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<MessagePart>>(s).ok());
        Message {
            id: self.id,
            conversation_id: self.conversation_id,
            parent_id: self.parent_id,
            role: self.role,
            content: self.content,
            created_at: self.created_at,
            parts,
            model_name: self.model_name,
            input_tokens: self.input_tokens.map(|v| v.max(0) as u32),
            output_tokens: self.output_tokens.map(|v| v.max(0) as u32),
            thinking_skipped: self.thinking_skipped,
            sibling_index: 0,
            sibling_count: 1,
            prev_sibling_id: None,
            next_sibling_id: None,
        }
    }
}
