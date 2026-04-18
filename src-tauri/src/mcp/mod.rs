#![allow(dead_code)]

pub mod config;

use std::collections::HashMap;
use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, CallToolResult, ClientCapabilities, ClientInfo, Implementation,
    RawContent, Tool as McpTool,
};
use rmcp::service::RunningService;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{RoleClient, ServiceExt};
use serde_json::{Map, Value};
use tokio::process::Command;
use tokio::sync::RwLock;

use crate::tools::{ToolCall, ToolResult, ToolSource, ToolSpec};

pub use config::{McpServerConfig, McpTransport};

pub type SharedMcpManager = Arc<McpManager>;

type ClientHandle = RunningService<RoleClient, ClientInfo>;

struct ConnectedServer {
    config: McpServerConfig,
    client: ClientHandle,
    tools: Vec<McpTool>,
}

#[derive(Default)]
pub struct McpManager {
    inner: RwLock<Inner>,
}

#[derive(Default)]
struct Inner {
    servers: HashMap<String, ConnectedServer>,
}

impl McpManager {
    pub fn new() -> SharedMcpManager {
        Arc::new(Self::default())
    }

    /// Bring all `enabled` configs online. Failures don't abort the batch —
    /// one broken server shouldn't block the rest.
    pub async fn connect_all(&self, configs: Vec<McpServerConfig>) {
        let mut inner = self.inner.write().await;
        for cfg in configs.into_iter().filter(|c| c.enabled) {
            match connect_one(&cfg).await {
                Ok(server) => {
                    inner.servers.insert(cfg.id.clone(), server);
                }
                Err(e) => {
                    eprintln!("MCP server {} failed to connect: {}", cfg.name, e);
                }
            }
        }
    }

    pub async fn reconnect(&self, cfg: McpServerConfig) -> Result<usize, String> {
        self.disconnect(&cfg.id).await;
        if !cfg.enabled {
            return Ok(0);
        }
        let server = connect_one(&cfg).await?;
        let tool_count = server.tools.len();
        let mut inner = self.inner.write().await;
        inner.servers.insert(cfg.id.clone(), server);
        Ok(tool_count)
    }

    pub async fn disconnect(&self, id: &str) {
        let maybe = {
            let mut inner = self.inner.write().await;
            inner.servers.remove(id)
        };
        if let Some(server) = maybe {
            let _ = server.client.cancel().await;
        }
    }

    pub async fn list_tools(&self) -> Vec<ToolSpec> {
        let inner = self.inner.read().await;
        let mut out = Vec::new();
        for (id, srv) in inner.servers.iter() {
            for t in &srv.tools {
                out.push(ToolSpec {
                    name: prefixed(id, &t.name),
                    description: t
                        .description
                        .as_ref()
                        .map(|c| c.to_string())
                        .unwrap_or_default(),
                    input_schema: Value::Object((*t.input_schema).clone()),
                    source: ToolSource::Mcp {
                        server_id: id.clone(),
                        original_name: t.name.to_string(),
                    },
                });
            }
        }
        out
    }

    pub async fn invoke(&self, call: &ToolCall) -> ToolResult {
        let Some((server_id, original)) = split_prefix(&call.name) else {
            return ToolResult::err(&call.id, format!("Malformed MCP tool name: {}", call.name));
        };

        let mut params = CallToolRequestParams::new(original);
        if let Some(args_map) = value_to_map(&call.input) {
            params = params.with_arguments(args_map);
        }

        let result = {
            let inner = self.inner.read().await;
            let Some(srv) = inner.servers.get(&server_id) else {
                return ToolResult::err(
                    &call.id,
                    format!("MCP server '{}' is not connected", server_id),
                );
            };
            srv.client.call_tool(params).await
        };

        match result {
            Ok(r) => flatten_result(&call.id, r),
            Err(e) => ToolResult::err(&call.id, format!("MCP call failed: {}", e)),
        }
    }
}

async fn connect_one(cfg: &McpServerConfig) -> Result<ConnectedServer, String> {
    let client = match cfg.transport {
        McpTransport::Stdio => {
            let cmd_str = cfg
                .command
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "stdio transport requires a command".to_string())?;

            let mut cmd = if cfg.login_shell {
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
                let combined = std::iter::once(cmd_str.to_string())
                    .chain(cfg.args.iter().cloned())
                    .collect::<Vec<_>>()
                    .join(" ");
                let mut c = Command::new(shell);
                c.arg("-lc").arg(combined);
                c
            } else {
                let mut c = Command::new(cmd_str);
                for a in &cfg.args {
                    c.arg(a);
                }
                c
            };
            for (k, v) in &cfg.env {
                cmd.env(k, v);
            }
            let transport = TokioChildProcess::new(cmd).map_err(|e| e.to_string())?;
            let info = default_client_info();
            info.serve(transport).await.map_err(|e| e.to_string())?
        }
        McpTransport::Http | McpTransport::Sse => {
            let url = cfg
                .url
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "http/sse transport requires a url".to_string())?;
            let transport = StreamableHttpClientTransport::from_uri(url.to_string());
            let info = default_client_info();
            info.serve(transport).await.map_err(|e| e.to_string())?
        }
    };

    let list = client
        .list_all_tools()
        .await
        .map_err(|e| format!("list_tools failed: {}", e))?;
    Ok(ConnectedServer {
        config: cfg.clone(),
        client,
        tools: list,
    })
}

fn default_client_info() -> ClientInfo {
    ClientInfo::new(
        ClientCapabilities::default(),
        Implementation::new("agora", env!("CARGO_PKG_VERSION")),
    )
}

fn prefixed(server_id: &str, tool_name: &str) -> String {
    format!("mcp__{}__{}", server_id, tool_name)
}

fn split_prefix(name: &str) -> Option<(String, String)> {
    let stripped = name.strip_prefix("mcp__")?;
    let idx = stripped.find("__")?;
    let (server_id, rest) = stripped.split_at(idx);
    Some((server_id.to_string(), rest[2..].to_string()))
}

fn value_to_map(v: &Value) -> Option<Map<String, Value>> {
    match v {
        Value::Object(m) => Some(m.clone()),
        Value::Null => None,
        other => {
            let mut m = Map::new();
            m.insert("value".into(), other.clone());
            Some(m)
        }
    }
}

fn flatten_result(call_id: &str, result: CallToolResult) -> ToolResult {
    let mut buf = String::new();
    for c in &result.content {
        let snippet = match &c.raw {
            RawContent::Text(t) => t.text.clone(),
            RawContent::Image(_) => "[image]".to_string(),
            RawContent::Resource(_) => "[resource]".to_string(),
            RawContent::Audio(_) => "[audio]".to_string(),
            _ => String::new(),
        };
        if snippet.is_empty() {
            continue;
        }
        if !buf.is_empty() {
            buf.push('\n');
        }
        buf.push_str(&snippet);
    }
    ToolResult {
        call_id: call_id.to_string(),
        content: if buf.is_empty() {
            "(empty)".into()
        } else {
            buf
        },
        is_error: result.is_error.unwrap_or(false),
    }
}
