use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Deserialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::fs;

use crate::db::DbPool;
use crate::paths;
use crate::skills::Skill;
use crate::state::RuntimeHandles;

pub fn skills_root(app: &AppHandle) -> Result<PathBuf, String> {
    paths::skills_dir(app)
}

#[tauri::command]
pub async fn get_skills_meta(
    app: AppHandle,
    pool: State<'_, DbPool>,
) -> Result<SkillsMeta, String> {
    let dir = skills_root(&app)?;
    let scripts_enabled = sqlx::query_scalar::<_, bool>(
        "SELECT skills_scripts_enabled FROM global_settings WHERE id = 1",
    )
    .fetch_one(&*pool)
    .await
    .unwrap_or(false);
    Ok(SkillsMeta {
        directory: dir.to_string_lossy().into_owned(),
        scripts_enabled,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsMeta {
    pub directory: String,
    pub scripts_enabled: bool,
}

#[tauri::command]
pub async fn set_skills_scripts_enabled(
    pool: State<'_, DbPool>,
    handles: State<'_, RuntimeHandles>,
    enabled: bool,
) -> Result<(), String> {
    sqlx::query("UPDATE global_settings SET skills_scripts_enabled = ? WHERE id = 1")
        .bind(enabled)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    handles.skills.set_scripts_enabled(enabled).await;
    Ok(())
}

#[tauri::command]
pub async fn load_skills(handles: State<'_, RuntimeHandles>) -> Result<Vec<Skill>, String> {
    Ok(handles.skills.snapshot().await)
}

#[tauri::command]
pub async fn rescan_skills(
    app: AppHandle,
    pool: State<'_, DbPool>,
    handles: State<'_, RuntimeHandles>,
) -> Result<Vec<Skill>, String> {
    let dir = skills_root(&app)?;
    let scripts_enabled = sqlx::query_scalar::<_, bool>(
        "SELECT skills_scripts_enabled FROM global_settings WHERE id = 1",
    )
    .fetch_one(&*pool)
    .await
    .unwrap_or(false);
    handles
        .skills
        .load_from(&dir.to_string_lossy(), scripts_enabled)
        .await?;
    Ok(handles.skills.snapshot().await)
}

#[tauri::command]
pub async fn open_skills_folder(app: AppHandle) -> Result<(), String> {
    let dir = skills_root(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Pop a folder picker, validate that the chosen folder contains a SKILL.md,
/// then copy it into `<app_data>/skills/<name>/`. Returns the imported skill
/// name, or `None` if the user cancelled.
#[tauri::command]
pub async fn import_skill_folder(
    app: AppHandle,
    pool: State<'_, DbPool>,
    handles: State<'_, RuntimeHandles>,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |selected| {
        let _ = tx.send(selected);
    });
    let Some(selected) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let src = selected.into_path().map_err(|e| e.to_string())?;

    if !src.join("SKILL.md").exists() {
        return Err("Chosen folder has no SKILL.md — not a Skill.".into());
    }

    let base_name = src
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "could not derive name from folder".to_string())?
        .to_string();

    let root = skills_root(&app)?;
    let dest = unique_dest(&root, &base_name);
    copy_dir_recursive(&src, &dest).await?;

    // Refresh registry
    let scripts_enabled = sqlx::query_scalar::<_, bool>(
        "SELECT skills_scripts_enabled FROM global_settings WHERE id = 1",
    )
    .fetch_one(&*pool)
    .await
    .unwrap_or(false);
    handles
        .skills
        .load_from(&root.to_string_lossy(), scripts_enabled)
        .await?;

    Ok(Some(
        dest.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&base_name)
            .to_string(),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDraft {
    pub name: String,
    pub description: String,
    pub body: String,
    #[serde(default)]
    pub scripts: Vec<ScriptUpload>,
}

#[derive(Debug, Deserialize)]
pub struct ScriptUpload {
    pub filename: String,
    /// Base64 of the raw file bytes.
    pub content_base64: String,
}

#[tauri::command]
pub async fn create_skill(
    app: AppHandle,
    pool: State<'_, DbPool>,
    handles: State<'_, RuntimeHandles>,
    draft: SkillDraft,
) -> Result<String, String> {
    let name = draft.name.trim();
    if name.is_empty() {
        return Err("name is required".into());
    }
    if !is_safe_folder_name(name) {
        return Err(
            "name may only contain letters, numbers, dashes, underscores and spaces".into(),
        );
    }

    let root = skills_root(&app)?;
    let dir = root.join(name);
    if dir.exists() {
        return Err(format!("A skill named '{}' already exists.", name));
    }
    fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;

    let description = draft.description.trim();
    let frontmatter = format!(
        "---\nname: {}\ndescription: {}\n---\n\n{}",
        yaml_scalar(name),
        yaml_scalar(description),
        draft.body.trim_start()
    );
    fs::write(dir.join("SKILL.md"), frontmatter)
        .await
        .map_err(|e| e.to_string())?;

    if !draft.scripts.is_empty() {
        let scripts_dir = dir.join("scripts");
        fs::create_dir_all(&scripts_dir)
            .await
            .map_err(|e| e.to_string())?;
        for s in &draft.scripts {
            if !is_safe_file_name(&s.filename) {
                return Err(format!("invalid script filename: {}", s.filename));
            }
            let bytes = BASE64
                .decode(s.content_base64.as_bytes())
                .map_err(|e| format!("invalid base64 for {}: {}", s.filename, e))?;
            let path = scripts_dir.join(&s.filename);
            fs::write(&path, bytes).await.map_err(|e| e.to_string())?;
            make_executable(&path).await;
        }
    }

    let scripts_enabled = sqlx::query_scalar::<_, bool>(
        "SELECT skills_scripts_enabled FROM global_settings WHERE id = 1",
    )
    .fetch_one(&*pool)
    .await
    .unwrap_or(false);
    handles
        .skills
        .load_from(&root.to_string_lossy(), scripts_enabled)
        .await?;

    Ok(name.to_string())
}

#[tauri::command]
pub async fn delete_skill(
    app: AppHandle,
    pool: State<'_, DbPool>,
    handles: State<'_, RuntimeHandles>,
    name: String,
) -> Result<(), String> {
    if !is_safe_folder_name(&name) {
        return Err("invalid skill name".into());
    }
    let root = skills_root(&app)?;
    let dir = root.join(&name);
    // Guard against symlink escape.
    let canonical = dir.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(root.canonicalize().map_err(|e| e.to_string())?) {
        return Err("refusing to delete outside skills dir".into());
    }
    fs::remove_dir_all(&canonical)
        .await
        .map_err(|e| e.to_string())?;

    let scripts_enabled = sqlx::query_scalar::<_, bool>(
        "SELECT skills_scripts_enabled FROM global_settings WHERE id = 1",
    )
    .fetch_one(&*pool)
    .await
    .unwrap_or(false);
    handles
        .skills
        .load_from(&root.to_string_lossy(), scripts_enabled)
        .await?;
    Ok(())
}

// ─────────────────────────── helpers ───────────────────────────

fn is_safe_folder_name(s: &str) -> bool {
    !s.is_empty()
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains("..")
        && s.chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == ' ')
}

fn is_safe_file_name(s: &str) -> bool {
    !s.is_empty()
        && !s.contains('/')
        && !s.contains('\\')
        && !s.starts_with('.')
        && !s.contains("..")
}

fn unique_dest(root: &Path, base: &str) -> PathBuf {
    let first = root.join(base);
    if !first.exists() {
        return first;
    }
    for i in 2..1000 {
        let candidate = root.join(format!("{}-{}", base, i));
        if !candidate.exists() {
            return candidate;
        }
    }
    root.join(format!("{}-{}", base, uuid::Uuid::new_v4()))
}

async fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).await.map_err(|e| e.to_string())?;
    let mut entries = fs::read_dir(src).await.map_err(|e| e.to_string())?;
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let file_type = entry.file_type().await.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            Box::pin(copy_dir_recursive(&src_path, &dst_path)).await?;
        } else if file_type.is_file() {
            fs::copy(&src_path, &dst_path)
                .await
                .map_err(|e| e.to_string())?;
            // Preserve executable bit for files under scripts/.
            if src_path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|s| s.to_str())
                == Some("scripts")
            {
                make_executable(&dst_path).await;
            }
        }
    }
    Ok(())
}

async fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        if let Ok(meta) = fs::metadata(path).await {
            let mut perms = meta.permissions();
            perms.set_mode(perms.mode() | 0o111);
            let _ = fs::set_permissions(path, perms).await;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn yaml_scalar(s: &str) -> String {
    // Safe quoting for single-line YAML scalars.
    if s.is_empty() {
        return "\"\"".to_string();
    }
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}
