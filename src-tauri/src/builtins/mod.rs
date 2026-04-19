//! First-class agent tools (FS, Bash, …) that ship with the app. Unlike MCP
//! or Skill tools, these don't need an external process or manifest — they're
//! implemented directly in Rust and dispatched by name from `invoke_tool`.

mod bash;
mod fs;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use tokio::sync::RwLock;

use crate::tools::{BuiltinKind, ToolCall, ToolResult, ToolSource, ToolSpec};

use self::bash::BackgroundStore;

pub type SharedBuiltinsRuntime = Arc<BuiltinsRuntime>;

/// Shared runtime holding the agent's workspace context + any per-session
/// state the built-ins need (background tasks, caches). Populated at app
/// startup from `global_settings.workspace_root`.
pub struct BuiltinsRuntime {
    workspace_root: RwLock<Option<PathBuf>>,
    /// Registry of live `bash_background` invocations keyed by task_id.
    background_tasks: BackgroundStore,
}

impl BuiltinsRuntime {
    pub fn new() -> SharedBuiltinsRuntime {
        Arc::new(Self {
            workspace_root: RwLock::new(None),
            background_tasks: RwLock::new(HashMap::new()),
        })
    }

    pub async fn set_workspace_root(&self, root: Option<PathBuf>) {
        *self.workspace_root.write().await = root;
    }

    pub async fn workspace_root(&self) -> Option<PathBuf> {
        self.workspace_root.read().await.clone()
    }

    /// Announce every built-in tool to the frontend. Order matters for UI
    /// grouping but not for dispatch.
    pub async fn list_tools(&self) -> Vec<ToolSpec> {
        use BuiltinKind::*;
        let kinds = [
            ReadFile,
            WriteFile,
            EditFile,
            Glob,
            Grep,
            Bash,
            BashBackground,
            ReadTaskOutput,
            StopTask,
        ];
        kinds.iter().map(|k| tool_spec(*k)).collect()
    }

    /// Route a call to the right module. The permission check lives outside
    /// this function — by the time we get here the frontend has already
    /// confirmed the user allows this invocation.
    pub async fn invoke(&self, call: &ToolCall) -> ToolResult {
        let Some(kind) = BuiltinKind::from_tool_name(&call.name) else {
            return ToolResult::err(
                &call.id,
                format!("not a built-in tool: {}", call.name),
            );
        };

        let root = self.workspace_root().await;
        let root_ref = root.as_deref();
        let outcome: Result<String, String> = match kind {
            BuiltinKind::ReadFile => fs::read_file(&call.input, root_ref).await,
            BuiltinKind::Glob => fs::glob(&call.input, root_ref).await,
            BuiltinKind::Grep => fs::grep(&call.input, root_ref).await,
            BuiltinKind::WriteFile => fs::write_file(&call.input, root_ref).await,
            BuiltinKind::EditFile => fs::edit_file(&call.input, root_ref).await,
            BuiltinKind::Bash => bash::bash(&call.input, root_ref).await,
            BuiltinKind::BashBackground => {
                bash::bash_background(&call.input, root_ref, &self.background_tasks).await
            }
            BuiltinKind::ReadTaskOutput => {
                bash::read_task_output(&call.input, &self.background_tasks).await
            }
            BuiltinKind::StopTask => {
                bash::stop_task(&call.input, &self.background_tasks).await
            }
        };

        match outcome {
            Ok(content) => ToolResult::ok(&call.id, content),
            Err(msg) => ToolResult::err(&call.id, msg),
        }
    }
}

/// Static tool descriptors. Descriptions are written for the model's eyes —
/// each should make it obvious when the tool is the right choice.
fn tool_spec(kind: BuiltinKind) -> ToolSpec {
    let (description, input_schema) = match kind {
        BuiltinKind::ReadFile => (
            "Read a text file from the workspace. Returns the file contents \
             prefixed with line numbers so you can reference lines for edits. \
             Large files are truncated — pass `offset` + `limit` to page through.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute or workspace-relative path." },
                    "offset": { "type": "integer", "minimum": 0, "description": "First line (0-indexed)." },
                    "limit": { "type": "integer", "minimum": 1, "description": "Max lines to return." }
                },
                "required": ["path"]
            }),
        ),
        BuiltinKind::WriteFile => (
            "Create or overwrite a file with the given contents. Creates parent \
             directories as needed. Requires user approval on first use.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"]
            }),
        ),
        BuiltinKind::EditFile => (
            "Replace an exact string in a file. `old_string` must occur exactly \
             once unless `replace_all` is true. Requires user approval.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "old_string": { "type": "string" },
                    "new_string": { "type": "string" },
                    "replace_all": { "type": "boolean", "default": false }
                },
                "required": ["path", "old_string", "new_string"]
            }),
        ),
        BuiltinKind::Glob => (
            "Find files by glob pattern (e.g. `src/**/*.ts`). Honors `.gitignore`. \
             Returns matching paths sorted by modification time.",
            json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string" },
                    "path": { "type": "string", "description": "Directory to search in. Defaults to workspace root." }
                },
                "required": ["pattern"]
            }),
        ),
        BuiltinKind::Grep => (
            "Search file contents with a regex. Honors `.gitignore`. Prefer this \
             over `bash grep` — it's faster and scoped to the workspace.",
            json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Regex pattern." },
                    "path": { "type": "string" },
                    "glob": { "type": "string", "description": "Limit to files matching this glob." },
                    "output_mode": {
                        "type": "string",
                        "enum": ["files_with_matches", "content", "count"],
                        "default": "files_with_matches"
                    },
                    "case_insensitive": { "type": "boolean", "default": false },
                    "line_numbers": { "type": "boolean", "default": true },
                    "head_limit": { "type": "integer", "minimum": 1, "default": 250 }
                },
                "required": ["pattern"]
            }),
        ),
        BuiltinKind::Bash => (
            "Run a shell command in the workspace. Blocks until the command \
             exits or a timeout fires. Requires user approval for commands \
             without a matching allowlist rule. Avoid interactive programs.",
            json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "timeout_ms": { "type": "integer", "minimum": 1, "default": 120000 },
                    "cwd": { "type": "string", "description": "Defaults to the workspace root." }
                },
                "required": ["command"]
            }),
        ),
        BuiltinKind::BashBackground => (
            "Run a shell command in the background. Returns a `task_id` you can \
             poll via `read_task_output` or cancel via `stop_task`. Use for \
             long-running jobs (builds, servers).",
            json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "cwd": { "type": "string" }
                },
                "required": ["command"]
            }),
        ),
        BuiltinKind::ReadTaskOutput => (
            "Fetch accumulated stdout/stderr for a background task, plus its \
             current status (running / exited / killed).",
            json!({
                "type": "object",
                "properties": { "task_id": { "type": "string" } },
                "required": ["task_id"]
            }),
        ),
        BuiltinKind::StopTask => (
            "Terminate a background task started via `bash_background`. \
             Sends SIGTERM, escalates to SIGKILL if it doesn't exit within 5s.",
            json!({
                "type": "object",
                "properties": { "task_id": { "type": "string" } },
                "required": ["task_id"]
            }),
        ),
    };

    ToolSpec {
        name: kind.tool_name().to_string(),
        description: description.to_string(),
        input_schema,
        source: ToolSource::Builtin { kind },
    }
}
