mod commands;
mod db;
mod mcp;
mod models;
mod paths;
mod skills;
mod state;
mod tools;

use commands::{
    branches, conversations, global_settings as global_settings_cmds, mcp as mcp_cmds,
    messages, models as model_cmds,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Move any legacy state out of `~/Library/Application Support/…`
            // before touching the new paths, so we don't stomp a fresh DB.
            paths::migrate_from_legacy_dir(&handle);

            let db_file =
                paths::db_path(&handle).expect("failed to resolve ~/.agora/agora.db");

            let pool = tauri::async_runtime::block_on(db::init(&db_file))
                .expect("failed to initialise SQLite database");

            let mcp_manager = mcp::McpManager::new();
            let skill_registry = skills::SkillRegistry::new();

            // Best-effort startup: connect any enabled MCP servers and load
            // skills from ~/.agora/skills. Both tolerate failure silently so a
            // bad config can't block the app from starting.
            let skills_dir =
                paths::skills_dir(&handle).expect("failed to resolve ~/.agora/skills");

            {
                let pool_for_init = pool.clone();
                let mcp_for_init = mcp_manager.clone();
                let skills_for_init = skill_registry.clone();
                let skills_dir_str = skills_dir.to_string_lossy().into_owned();
                tauri::async_runtime::spawn(async move {
                    if let Ok(rows) = sqlx::query_as::<_, commands::mcp::McpServerRow>(
                        "SELECT id, name, transport, command, args_json, env_json, url, \
                                headers_json, login_shell, enabled, created_at \
                         FROM mcp_servers WHERE enabled = 1",
                    )
                    .fetch_all(&pool_for_init)
                    .await
                    {
                        let configs = rows.into_iter().map(|r| r.into_config()).collect();
                        mcp_for_init.connect_all(configs).await;
                    }

                    let scripts_enabled = sqlx::query_scalar::<_, bool>(
                        "SELECT skills_scripts_enabled FROM global_settings WHERE id = 1",
                    )
                    .fetch_one(&pool_for_init)
                    .await
                    .unwrap_or(false);
                    let _ = skills_for_init
                        .load_from(&skills_dir_str, scripts_enabled)
                        .await;
                });
            }

            app.manage(pool);
            app.manage(state::AppState::default());
            app.manage(state::RuntimeHandles {
                mcp: mcp_manager,
                skills: skill_registry,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            conversations::load_conversations,
            conversations::create_conversation,
            conversations::delete_conversation,
            conversations::rename_conversation,
            conversations::update_conversation_title_auto,
            conversations::set_conversation_pinned,
            messages::load_messages,
            messages::save_message,
            branches::set_active_leaf,
            branches::switch_branch,
            model_cmds::load_model_configs,
            model_cmds::save_model_configs,
            commands::model_test::test_model_config,
            commands::title::summarize_conversation_title,
            commands::export::export_conversation_markdown,
            commands::export::print_main_webview,
            commands::pdf::save_conversation_pdf,
            commands::share::share_conversation,
            commands::search::search_conversations,
            global_settings_cmds::load_global_settings,
            global_settings_cmds::save_global_settings,
            commands::ai_proxy::proxy_ai_request,
            commands::tool_bridge::list_frontend_tools,
            commands::tool_bridge::invoke_tool,
            mcp_cmds::load_mcp_servers,
            mcp_cmds::save_mcp_server,
            mcp_cmds::delete_mcp_server,
            mcp_cmds::test_mcp_server,
            commands::skills::get_skills_meta,
            commands::skills::set_skills_scripts_enabled,
            commands::skills::load_skills,
            commands::skills::rescan_skills,
            commands::skills::open_skills_folder,
            commands::skills::import_skill_folder,
            commands::skills::create_skill,
            commands::skills::delete_skill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
