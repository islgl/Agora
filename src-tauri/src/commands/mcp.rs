use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;
use crate::mcp::{McpServerConfig, McpTransport};
use crate::state::RuntimeHandles;

#[tauri::command]
pub async fn load_mcp_servers(pool: State<'_, DbPool>) -> Result<Vec<McpServerConfig>, String> {
    let rows = sqlx::query_as::<_, McpServerRow>(
        "SELECT id, name, transport, command, args_json, env_json, url, headers_json, \
                login_shell, enabled, created_at \
         FROM mcp_servers ORDER BY created_at ASC",
    )
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(McpServerRow::into_config).collect())
}

#[tauri::command]
pub async fn save_mcp_server(
    pool: State<'_, DbPool>,
    handles: State<'_, RuntimeHandles>,
    mut server: McpServerConfig,
) -> Result<McpServerConfig, String> {
    if server.id.is_empty() {
        server.id = Uuid::new_v4().to_string();
        server.created_at = now_ms();
    }

    let args_json = serde_json::to_string(&server.args).map_err(|e| e.to_string())?;
    let env_json = serde_json::to_string(&server.env).map_err(|e| e.to_string())?;
    let headers_json = serde_json::to_string(&server.headers).map_err(|e| e.to_string())?;
    let transport_str = match server.transport {
        McpTransport::Stdio => "stdio",
        McpTransport::Http => "http",
        McpTransport::Sse => "sse",
    };

    sqlx::query(
        "INSERT INTO mcp_servers (id, name, transport, command, args_json, env_json, \
                                  url, headers_json, login_shell, enabled, created_at) \
         VALUES (?,?,?,?,?,?,?,?,?,?,?) \
         ON CONFLICT(id) DO UPDATE SET \
             name = excluded.name, transport = excluded.transport, \
             command = excluded.command, args_json = excluded.args_json, \
             env_json = excluded.env_json, url = excluded.url, \
             headers_json = excluded.headers_json, login_shell = excluded.login_shell, \
             enabled = excluded.enabled",
    )
    .bind(&server.id)
    .bind(&server.name)
    .bind(transport_str)
    .bind(server.command.as_deref())
    .bind(&args_json)
    .bind(&env_json)
    .bind(server.url.as_deref())
    .bind(&headers_json)
    .bind(server.login_shell)
    .bind(server.enabled)
    .bind(server.created_at)
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    // Reconnect in the background so the save returns quickly and errors get
    // surfaced through `test_mcp_server` when the user wants verification.
    let mcp = handles.mcp.clone();
    let cfg_clone = server.clone();
    tokio::spawn(async move {
        if let Err(e) = mcp.reconnect(cfg_clone).await {
            eprintln!("reconnect after save failed: {}", e);
        }
    });

    Ok(server)
}

#[tauri::command]
pub async fn delete_mcp_server(
    pool: State<'_, DbPool>,
    handles: State<'_, RuntimeHandles>,
    id: String,
) -> Result<(), String> {
    sqlx::query("DELETE FROM mcp_servers WHERE id = ?")
        .bind(&id)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    handles.mcp.disconnect(&id).await;
    Ok(())
}

/// Connect (or reconnect) in the foreground and return the resulting tool
/// count. Errors bubble up so the UI can show them.
#[tauri::command]
pub async fn test_mcp_server(
    handles: State<'_, RuntimeHandles>,
    server: McpServerConfig,
) -> Result<usize, String> {
    handles.mcp.reconnect(server).await
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(sqlx::FromRow)]
pub struct McpServerRow {
    id: String,
    name: String,
    transport: String,
    command: Option<String>,
    args_json: String,
    env_json: String,
    url: Option<String>,
    headers_json: String,
    login_shell: bool,
    enabled: bool,
    created_at: i64,
}

impl McpServerRow {
    pub fn into_config(self) -> McpServerConfig {
        let transport = match self.transport.as_str() {
            "http" => McpTransport::Http,
            "sse" => McpTransport::Sse,
            _ => McpTransport::Stdio,
        };
        McpServerConfig {
            id: self.id,
            name: self.name,
            transport,
            command: self.command,
            args: serde_json::from_str(&self.args_json).unwrap_or_default(),
            env: serde_json::from_str(&self.env_json).unwrap_or_default(),
            url: self.url,
            headers: serde_json::from_str(&self.headers_json).unwrap_or_default(),
            login_shell: self.login_shell,
            enabled: self.enabled,
            created_at: self.created_at,
        }
    }
}
