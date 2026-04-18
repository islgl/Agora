use tauri::State;

use crate::db::DbPool;
use crate::models::GlobalSettings;

#[tauri::command]
pub async fn load_global_settings(pool: State<'_, DbPool>) -> Result<GlobalSettings, String> {
    sqlx::query_as::<_, GlobalSettings>(
        "SELECT api_key, base_url_openai, base_url_anthropic, base_url_gemini, tavily_api_key, \
                web_search_enabled, auto_title_mode, thinking_effort \
         FROM global_settings WHERE id = 1",
    )
    .fetch_one(&*pool)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_global_settings(
    pool: State<'_, DbPool>,
    settings: GlobalSettings,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE global_settings \
         SET api_key = ?, base_url_openai = ?, base_url_anthropic = ?, base_url_gemini = ?, \
             tavily_api_key = ?, web_search_enabled = ?, auto_title_mode = ?, \
             thinking_effort = ? \
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
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
