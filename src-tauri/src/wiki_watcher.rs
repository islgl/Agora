//! Raw Layer file watcher — Phase 4.
//!
//! Runs in a dedicated tokio task at app startup, monitors
//! `~/.agora/raw/`, and emits a Tauri event whenever a file materializes
//! or is modified. The webview subscribes and dispatches a wiki-ingest
//! subagent against the file.
//!
//! Design notes:
//! - Uses `notify-debouncer-full` so a single editor save doesn't
//!   trigger N events — we only care about the settled state.
//! - Hidden files (dotfiles), directory events, and removals are
//!   ignored; the inbox is drop-in-only from the agent's perspective.
//! - On startup we do NOT retroactively process pre-existing files —
//!   those are for the user to ingest manually via the UI. Auto-ingest
//!   should feel like "I just dropped something and the agent reacted,"
//!   not "I opened the app and my whole inbox exploded."

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    new_debouncer, DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use crate::paths;

/// Payload for the `wiki-ingest-request` event emitted to the webview.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestRequest {
    pub rel_path: String,
    pub abs_path: String,
    pub kind: String,
    pub supported: bool,
}

pub fn start(app: AppHandle) {
    let raw_dir = match paths::raw_dir(&app) {
        Ok(p) => p,
        Err(err) => {
            eprintln!("wiki_watcher: cannot resolve raw dir: {err}");
            return;
        }
    };
    let app = Arc::new(app);
    tauri::async_runtime::spawn(async move {
        if let Err(err) = run(app, raw_dir).await {
            eprintln!("wiki_watcher stopped: {err}");
        }
    });
}

async fn run(app: Arc<AppHandle>, raw_dir: PathBuf) -> Result<(), String> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<DebouncedEvent>>();

    // notify debouncer runs its own OS thread; we just forward batches
    // into the async channel so the emission side can live in tokio.
    let mut debouncer: Debouncer<RecommendedWatcher, RecommendedCache> = new_debouncer(
        Duration::from_millis(1500),
        None,
        move |result: DebounceEventResult| {
            if let Ok(events) = result {
                let _ = tx.send(events);
            }
        },
    )
    .map_err(|e| format!("notify debouncer init: {e}"))?;

    debouncer
        .watch(&raw_dir, RecursiveMode::Recursive)
        .map_err(|e| format!("watch {}: {e}", raw_dir.display()))?;

    // Keep the debouncer alive for the life of the app — dropping it
    // stops watching. `std::mem::forget` is intentional: we're holding
    // it for the program lifetime.
    std::mem::forget(debouncer);

    while let Some(events) = rx.recv().await {
        let mut seen: std::collections::HashSet<PathBuf> = Default::default();
        for ev in events {
            if !is_ingest_event(&ev.event.kind) {
                continue;
            }
            for path in ev.event.paths.iter() {
                if !path.is_file() {
                    continue;
                }
                if is_hidden(path) {
                    continue;
                }
                if !path.starts_with(&raw_dir) {
                    continue;
                }
                if !seen.insert(path.to_path_buf()) {
                    continue;
                }
                let rel = match path.strip_prefix(&raw_dir) {
                    Ok(r) => r.to_string_lossy().replace('\\', "/"),
                    Err(_) => continue,
                };
                let (kind, supported) = classify(path);
                let payload = IngestRequest {
                    rel_path: rel,
                    abs_path: path.to_string_lossy().into_owned(),
                    kind,
                    supported,
                };
                if let Err(err) = app.emit("wiki-ingest-request", payload.clone()) {
                    eprintln!(
                        "wiki_watcher: failed to emit ingest event for {}: {err}",
                        payload.abs_path
                    );
                }
            }
        }
    }

    Ok(())
}

fn is_ingest_event(kind: &EventKind) -> bool {
    matches!(kind, EventKind::Create(_) | EventKind::Modify(_))
}

fn is_hidden(path: &Path) -> bool {
    path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .map(|s| s.starts_with('.'))
            .unwrap_or(false)
    })
}

fn classify(path: &Path) -> (String, bool) {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "md" | "markdown" | "txt" => ("md".into(), true),
        "pdf" => ("pdf".into(), true),
        "html" | "htm" => ("html".into(), true),
        "" => ("".into(), false),
        other => (other.to_string(), false),
    }
}

// Ensure `Manager` import is not dead when code changes later — the
// watcher uses `app.emit(...)` from Emitter, which needs the Manager
// trait too on some Tauri setups. Keeping the import reference here
// (behind allow) so a future refactor doesn't accidentally remove it.
#[allow(dead_code)]
fn _manager_trait_hint(app: &AppHandle) -> AppHandle {
    let _ = <AppHandle as Manager<tauri::Wry>>::path(app);
    app.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingest_event_matcher() {
        use notify::event::{CreateKind, ModifyKind};
        assert!(is_ingest_event(&EventKind::Create(CreateKind::File)));
        assert!(is_ingest_event(&EventKind::Modify(ModifyKind::Any)));
        assert!(!is_ingest_event(&EventKind::Remove(
            notify::event::RemoveKind::File
        )));
    }

    #[test]
    fn classify_picks_kind() {
        assert_eq!(classify(Path::new("x.md")).0, "md");
        assert_eq!(classify(Path::new("x.pdf")).0, "pdf");
        assert!(classify(Path::new("x.pdf")).1);
        assert!(!classify(Path::new("x.png")).1);
    }

    #[test]
    fn hidden_paths_skipped() {
        assert!(is_hidden(Path::new("raw/.ds_store")));
        assert!(is_hidden(Path::new(".hidden/dir/file.md")));
        assert!(!is_hidden(Path::new("raw/articles/post.md")));
    }
}
