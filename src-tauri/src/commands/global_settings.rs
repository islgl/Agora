use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::db::DbPool;
use crate::models::GlobalSettings;
use crate::state::RuntimeHandles;

#[tauri::command]
pub async fn load_global_settings(pool: State<'_, DbPool>) -> Result<GlobalSettings, String> {
    sqlx::query_as::<_, GlobalSettings>(
        "SELECT api_key, base_url_openai, base_url_anthropic, base_url_gemini, tavily_api_key, \
                web_search_enabled, auto_title_mode, thinking_effort, \
                workspace_root, auto_approve_readonly, hooks_json, active_model_id, \
                embedding_provider, embedding_model, embedding_configs_json, \
                base_url_embedding_common, \
                auto_memory_enabled, quick_launch_enabled, close_to_tray_enabled, \
                auto_dream_on_idle, dream_idle_minutes, nickname \
         FROM global_settings WHERE id = 1",
    )
    .fetch_one(&*pool)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_global_settings(
    app: AppHandle,
    pool: State<'_, DbPool>,
    handles: State<'_, RuntimeHandles>,
    settings: GlobalSettings,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE global_settings \
         SET api_key = ?, base_url_openai = ?, base_url_anthropic = ?, base_url_gemini = ?, \
             tavily_api_key = ?, web_search_enabled = ?, auto_title_mode = ?, \
             thinking_effort = ?, workspace_root = ?, auto_approve_readonly = ?, \
             hooks_json = ?, active_model_id = ?, \
             embedding_provider = ?, embedding_model = ?, embedding_configs_json = ?, \
             base_url_embedding_common = ?, \
             auto_memory_enabled = ?, \
             quick_launch_enabled = ?, \
             close_to_tray_enabled = ?, \
             auto_dream_on_idle = ?, \
             dream_idle_minutes = ? \
         WHERE id = 1",
    )
    .bind(&settings.api_key)
    .bind(&settings.base_url_openai)
    .bind(&settings.base_url_anthropic)
    .bind(&settings.base_url_gemini)
    .bind(&settings.tavily_api_key)
    .bind(settings.web_search_enabled)
    .bind(&settings.auto_title_mode)
    .bind(&settings.thinking_effort)
    .bind(&settings.workspace_root)
    .bind(settings.auto_approve_readonly)
    .bind(&settings.hooks_json)
    .bind(&settings.active_model_id)
    .bind(&settings.embedding_provider)
    .bind(&settings.embedding_model)
    .bind(&settings.embedding_configs_json)
    .bind(&settings.base_url_embedding_common)
    .bind(settings.auto_memory_enabled)
    .bind(settings.quick_launch_enabled)
    .bind(settings.close_to_tray_enabled)
    .bind(settings.auto_dream_on_idle)
    .bind(settings.dream_idle_minutes)
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    // Keep the built-ins runtime in sync so future FS/Bash calls see the
    // new root without a restart.
    let root = if settings.workspace_root.trim().is_empty() {
        None
    } else {
        Some(PathBuf::from(&settings.workspace_root))
    };
    handles.builtins.set_workspace_root(root).await;
    handles.background.apply_settings(&app, &settings);
    Ok(())
}
