use std::collections::HashMap;

use tauri::State;

use crate::db::DbPool;
use crate::models::{Message, MessageRow};

/// Loads the currently-active branch of a conversation: root → active_leaf,
/// each message annotated with `sibling_index` / `sibling_count` so the UI can
/// render `‹ k/N ›` navigators.
#[tauri::command]
pub async fn load_messages(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> Result<Vec<Message>, String> {
    let leaf_opt: Option<String> =
        sqlx::query_scalar("SELECT active_leaf_id FROM conversations WHERE id = ?")
            .bind(&conversation_id)
            .fetch_optional(&*pool)
            .await
            .map_err(|e| e.to_string())?
            .flatten();

    // Fetch every row for the conversation in one go — we need both the active
    // path and the sibling metadata, and a single pass is simpler than many.
    let all_rows: Vec<MessageRow> = sqlx::query_as::<_, MessageRow>(
        "SELECT id, conversation_id, parent_id, role, content, created_at, parts_json, \
                model_name, input_tokens, output_tokens, thinking_skipped \
         FROM messages \
         WHERE conversation_id = ? \
         ORDER BY created_at ASC",
    )
    .bind(&conversation_id)
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    if all_rows.is_empty() {
        return Ok(Vec::new());
    }

    // Build lookups used for active-path walk and sibling annotation.
    let by_id: HashMap<String, &MessageRow> = all_rows.iter().map(|r| (r.id.clone(), r)).collect();

    // Determine the leaf to walk up from. If the conversation doesn't have an
    // explicit `active_leaf_id` (old DB, pre-backfill corner case), fall back
    // to the most-recent-created message.
    let leaf_id = leaf_opt
        .filter(|id| by_id.contains_key(id))
        .or_else(|| all_rows.last().map(|r| r.id.clone()));
    let Some(leaf_id) = leaf_id else {
        return Ok(Vec::new());
    };

    // Walk leaf → root. Guard against pathological cycles with a hard cap.
    let mut path_ids: Vec<String> = Vec::new();
    let mut cursor = Some(leaf_id);
    let cap = all_rows.len() + 1;
    while let Some(id) = cursor.take() {
        if path_ids.len() > cap {
            return Err("message tree contains a cycle".into());
        }
        match by_id.get(&id) {
            Some(row) => {
                let next = row.parent_id.clone();
                path_ids.push(id);
                cursor = next;
            }
            None => break,
        }
    }
    path_ids.reverse();

    // Precompute sibling buckets: (parent_id, role) → ordered list of ids.
    let mut buckets: HashMap<(Option<String>, String), Vec<(String, i64)>> = HashMap::new();
    for r in &all_rows {
        let key = (r.parent_id.clone(), format!("{:?}", r.role));
        buckets
            .entry(key)
            .or_default()
            .push((r.id.clone(), r.created_at));
    }
    for v in buckets.values_mut() {
        v.sort_by_key(|(_, ts)| *ts);
    }

    // Emit messages along the active path with sibling annotations.
    let mut out: Vec<Message> = Vec::with_capacity(path_ids.len());
    for id in &path_ids {
        let Some(row) = by_id.get(id) else { continue };
        let key = (row.parent_id.clone(), format!("{:?}", row.role));
        let sibs = buckets.get(&key);
        let (idx, total, prev, next) = match sibs {
            Some(list) => {
                let pos = list.iter().position(|(sid, _)| sid == id).unwrap_or(0);
                let prev = if pos > 0 {
                    Some(list[pos - 1].0.clone())
                } else {
                    None
                };
                let next = list.get(pos + 1).map(|(sid, _)| sid.clone());
                (pos as u32, list.len() as u32, prev, next)
            }
            None => (0, 1, None, None),
        };
        let mut m = (*row).clone().into_message();
        m.sibling_index = idx;
        m.sibling_count = total.max(1);
        m.prev_sibling_id = prev;
        m.next_sibling_id = next;
        out.push(m);
    }

    Ok(out)
}

#[tauri::command]
pub async fn save_message(pool: State<'_, DbPool>, message: Message) -> Result<(), String> {
    let parts_json = match &message.parts {
        Some(p) => Some(serde_json::to_string(p).map_err(|e| e.to_string())?),
        None => None,
    };
    // Upsert — same message id rewrites content + parts (streaming finalization).
    // `parent_id` is only set on insert so we never re-parent an existing node.
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, parent_id, role, content, created_at, parts_json, \
                               model_name, input_tokens, output_tokens, thinking_skipped) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
             content = excluded.content, \
             parts_json = excluded.parts_json, \
             input_tokens = COALESCE(excluded.input_tokens, messages.input_tokens), \
             output_tokens = COALESCE(excluded.output_tokens, messages.output_tokens), \
             thinking_skipped = excluded.thinking_skipped",
    )
    .bind(&message.id)
    .bind(&message.conversation_id)
    .bind(message.parent_id.as_deref())
    .bind(&message.role)
    .bind(&message.content)
    .bind(message.created_at)
    .bind(parts_json.as_deref())
    .bind(message.model_name.as_deref())
    .bind(message.input_tokens.map(|v| v as i64))
    .bind(message.output_tokens.map(|v| v as i64))
    .bind(message.thinking_skipped)
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
