//! Conversation search. Matches against title and message bodies (via FTS5);
//! returns the matching conversation IDs so the sidebar can filter.

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
