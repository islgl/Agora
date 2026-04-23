mod background;
mod builtins;
mod commands;
mod db;
mod mcp;
mod memory_auto;
mod models;
mod paths;
mod skills;
mod state;
mod tools;
mod wiki_watcher;

use commands::{
    background as background_cmds, branches, conversations,
    global_settings as global_settings_cmds, mcp as mcp_cmds, messages, models as model_cmds,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(background::handle_window_event)
        .setup(|app| {
            let handle = app.handle().clone();

            // Move any legacy state out of `~/Library/Application Support/…`
            // before touching the new paths, so we don't stomp a fresh DB.
            paths::migrate_from_legacy_dir(&handle);

            // Brand Layer · seed SOUL.md + AGENTS.md on first launch so
            // fresh installs have a working personality out of the box.
            // Tolerates failure (read-only home dir, permission error) —
            // the loader will fall back to empty sections.
            if let Ok(cfg_dir) = paths::config_dir(&handle) {
                let _ = commands::brand_loader::ensure_defaults(&cfg_dir);
            }
            // Wiki / Raw / Logs directories are created lazily by their
            // helpers, but touching them here ensures the folder layout
            // exists the first time the user opens ~/.agora/ in Finder.
            let _ = paths::wiki_dir(&handle);
            let _ = paths::raw_dir(&handle);
            let _ = paths::logs_dir(&handle);

            let db_file =
                paths::db_path(&handle).expect("failed to resolve ~/.agora/agora.db");

            let pool = tauri::async_runtime::block_on(db::init(&db_file))
                .expect("failed to initialise SQLite database");

            let mcp_manager = mcp::McpManager::new();
            let skill_registry = skills::SkillRegistry::new();
            let builtins_runtime = builtins::BuiltinsRuntime::new();
            let memory_store = memory_auto::MemoryStore::new(pool.clone());
            let background_manager = background::BackgroundManager::new();

            // Best-effort startup: connect any enabled MCP servers and load
            // skills from ~/.agora/skills. Both tolerate failure silently so a
            // bad config can't block the app from starting.
            let skills_dir =
                paths::skills_dir(&handle).expect("failed to resolve ~/.agora/skills");
            // First-launch default for the built-ins workspace — empty
            // on a fresh install means "never configured", so apply
            // `~/.agora/workspace`. Resolved on the main thread so the
            // AppHandle doesn't have to cross into the spawned task.
            let default_workspace_str = paths::default_workspace_dir(&handle)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();

            {
                let pool_for_init = pool.clone();
                let mcp_for_init = mcp_manager.clone();
                let skills_for_init = skill_registry.clone();
                let builtins_for_init = builtins_runtime.clone();
                let skills_dir_str = skills_dir.to_string_lossy().into_owned();
                let default_workspace_for_init = default_workspace_str.clone();
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

                    // Prime the built-ins runtime with the persisted workspace
                    // root so FS/Bash tools have scope from the first call.
                    // On the very first launch (DB default = empty, no
                    // `workspace_default_applied` flag), persist
                    // `~/.agora/workspace` as the default so users get a
                    // working FS/Bash scope without configuring one first.
                    // If the user later clears the path, the flag prevents
                    // us from silently reapplying the default next boot.
                    let ws: String = sqlx::query_scalar(
                        "SELECT workspace_root FROM global_settings WHERE id = 1",
                    )
                    .fetch_one(&pool_for_init)
                    .await
                    .unwrap_or_default();
                    let ws_trimmed = ws.trim().to_string();

                    let default_applied: Option<String> = sqlx::query_scalar(
                        "SELECT value FROM meta_flags WHERE key = 'workspace_default_applied'",
                    )
                    .fetch_optional(&pool_for_init)
                    .await
                    .ok()
                    .flatten();

                    let effective = if ws_trimmed.is_empty()
                        && default_applied.is_none()
                        && !default_workspace_for_init.is_empty()
                    {
                        let _ = sqlx::query(
                            "UPDATE global_settings SET workspace_root = ? WHERE id = 1",
                        )
                        .bind(&default_workspace_for_init)
                        .execute(&pool_for_init)
                        .await;
                        let _ = sqlx::query(
                            "INSERT OR REPLACE INTO meta_flags (key, value) \
                             VALUES ('workspace_default_applied', '1')",
                        )
                        .execute(&pool_for_init)
                        .await;
                        default_workspace_for_init
                    } else {
                        ws_trimmed
                    };

                    if !effective.is_empty() {
                        builtins_for_init
                            .set_workspace_root(Some(std::path::PathBuf::from(&effective)))
                            .await;
                    }
                });
            }

            // Rehydrate the HNSW graph from whatever's already in SQLite
            // so Top-K search works on the very first turn after a
            // restart. Spawn on the tokio runtime so startup stays sync.
            {
                let store_for_init = memory_store.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = store_for_init.rehydrate().await {
                        eprintln!("memory_auto rehydrate failed: {e}");
                    }
                });
            }

            app.manage(pool.clone());
            app.manage(state::AppState::default());
            app.manage(state::RuntimeHandles {
                mcp: mcp_manager,
                skills: skill_registry,
                builtins: builtins_runtime,
                memory: memory_store,
                background: background_manager.clone(),
            });

            if let Ok(settings) = tauri::async_runtime::block_on(sqlx::query_as::<_, models::GlobalSettings>(
                "SELECT api_key, base_url_openai, base_url_anthropic, base_url_gemini, tavily_api_key, \
                        web_search_enabled, auto_title_mode, thinking_effort, \
                        workspace_root, auto_approve_readonly, hooks_json, active_model_id, \
                        embedding_provider, embedding_model, embedding_configs_json, \
                        base_url_embedding_common, auto_memory_enabled, quick_launch_enabled, \
                        close_to_tray_enabled \
                 FROM global_settings WHERE id = 1",
            )
            .fetch_one(&pool))
            {
                background_manager.initialize(&handle, &settings);
            }

            // Phase 4 · kick off the Raw-Layer file watcher so drops
            // into ~/.agora/raw/ fire the `wiki-ingest-request` event.
            // Failures inside the watcher are logged but don't block
            // app startup — ingest is a nice-to-have, not critical.
            wiki_watcher::start(handle.clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            conversations::load_conversations,
            conversations::create_conversation,
            conversations::delete_conversation,
            conversations::rename_conversation,
            conversations::update_conversation_title_auto,
            conversations::set_conversation_pinned,
            conversations::set_conversation_mode,
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
            background_cmds::load_background_status,
            background_cmds::perform_background_action,
            background_cmds::perform_launcher_submit,
            background_cmds::hide_launcher_window,
            global_settings_cmds::load_global_settings,
            global_settings_cmds::save_global_settings,
            commands::ai_proxy::proxy_ai_request,
            commands::tool_bridge::list_frontend_tools,
            commands::tool_bridge::invoke_tool,
            commands::permissions::list_permissions,
            commands::permissions::save_permission,
            commands::permissions::delete_permission,
            commands::permissions::check_permission,
            commands::todos::get_todos,
            commands::todos::save_todos,
            commands::agent_md::read_agent_md,
            commands::brand_loader::read_brand,
            commands::brand_loader::read_brand_file,
            commands::brand_loader::write_brand_file,
            commands::brand_loader::get_config_dir,
            commands::memory_active::append_to_memory,
            commands::memory_active::delete_memory_line,
            commands::wiki::list_wiki_pages,
            commands::wiki::read_wiki_page,
            commands::wiki::write_wiki_page,
            commands::wiki::delete_wiki_page,
            commands::wiki::update_wiki_index,
            commands::raw::list_raw_files,
            commands::raw::extract_raw_text,
            paths::resolve_agora_path,
            commands::memory_auto_cmd::add_auto_memory,
            commands::memory_auto_cmd::search_auto_memory,
            commands::memory_auto_cmd::list_auto_memory,
            commands::memory_auto_cmd::delete_auto_memory,
            commands::memory_auto_cmd::clear_auto_memory,
            commands::daily_log::append_daily_log,
            commands::daily_log::read_daily_log,
            commands::daily_log::read_daily_logs_since_last_dreaming,
            commands::daily_log::dreaming_should_run,
            commands::daily_log::mark_dreaming_ran,
            commands::hooks::run_hooks,
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
