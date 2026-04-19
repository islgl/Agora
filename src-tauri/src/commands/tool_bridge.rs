//! Bridge that lets the Vercel AI SDK (webview) discover and invoke tools
//! whose runtime lives in Rust — MCP servers (rmcp) and Skill built-ins.
//!
//! We don't reimplement MCP / Skills in JS. The SDK gets tool *descriptors*
//! and delegates `execute()` back here.

use serde::Serialize;
use serde_json::Value;
use tauri::State;
use uuid::Uuid;

use crate::state::RuntimeHandles;
use crate::tools::{BuiltinKind, ToolCall, ToolSpec};

#[tauri::command]
pub async fn list_frontend_tools(
    handles: State<'_, RuntimeHandles>,
) -> Result<Vec<ToolSpec>, String> {
    let mut tools: Vec<ToolSpec> = Vec::new();
    // Order: built-ins first (they're the agent's default toolbelt), then
    // Skills, then MCP. The frontend renders in list order.
    tools.extend(handles.builtins.list_tools().await);
    tools.extend(handles.skills.list_tools().await);
    tools.extend(handles.mcp.list_tools().await);
    Ok(tools)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInvocationResult {
    pub content: String,
    pub is_error: bool,
}

#[tauri::command]
pub async fn invoke_tool(
    handles: State<'_, RuntimeHandles>,
    name: String,
    input: Value,
) -> Result<ToolInvocationResult, String> {
    let call = ToolCall {
        id: Uuid::new_v4().to_string(),
        name: name.clone(),
        input,
    };

    let result = if name.starts_with("mcp__") {
        handles.mcp.invoke(&call).await
    } else if matches!(
        name.as_str(),
        "read_skill" | "read_skill_file" | "run_skill_script"
    ) {
        handles.skills.invoke(&call).await
    } else if BuiltinKind::from_tool_name(&name).is_some() {
        handles.builtins.invoke(&call).await
    } else {
        return Err(format!("unknown tool: {}", name));
    };

    Ok(ToolInvocationResult {
        content: result.content,
        is_error: result.is_error,
    })
}
