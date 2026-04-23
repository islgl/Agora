//! Conversation search. Matches against title and message bodies (via FTS5);
//! returns matching conversation IDs for sidebar filtering, and per-message
//! snippet results for full-text search.

use serde::Serialize;
use tauri::State;

use crate::db::DbPool;

#[tauri::command]
pub async fn search_conversations(
    pool: State<'_, DbPool>,
    query: String,
) -> Result<Vec<String>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    // Title match — simple LIKE, case-insensitive via LOWER.
    let like = format!("%{}%", trimmed.to_lowercase());
    let mut matched: Vec<String> =
        sqlx::query_scalar("SELECT id FROM conversations WHERE LOWER(title) LIKE ?")
            .bind(&like)
            .fetch_all(&*pool)
            .await
            .map_err(|e| e.to_string())?;

    // Body match — FTS5 with prefix search so "hell" matches "hello".
    let fts_query = escape_fts_query(trimmed);
    let body_matches: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT m.conversation_id FROM messages m \
         JOIN messages_fts fts ON fts.rowid = m.rowid \
         WHERE messages_fts MATCH ?",
    )
    .bind(&fts_query)
    .fetch_all(&*pool)
    .await
    .unwrap_or_default();

    for id in body_matches {
        if !matched.contains(&id) {
            matched.push(id);
        }
    }
    Ok(matched)
}

/// Per-message search result with a snippet showing context around the match.
/// Snippet uses U+0001 / U+0002 as start/end markers so the frontend can
/// highlight matched terms without unsafe HTML injection.
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MessageSearchResult {
    pub message_id: String,
    pub conversation_id: String,
    pub conversation_title: String,
    pub role: String,
    /// Context excerpt with U+0001 before and U+0002 after each matched term.
    pub snippet: String,
    pub created_at: i64,
}

#[tauri::command]
pub async fn search_messages(
    pool: State<'_, DbPool>,
    query: String,
) -> Result<Vec<MessageSearchResult>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let fts_query = escape_fts_query(trimmed);
    sqlx::query_as::<_, MessageSearchResult>(
        "SELECT \
            m.id            AS message_id, \
            m.conversation_id, \
            c.title         AS conversation_title, \
            m.role, \
            snippet(fts, 0, char(1), char(2), '…', 12) AS snippet, \
            m.created_at \
         FROM messages m \
         JOIN messages_fts fts ON fts.rowid = m.rowid \
         JOIN conversations c ON m.conversation_id = c.id \
         WHERE messages_fts MATCH ? \
         ORDER BY fts.rank \
         LIMIT 30",
    )
    .bind(&fts_query)
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())
}

/// Turn a user query into a safe FTS5 MATCH expression. We strip special
/// characters rather than escape them and add a `*` suffix for prefix
/// matching on the last token.
fn escape_fts_query(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c.is_whitespace() || c == '-' || c == '_' {
                c
            } else {
                ' '
            }
        })
        .collect();
    let tokens: Vec<&str> = cleaned.split_whitespace().collect();
    if tokens.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    for (i, t) in tokens.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.push('"');
        out.push_str(t);
        out.push('"');
    }
    out.push('*');
    out
}
