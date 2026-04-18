use std::collections::HashMap;

use tauri::State;

use crate::db::DbPool;
use crate::models::{Message, MessageRow};

/// Points the conversation's active leaf at `message_id`. Used after a normal
/// send / edit / regenerate completes.
#[tauri::command]
pub async fn set_active_leaf(
    pool: State<'_, DbPool>,
    conversation_id: String,
    message_id: String,
) -> Result<(), String> {
    sqlx::query("UPDATE conversations SET active_leaf_id = ? WHERE id = ?")
        .bind(&message_id)
        .bind(&conversation_id)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Navigates to a sibling branch. Walks down `message_id`'s subtree picking
/// the most-recent child at each step until it reaches a leaf, sets that leaf
/// as the conversation's active tip, and returns the fresh active path with
/// sibling annotations (same shape as `load_messages`).
#[tauri::command]
pub async fn switch_branch(
    pool: State<'_, DbPool>,
    conversation_id: String,
    message_id: String,
) -> Result<Vec<Message>, String> {
    // Pull every row for the conversation — cheap relative to chat IO, and
    // we need the full tree to both descend to a leaf and compute sibling
    // annotations.
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
        return Err("conversation has no messages".into());
    }

    let by_id: HashMap<String, &MessageRow> = all_rows.iter().map(|r| (r.id.clone(), r)).collect();
    if !by_id.contains_key(&message_id) {
        return Err(format!("message {} not found in this conversation", message_id));
    }

    // children_by_parent: parent_id → children sorted by created_at ASC
    let mut children_by_parent: HashMap<String, Vec<&MessageRow>> = HashMap::new();
    for r in &all_rows {
        if let Some(pid) = &r.parent_id {
            children_by_parent.entry(pid.clone()).or_default().push(r);
        }
    }
    for v in children_by_parent.values_mut() {
        v.sort_by_key(|r| r.created_at);
    }

    // Descend greedily: most-recent child at each step.
    let mut leaf = message_id.clone();
    loop {
        let Some(children) = children_by_parent.get(&leaf) else {
            break;
        };
        let Some(latest) = children.last() else {
            break;
        };
        leaf = latest.id.clone();
    }

    sqlx::query("UPDATE conversations SET active_leaf_id = ? WHERE id = ?")
        .bind(&leaf)
        .bind(&conversation_id)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;

    // Reuse the same walk-up + sibling-annotation logic as load_messages.
    let mut path_ids: Vec<String> = Vec::new();
    let mut cursor = Some(leaf);
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

    let mut buckets: HashMap<(Option<String>, String), Vec<(String, i64)>> = HashMap::new();
    for r in &all_rows {
        let key = (r.parent_id.clone(), format!("{:?}", r.role));
        buckets.entry(key).or_default().push((r.id.clone(), r.created_at));
    }
    for v in buckets.values_mut() {
        v.sort_by_key(|(_, ts)| *ts);
    }

    let mut out: Vec<Message> = Vec::with_capacity(path_ids.len());
    for id in &path_ids {
        let Some(row) = by_id.get(id) else { continue };
        let key = (row.parent_id.clone(), format!("{:?}", row.role));
        let (idx, total, prev, next) = buckets
            .get(&key)
            .map(|list| {
                let pos = list.iter().position(|(sid, _)| sid == id).unwrap_or(0);
                let prev = if pos > 0 { Some(list[pos - 1].0.clone()) } else { None };
                let next = list.get(pos + 1).map(|(sid, _)| sid.clone());
                (pos as u32, list.len() as u32, prev, next)
            })
            .unwrap_or((0, 1, None, None));
        let mut m = (*row).clone().into_message();
        m.sibling_index = idx;
        m.sibling_count = total.max(1);
        m.prev_sibling_id = prev;
        m.next_sibling_id = next;
        out.push(m);
    }

    Ok(out)
}
