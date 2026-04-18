//! Markdown export of a conversation's currently-active branch.
//!
//! Backend owns both the formatting and the file write: we pop a native save
//! dialog, build the markdown from DB rows, and write it straight to disk.
//! PDF export is intentionally not here — that's driven by `window.print()`
//! on the webview, which gives users the native macOS "Save as PDF" flow.

use std::collections::HashMap;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::db::DbPool;
use crate::models::{Conversation, MessagePart, MessageRow, Role};

/// Pops the native print dialog for the main webview. `window.print()` inside
/// Tauri's WKWebView is not reliably supported on macOS, so we delegate to
/// the webview's native `print()` method.
#[tauri::command]
pub async fn print_main_webview(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or("main window not available")?;
    win.print().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn export_conversation_markdown(
    app: AppHandle,
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> Result<Option<String>, String> {
    let markdown = render_conversation_markdown(&pool, &conversation_id).await?;
    let conv: Conversation = sqlx::query_as(
        "SELECT id, title, created_at, model_id, pinned, title_locked \
         FROM conversations WHERE id = ?",
    )
    .bind(&conversation_id)
    .fetch_one(&*pool)
    .await
    .map_err(|e| format!("conversation not found: {}", e))?;

    let default_name = format!("{}.md", sanitize_filename(&conv.title));
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("Markdown", &["md"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(picked) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;

    std::fs::write(&path, markdown).map_err(|e| format!("write failed: {}", e))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Loads the conversation + walks its active branch, returns a markdown
/// string ready to write to disk or hand to the macOS share sheet.
pub async fn render_conversation_markdown(
    pool: &DbPool,
    conversation_id: &str,
) -> Result<String, String> {
    let conv: Conversation = sqlx::query_as(
        "SELECT id, title, created_at, model_id, pinned, title_locked \
         FROM conversations WHERE id = ?",
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("conversation not found: {}", e))?;

    let all_rows: Vec<MessageRow> = sqlx::query_as(
        "SELECT id, conversation_id, parent_id, role, content, created_at, parts_json, \
                model_name, input_tokens, output_tokens, thinking_skipped \
         FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let leaf_opt: Option<String> = sqlx::query_scalar(
        "SELECT active_leaf_id FROM conversations WHERE id = ?",
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .flatten();

    let by_id: HashMap<String, &MessageRow> =
        all_rows.iter().map(|r| (r.id.clone(), r)).collect();
    let leaf_id = leaf_opt
        .filter(|id| by_id.contains_key(id))
        .or_else(|| all_rows.last().map(|r| r.id.clone()));

    let mut path_ids: Vec<String> = Vec::new();
    if let Some(leaf) = leaf_id {
        let mut cursor = Some(leaf);
        let cap = all_rows.len() + 1;
        while let Some(id) = cursor.take() {
            if path_ids.len() > cap {
                break;
            }
            if let Some(row) = by_id.get(&id) {
                let next = row.parent_id.clone();
                path_ids.push(id);
                cursor = next;
            } else {
                break;
            }
        }
        path_ids.reverse();
    }

    Ok(render_markdown(&conv, &path_ids, &by_id))
}

fn render_markdown(
    conv: &Conversation,
    path_ids: &[String],
    by_id: &HashMap<String, &MessageRow>,
) -> String {
    let mut out = String::new();
    // Frontmatter so the file re-imports cleanly into tools that read YAML.
    out.push_str("---\n");
    out.push_str(&format!("title: {}\n", yaml_escape(&conv.title)));
    out.push_str(&format!(
        "created_at: {}\n",
        format_iso8601(conv.created_at)
    ));
    out.push_str(&format!(
        "exported_at: {}\n",
        format_iso8601(now_millis())
    ));
    out.push_str("source: Agora\n");
    out.push_str("---\n\n");

    out.push_str(&format!("# {}\n\n", conv.title));

    for id in path_ids {
        let Some(row) = by_id.get(id) else { continue };
        match row.role {
            Role::User => out.push_str("## User\n\n"),
            Role::Assistant => {
                let model = row
                    .model_name
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .map(|m| format!("## Assistant · `{}`\n\n", m))
                    .unwrap_or_else(|| "## Assistant\n\n".into());
                out.push_str(&model);
            }
            Role::System => out.push_str("## System\n\n"),
        }

        // Prefer structured parts (tool calls etc.) when present; fall back to plain content.
        let rendered = row
            .parts_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<MessagePart>>(s).ok())
            .map(|parts| render_parts(&parts))
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| row.content.clone());

        out.push_str(rendered.trim_end());
        out.push_str("\n\n");
    }

    out
}

fn render_parts(parts: &[MessagePart]) -> String {
    let mut buf = String::new();
    for p in parts {
        match p {
            MessagePart::Text { text } => {
                if !text.is_empty() {
                    buf.push_str(text);
                    buf.push_str("\n\n");
                }
            }
            MessagePart::Thinking { text } => {
                if !text.is_empty() {
                    // Collapsed by default in markdown viewers that support
                    // HTML (GitHub, Obsidian). Plain-text readers still see
                    // the reasoning verbatim.
                    buf.push_str("<details><summary>Thinking</summary>\n\n");
                    buf.push_str(text);
                    buf.push_str("\n\n</details>\n\n");
                }
            }
            MessagePart::ToolCall { name, input, .. } => {
                let pretty = serde_json::to_string_pretty(input).unwrap_or_default();
                buf.push_str(&format!(
                    "> **🔧 Tool call** `{}`\n```json\n{}\n```\n\n",
                    name, pretty
                ));
            }
            MessagePart::ToolResult {
                content, is_error, ..
            } => {
                let marker = if *is_error { "❌ error" } else { "✅ result" };
                buf.push_str(&format!(
                    "> **{}**\n```\n{}\n```\n\n",
                    marker,
                    content.trim_end()
                ));
            }
            MessagePart::Image { data_url, .. } => {
                // Markdown embeds the full data URL — the exported file is
                // self-contained even without a network round-trip.
                buf.push_str(&format!("![attachment]({})\n\n", data_url));
            }
        }
    }
    buf
}

fn sanitize_filename(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| {
            if matches!(
                c,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0'
            ) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = out.trim();
    if trimmed.is_empty() {
        "conversation".into()
    } else {
        trimmed.chars().take(80).collect()
    }
}

fn yaml_escape(s: &str) -> String {
    let s = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", s)
}

fn format_iso8601(ms: i64) -> String {
    // Minimal ISO8601 formatter — no chrono dependency, no timezone handling.
    // Good enough for a frontmatter timestamp.
    let secs = ms / 1000;
    let days_since_epoch = secs / 86_400;
    let secs_of_day = (secs % 86_400 + 86_400) % 86_400;
    let (year, month, day) = civil_from_days(days_since_epoch);
    let h = secs_of_day / 3600;
    let m = (secs_of_day % 3600) / 60;
    let s = secs_of_day % 60;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, h, m, s
    )
}

// https://howardhinnant.github.io/date_algorithms.html — civil_from_days
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
