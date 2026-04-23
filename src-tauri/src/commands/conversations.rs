use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;
use crate::models::Conversation;

#[tauri::command]
pub async fn load_conversations(pool: State<'_, DbPool>) -> Result<Vec<Conversation>, String> {
    sqlx::query_as::<_, Conversation>(
        "SELECT id, title, created_at, model_id, pinned, title_locked, mode \
         FROM conversations \
         ORDER BY pinned DESC, created_at DESC",
    )
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_conversation(
    pool: State<'_, DbPool>,
    title: String,
    model_id: String,
) -> Result<Conversation, String> {
    let conversation = Conversation {
        id: Uuid::new_v4().to_string(),
        title,
        created_at: now_millis(),
        model_id,
        pinned: false,
        title_locked: false,
        mode: "chat".into(),
    };

    sqlx::query(
        "INSERT INTO conversations (id, title, created_at, model_id, pinned, title_locked, mode) \
         VALUES (?, ?, ?, ?, 0, 0, 'chat')",
    )
    .bind(&conversation.id)
    .bind(&conversation.title)
    .bind(conversation.created_at)
    .bind(&conversation.model_id)
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(conversation)
}

/// Flip the conversation between `chat` / `plan` / `execute`. The frontend
/// derives tool visibility + auto-approval from this flag, so enforcement
/// still lives over there — this is purely persistence.
#[tauri::command]
pub async fn set_conversation_mode(
    pool: State<'_, DbPool>,
    id: String,
    mode: String,
) -> Result<(), String> {
    if !matches!(mode.as_str(), "chat" | "plan" | "execute") {
        return Err(format!("invalid mode `{}`", mode));
    }
    sqlx::query("UPDATE conversations SET mode = ? WHERE id = ?")
        .bind(&mode)
        .bind(&id)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_conversation(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    // ON DELETE CASCADE on messages handles message cleanup.
    sqlx::query("DELETE FROM conversations WHERE id = ?")
        .bind(&id)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Renaming by the user locks the title so auto-summarization won't overwrite.
#[tauri::command]
pub async fn rename_conversation(
    pool: State<'_, DbPool>,
    id: String,
    title: String,
) -> Result<(), String> {
    sqlx::query("UPDATE conversations SET title = ?, title_locked = 1 WHERE id = ?")
        .bind(&title)
        .bind(&id)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Internal auto-title update — does NOT flip `title_locked`.
#[tauri::command]
pub async fn update_conversation_title_auto(
    pool: State<'_, DbPool>,
    id: String,
    title: String,
) -> Result<(), String> {
    // Double-check the lock at write time in case the user renamed while a
    // background summarization was in flight.
    sqlx::query("UPDATE conversations SET title = ? WHERE id = ? AND title_locked = 0")
        .bind(&title)
        .bind(&id)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_conversation_pinned(
    pool: State<'_, DbPool>,
    id: String,
    pinned: bool,
) -> Result<(), String> {
    sqlx::query("UPDATE conversations SET pinned = ? WHERE id = ?")
        .bind(pinned)
        .bind(&id)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
