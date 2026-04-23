//! Tauri command surface for the auto-memory vector store.
//!
//! Thin wrappers over `memory_auto::MemoryStore`. Embeddings are
//! computed frontend-side via the AI SDK (reusing the same proxy
//! fetch path as chat) and handed in as `f32` arrays.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::memory_auto::{MemoryRow, NewMemory};
use crate::state::RuntimeHandles;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMemoryArgs {
    pub text: String,
    pub kind: String,
    pub vector: Vec<f32>,
    pub source_conversation_id: Option<String>,
    pub source_message_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchMemoryArgs {
    pub vector: Vec<f32>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub rows: Vec<MemoryRow>,
}

#[tauri::command]
pub async fn add_auto_memory(
    handles: State<'_, RuntimeHandles>,
    args: AddMemoryArgs,
) -> Result<MemoryRow, String> {
    handles
        .memory
        .add(NewMemory {
            text: args.text,
            kind: args.kind,
            vector: args.vector,
            source_conversation_id: args.source_conversation_id,
            source_message_id: args.source_message_id,
        })
        .await
}

#[tauri::command]
pub async fn search_auto_memory(
    handles: State<'_, RuntimeHandles>,
    args: SearchMemoryArgs,
) -> Result<SearchResult, String> {
    let rows = handles
        .memory
        .search(args.vector, args.limit.unwrap_or(5))
        .await?;
    Ok(SearchResult { rows })
}

#[tauri::command]
pub async fn list_auto_memory(
    handles: State<'_, RuntimeHandles>,
    limit: Option<usize>,
) -> Result<Vec<MemoryRow>, String> {
    handles.memory.list(limit.unwrap_or(200)).await
}

#[tauri::command]
pub async fn delete_auto_memory(
    handles: State<'_, RuntimeHandles>,
    id: String,
) -> Result<bool, String> {
    handles.memory.delete(&id).await
}

#[tauri::command]
pub async fn clear_auto_memory(handles: State<'_, RuntimeHandles>) -> Result<u64, String> {
    handles.memory.clear().await
}
