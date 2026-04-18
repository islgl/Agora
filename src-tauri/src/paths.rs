//! All files Agora owns live under a single root, `~/.agora/`, regardless of
//! platform. Keeping this out of the OS's per-app data dir (which on macOS is
//! buried under `~/Library/Application Support/<bundle>`) makes it trivial
//! for users to inspect, back up, or clean up manually.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

pub fn agora_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let dir = home.join(".agora");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn skills_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = agora_dir(app)?.join("skills");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(agora_dir(app)?.join("agora.db"))
}

/// One-shot migration from the Tauri default `app_data_dir` (e.g.
/// `~/Library/Application Support/com.agora.app/`) to `~/.agora/`. Moves the
/// DB and skills across then removes the old directory. A no-op if the
/// destination already exists or the legacy dir is gone.
pub fn migrate_from_legacy_dir(app: &AppHandle) {
    let Ok(legacy) = app.path().app_data_dir() else {
        return;
    };
    if !legacy.exists() {
        return;
    }
    let Ok(agora_root) = agora_dir(app) else {
        return;
    };
    if legacy == agora_root {
        return;
    }

    let pairs: &[(&str, &str)] = &[("agora.db", "agora.db"), ("skills", "skills")];
    for (src_name, dst_name) in pairs {
        let src = legacy.join(src_name);
        let dst = agora_root.join(dst_name);
        if !src.exists() || dst.exists() {
            continue;
        }
        if let Err(e) = std::fs::rename(&src, &dst) {
            eprintln!(
                "Failed to migrate {} → {}: {}",
                src.display(),
                dst.display(),
                e
            );
        }
    }

    // Remove the legacy directory if we emptied it out. `remove_dir` only
    // succeeds on empty dirs, which is the safety net we want.
    let _ = std::fs::remove_dir(&legacy);
}
