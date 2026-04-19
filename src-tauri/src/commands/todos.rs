//! Conversation-scoped todo list storage (Phase B · TodoWrite).
//!
//! The model drives its own plan via a frontend-synthesized `todo_write`
//! tool. The frontend calls these commands to persist the latest list so
//! it survives app restarts. Semantics match Claude Code's TodoWrite:
//! a full replace-in-place on every update.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::DbPool;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub content: String,
    /// 'pending' | 'in_progress' | 'completed' | 'blocked'
    pub status: String,
    /// Present-continuous label for the status spinner, e.g. "Running tests".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
}

#[tauri::command]
pub async fn get_todos(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> Result<Vec<Todo>, String> {
    let row: Option<String> = sqlx::query_scalar(
        "SELECT todos_json FROM conversation_todos WHERE conversation_id = ?",
    )
    .bind(&conversation_id)
    .fetch_optional(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    let Some(json) = row else { return Ok(Vec::new()); };
    serde_json::from_str::<Vec<Todo>>(&json).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_todos(
    pool: State<'_, DbPool>,
    conversation_id: String,
    todos: Vec<Todo>,
) -> Result<Vec<Todo>, String> {
    if conversation_id.trim().is_empty() {
        return Err("conversation_id is required".into());
    }
    for t in &todos {
        if !matches!(
            t.status.as_str(),
            "pending" | "in_progress" | "completed" | "blocked"
        ) {
            return Err(format!("invalid status `{}`", t.status));
        }
    }

    let json = serde_json::to_string(&todos).map_err(|e| e.to_string())?;
    let updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    sqlx::query(
        "INSERT INTO conversation_todos (conversation_id, todos_json, updated_at) \
         VALUES (?,?,?) \
         ON CONFLICT(conversation_id) DO UPDATE SET \
             todos_json = excluded.todos_json, \
             updated_at = excluded.updated_at",
    )
    .bind(&conversation_id)
    .bind(&json)
    .bind(updated_at)
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(todos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn todo_serializes_active_form_optional() {
        let t = Todo {
            id: "1".into(),
            content: "Write the thing".into(),
            status: "pending".into(),
            active_form: None,
        };
        let j = serde_json::to_string(&t).unwrap();
        assert!(!j.contains("activeForm"), "None → field omitted");

        let t2 = Todo {
            id: "2".into(),
            content: "Run tests".into(),
            status: "in_progress".into(),
            active_form: Some("Running tests".into()),
        };
        let j2 = serde_json::to_string(&t2).unwrap();
        assert!(j2.contains("\"activeForm\":\"Running tests\""));
    }

    #[test]
    fn todo_camel_case_roundtrip() {
        let payload = r#"{"id":"1","content":"x","status":"pending","activeForm":"Doing x"}"#;
        let t: Todo = serde_json::from_str(payload).unwrap();
        assert_eq!(t.active_form.as_deref(), Some("Doing x"));
    }
}
