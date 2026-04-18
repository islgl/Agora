//! macOS-native share sheet for conversations.
//!
//! Wraps `NSSharingServicePicker` via `objc2` so no Swift/Xcode project is
//! needed. On non-macOS targets the command falls back to an "unsupported"
//! error; wire into platform-specific UI at the call site as we grow.
//!
//! We share a temp `.md` file (not the raw markdown string) so share targets
//! like AirDrop, Mail, and Notes get a real attachment with a filename.

use std::path::PathBuf;

use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::db::DbPool;

#[tauri::command]
pub async fn share_conversation(
    app: AppHandle,
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> Result<(), String> {
    let markdown = crate::commands::export::render_conversation_markdown(
        &pool,
        &conversation_id,
    )
    .await?;

    let title: String = sqlx::query_scalar(
        "SELECT title FROM conversations WHERE id = ?",
    )
    .bind(&conversation_id)
    .fetch_optional(&*pool)
    .await
    .map_err(|e| e.to_string())?
    .unwrap_or_else(|| "conversation".into());

    let file_path = write_temp_markdown(&title, &markdown)?;
    share_file(&app, file_path).await
}

/// Writes `markdown` to `$TMPDIR/agora-<safe-title>-<uuid>.md` and returns
/// the path. Kept in temp so macOS cleans it up on next reboot.
fn write_temp_markdown(title: &str, markdown: &str) -> Result<PathBuf, String> {
    let safe_title = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>();
    let trimmed: String = safe_title.trim().chars().take(40).collect();
    let base = if trimmed.is_empty() { "conversation" } else { trimmed.as_str() };
    let filename = format!("agora-{}-{}.md", base, Uuid::new_v4().simple());
    let path = std::env::temp_dir().join(filename);
    std::fs::write(&path, markdown).map_err(|e| format!("write failed: {}", e))?;
    Ok(path)
}

#[cfg(target_os = "macos")]
async fn share_file(app: &AppHandle, path: PathBuf) -> Result<(), String> {
    use tauri::Manager;
    let main_window = app
        .get_webview_window("main")
        .ok_or("main window not available")?;
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    main_window
        .run_on_main_thread(move || {
            let result = unsafe { mac::present_share_picker_for_file(&path) };
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.await
        .map_err(|e| format!("share channel dropped: {}", e))?
}

#[cfg(not(target_os = "macos"))]
async fn share_file(_app: &AppHandle, _path: PathBuf) -> Result<(), String> {
    Err("Native share is only available on macOS".into())
}

#[cfg(target_os = "macos")]
mod mac {
    use std::path::Path;

    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSApplication, NSSharingServicePicker};
    use objc2_foundation::{
        MainThreadMarker, NSArray, NSPoint, NSRect, NSRectEdge, NSSize, NSString, NSURL,
    };

    pub unsafe fn present_share_picker_for_file(path: &Path) -> Result<(), String> {
        let mtm = MainThreadMarker::new()
            .ok_or("share must run on the main thread")?;

        let path_str = path
            .to_str()
            .ok_or("path is not valid UTF-8")?;
        let ns_path = NSString::from_str(path_str);
        let url = NSURL::fileURLWithPath(&ns_path);
        let any: Retained<AnyObject> = Retained::cast_unchecked(url);
        let items = NSArray::from_retained_slice(&[any]);

        let picker = NSSharingServicePicker::initWithItems(
            NSSharingServicePicker::alloc(),
            &items,
        );

        let app = NSApplication::sharedApplication(mtm);
        let window = app
            .mainWindow()
            .ok_or("no main window to anchor the share sheet")?;
        let content_view = window
            .contentView()
            .ok_or("main window has no content view")?;

        let bounds = content_view.bounds();
        let anchor = NSRect {
            origin: NSPoint {
                x: bounds.size.width - 60.0,
                y: bounds.size.height - 40.0,
            },
            size: NSSize {
                width: 1.0,
                height: 1.0,
            },
        };

        picker.showRelativeToRect_ofView_preferredEdge(
            anchor,
            &content_view,
            NSRectEdge::NSMinYEdge,
        );
        Ok(())
    }
}
