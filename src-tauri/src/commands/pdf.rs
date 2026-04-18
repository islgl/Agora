//! Native PDF export. Uses `WKWebView.createPDFWithConfiguration:` on macOS
//! so the user gets a single "Save as PDF" flow instead of the two-step
//! print dialog.

#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::db::DbPool;

#[tauri::command]
pub async fn save_conversation_pdf(
    app: AppHandle,
    pool: State<'_, DbPool>,
    conversation_id: String,
    content_width: Option<f64>,
    content_height: Option<f64>,
) -> Result<Option<String>, String> {
    let title: String = sqlx::query_scalar(
        "SELECT title FROM conversations WHERE id = ?",
    )
    .bind(&conversation_id)
    .fetch_optional(&*pool)
    .await
    .map_err(|e| e.to_string())?
    .unwrap_or_else(|| "conversation".into());

    let default_name = format!("{}.pdf", sanitize_filename(&title));
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("PDF", &["pdf"])
        .save_file(move |p| {
            let _ = tx.send(p);
        });
    let Some(picked) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;

    generate_and_write(&app, &path, content_width, content_height).await?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(target_os = "macos")]
async fn generate_and_write(
    app: &AppHandle,
    path: &std::path::Path,
    content_width: Option<f64>,
    content_height: Option<f64>,
) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or("main window not available")?;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));

    win.with_webview(move |wv| {
        let ptr = wv.inner();
        unsafe {
            mac::generate_pdf(ptr, tx.clone(), content_width, content_height);
        }
    })
    .map_err(|e| e.to_string())?;

    let bytes = rx
        .await
        .map_err(|e| format!("pdf channel dropped: {}", e))??;
    std::fs::write(path, bytes).map_err(|e| format!("write failed: {}", e))
}

#[cfg(not(target_os = "macos"))]
async fn generate_and_write(
    _app: &AppHandle,
    _path: &std::path::Path,
    _content_width: Option<f64>,
    _content_height: Option<f64>,
) -> Result<(), String> {
    Err("PDF export is only available on macOS".into())
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

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    use std::sync::{Arc, Mutex};

    use block2::RcBlock;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{MainThreadMarker, NSData, NSError};
    use objc2_web_kit::{WKPDFConfiguration, WKWebView};
    use tokio::sync::oneshot;

    pub unsafe fn generate_pdf(
        webview_ptr: *mut c_void,
        tx: Arc<Mutex<Option<oneshot::Sender<Result<Vec<u8>, String>>>>>,
        content_width: Option<f64>,
        content_height: Option<f64>,
    ) {
        let webview: &WKWebView = &*(webview_ptr as *const WKWebView);
        let mtm = MainThreadMarker::new()
            .expect("generate_pdf must run on the main thread");
        let config = WKPDFConfiguration::new(mtm);

        // `createPDFWithConfiguration:` defaults to rendering only the web
        // view's visible bounds — for a scrollable overlay this truncates the
        // export. When the frontend tells us the document's full content
        // size, ask WebKit to render that whole rect into a single tall page.
        if let (Some(w), Some(h)) = (content_width, content_height) {
            if w > 0.0 && h > 0.0 {
                let rect = CGRect {
                    origin: CGPoint { x: 0.0, y: 0.0 },
                    size: CGSize { width: w, height: h },
                };
                config.setRect(rect);
            }
        }

        let handler = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
            let result = if !data.is_null() {
                let data_ref: &NSData = &*data;
                Ok(data_ref.to_vec())
            } else if !error.is_null() {
                let err_ref: &NSError = &*error;
                Err(err_ref.localizedDescription().to_string())
            } else {
                Err("PDF generation returned null data and null error".into())
            };
            if let Some(sender) = tx.lock().unwrap().take() {
                let _ = sender.send(result);
            }
        });

        webview.createPDFWithConfiguration_completionHandler(Some(&config), &handler);
    }
}
