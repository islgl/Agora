//! HTTP proxy that keeps provider API keys Rust-side while letting the
//! Vercel AI SDK (running in the webview) drive requests.
//!
//! Flow:
//!   JS `tauriProxyFetch(url, init)`
//!       → invoke('proxy_ai_request_start', ...)  → returns request_id
//!       → backend streams the upstream body chunks over a `Channel<...>`
//!       → JS assembles the chunks into a `ReadableStream` inside a `Response`
//!
//! API keys are injected by matching the outbound URL against the configured
//! provider base URLs in `global_settings`. Plaintext keys never reach JS.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;

use crate::db::DbPool;

const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Optional header set by callers (currently `embedText`) when the
/// outbound URL doesn't prefix-match any of the Provider-tab base URLs.
/// `api_key_for_url` reads it to pick the right auth header family.
/// Lower-case because we match case-insensitively anyway.
const PROVIDER_HINT_HEADER: &str = "x-agora-provider-hint";

/// Endpoints we've already seen reject `thinking.type.enabled` with the
/// Bedrock "use adaptive" 400. Keyed by request URL; once an endpoint is
/// in this set we rewrite the body pre-emptively on every subsequent
/// request, skipping the 400 + retry round-trip. Cleared on app restart.
static ADAPTIVE_THINKING_HOSTS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

fn endpoint_needs_adaptive(url: &str) -> bool {
    ADAPTIVE_THINKING_HOSTS
        .lock()
        .map(|s| s.contains(url))
        .unwrap_or(false)
}

fn mark_endpoint_adaptive(url: &str) {
    if let Ok(mut s) = ADAPTIVE_THINKING_HOSTS.lock() {
        s.insert(url.to_string());
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRequest {
    pub url: String,
    pub method: String,
    /// Subset of request headers the SDK wants set. API key / auth
    /// headers are added server-side based on URL routing, so callers
    /// should NOT include them here.
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Base64-encoded body. Empty string = no body.
    #[serde(default)]
    pub body_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProxyEvent {
    /// Arrives exactly once, before any `Chunk` events.
    Head {
        status: u16,
        headers: HashMap<String, String>,
    },
    /// A streamed body chunk, base64-encoded so it survives Tauri's JSON IPC.
    Chunk { bytes_base64: String },
    /// Stream finished cleanly.
    End,
    /// Request errored out (before or during streaming). After this no more
    /// events fire.
    Error { message: String },
}

#[tauri::command]
pub async fn proxy_ai_request(
    pool: State<'_, DbPool>,
    request: ProxyRequest,
    on_event: Channel<ProxyEvent>,
) -> Result<(), String> {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;

    let body_bytes = if request.body_base64.is_empty() {
        Vec::new()
    } else {
        BASE64
            .decode(request.body_base64.as_bytes())
            .map_err(|e| format!("invalid body base64: {}", e))?
    };

    // Pull an optional provider hint from the request headers before routing.
    // Callers (currently the embeddings path) set it when their custom base
    // URL doesn't prefix-match any of the Provider-tab URLs so the right
    // API key still gets injected. The header itself is stripped from the
    // upstream request below.
    let provider_hint = request
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(PROVIDER_HINT_HEADER))
        .map(|(_, v)| v.as_str().to_string());

    let (api_key, provider_headers) =
        api_key_for_url(&pool, &request.url, provider_hint.as_deref()).await?;

    let client = reqwest::Client::new();
    let method = match request.method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        "PATCH" => reqwest::Method::PATCH,
        other => {
            let _ = on_event.send(ProxyEvent::Error {
                message: format!("unsupported method: {}", other),
            });
            return Err(format!("unsupported method: {}", other));
        }
    };

    let build_request = |body: Vec<u8>| {
        let mut b = client.request(method.clone(), &request.url);
        for (k, v) in provider_headers.iter() {
            b = b.header(k, v);
        }
        for (k, v) in request.headers.iter() {
            let k_lower = k.to_ascii_lowercase();
            if k_lower == "authorization"
                || k_lower == "x-api-key"
                || k_lower == "x-goog-api-key"
                || k_lower == PROVIDER_HINT_HEADER
            {
                continue;
            }
            b = b.header(k, v);
        }
        if request.url.contains("/v1/messages")
            && !request
                .headers
                .keys()
                .any(|k| k.eq_ignore_ascii_case("anthropic-version"))
        {
            b = b.header("anthropic-version", ANTHROPIC_VERSION);
        }
        if !body.is_empty() {
            b = b.body(body);
        }
        b
    };

    let _ = api_key; // silenced: key usage lives in provider_headers above

    // If we've already learned this endpoint requires adaptive thinking,
    // rewrite the body pre-emptively instead of eating a 400 + retry.
    let initial_body =
        if request.url.contains("/v1/messages") && endpoint_needs_adaptive(&request.url) {
            rewrite_thinking_adaptive(&body_bytes).unwrap_or_else(|| body_bytes.clone())
        } else {
            body_bytes.clone()
        };

    let mut response = match build_request(initial_body).send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(ProxyEvent::Error {
                message: format!("upstream request failed: {}", e),
            });
            return Err(e.to_string());
        }
    };

    // Bedrock adaptive thinking fallback. Some gateways route Anthropic
    // traffic through AWS Bedrock, which rejects `thinking.type.enabled` +
    // `budget_tokens` and asks for `thinking.type.adaptive` +
    // `output_config.effort` instead. We detect that specific 400, rewrite
    // the body, and retry once before giving up.
    if response.status().is_client_error() && request.url.contains("/v1/messages") {
        let status = response.status();
        let err_body = response.text().await.unwrap_or_default();
        // Always log the upstream error so we can tell adaptive-required
        // 400s apart from everything else — the earlier heuristic of
        // "body contains the substring 'adaptive'" false-positive'd on
        // any unrelated 400 that happened to mention it in an error
        // message or hint text, silently swallowing the real reason.
        eprintln!(
            "[agora] proxy: upstream 4xx on /v1/messages ({}): {}",
            status, err_body
        );
        // Narrow the heuristic: require *both* "thinking" and "adaptive"
        // to appear, which matches the Bedrock Anthropic-compat error
        // ("thinking type ... adaptive ...") while ruling out unrelated
        // 400s that just happen to contain one word.
        let looks_like_bedrock_thinking =
            err_body.contains("adaptive") && err_body.contains("thinking");
        if looks_like_bedrock_thinking {
            if let Some(rewritten) = rewrite_thinking_adaptive(&body_bytes) {
                eprintln!(
                    "[agora] proxy: retrying Anthropic request with adaptive thinking (status was {})",
                    status
                );
                // Remember this endpoint so future requests skip the 400.
                mark_endpoint_adaptive(&request.url);
                response = match build_request(rewritten).send().await {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = on_event.send(ProxyEvent::Error {
                            message: format!("adaptive retry failed: {}", e),
                        });
                        return Err(e.to_string());
                    }
                };
            } else {
                // No thinking field in body — can't rewrite; surface the
                // original error by reconstructing a failing response stub.
                let _ = on_event.send(ProxyEvent::Head {
                    status: status.as_u16(),
                    headers: HashMap::new(),
                });
                let _ = on_event.send(ProxyEvent::Chunk {
                    bytes_base64: base64::engine::general_purpose::STANDARD
                        .encode(err_body.as_bytes()),
                });
                let _ = on_event.send(ProxyEvent::End);
                return Ok(());
            }
        } else {
            // Not a Bedrock-adaptive error — reconstruct the stream so the
            // SDK can parse whatever error body the upstream returned.
            let _ = on_event.send(ProxyEvent::Head {
                status: status.as_u16(),
                headers: HashMap::new(),
            });
            let _ = on_event.send(ProxyEvent::Chunk {
                bytes_base64: base64::engine::general_purpose::STANDARD.encode(err_body.as_bytes()),
            });
            let _ = on_event.send(ProxyEvent::End);
            return Ok(());
        }
    }

    let status = response.status().as_u16();
    let mut headers_map: HashMap<String, String> = HashMap::new();
    for (k, v) in response.headers().iter() {
        if let Ok(vs) = v.to_str() {
            headers_map.insert(k.as_str().to_string(), vs.to_string());
        }
    }
    let _ = on_event.send(ProxyEvent::Head {
        status,
        headers: headers_map,
    });

    let mut stream = response.bytes_stream();
    while let Some(result) = stream.next().await {
        match result {
            Ok(bytes) => {
                if bytes.is_empty() {
                    continue;
                }
                let encoded = BASE64.encode(&bytes);
                let _ = on_event.send(ProxyEvent::Chunk {
                    bytes_base64: encoded,
                });
            }
            Err(e) => {
                let _ = on_event.send(ProxyEvent::Error {
                    message: format!("stream error: {}", e),
                });
                return Err(e.to_string());
            }
        }
    }

    let _ = on_event.send(ProxyEvent::End);
    Ok(())
}

/// Rewrite an Anthropic messages body so Bedrock's thinking shape is used:
///   `thinking: { type: "enabled", budget_tokens: N }`
/// becomes
///   `thinking: { type: "adaptive" }`
///   `output_config: { effort: "low" | "medium" | "high" }`
/// Returns `None` if no rewrite is applicable (no `thinking` field).
fn rewrite_thinking_adaptive(body: &[u8]) -> Option<Vec<u8>> {
    let mut parsed: Value = serde_json::from_slice(body).ok()?;
    let obj = parsed.as_object_mut()?;
    let thinking = obj.get_mut("thinking")?;
    let thinking_obj = thinking.as_object()?;

    // Only rewrite `enabled` shape. If already adaptive, do nothing.
    if thinking_obj.get("type").and_then(|v| v.as_str()) != Some("enabled") {
        return None;
    }
    let budget = thinking_obj
        .get("budget_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // Bucket the numeric budget into low / medium / high.
    let effort = if budget == 0 {
        "low"
    } else if budget <= 4_096 {
        "low"
    } else if budget <= 16_384 {
        "medium"
    } else {
        "high"
    };

    *thinking = serde_json::json!({ "type": "adaptive" });
    obj.insert(
        "output_config".to_string(),
        serde_json::json!({ "effort": effort }),
    );

    serde_json::to_vec(&parsed).ok()
}

/// Match the outbound URL against the three configured provider base URLs
/// and return (api_key, headers_to_inject). Returns empty headers if the
/// URL doesn't match any provider — the request still goes through,
/// helpful for things like the AI SDK calling a gateway introspection
/// endpoint we don't recognize.
async fn api_key_for_url(
    pool: &DbPool,
    url: &str,
    provider_hint: Option<&str>,
) -> Result<(Option<String>, HashMap<String, String>), String> {
    #[derive(sqlx::FromRow)]
    struct Settings {
        api_key: String,
        base_url_openai: String,
        base_url_anthropic: String,
        base_url_gemini: String,
        base_url_embedding_common: String,
    }

    let s: Settings = sqlx::query_as(
        "SELECT api_key, base_url_openai, base_url_anthropic, base_url_gemini, \
                base_url_embedding_common \
         FROM global_settings WHERE id = 1",
    )
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut headers = HashMap::new();

    let matches_prefix = |base: &str| -> bool {
        let trimmed = base.trim_end_matches('/');
        if trimmed.is_empty() {
            return false;
        }
        url.starts_with(trimmed)
    };

    // Embedding URL takes precedence — if the user has a dedicated
    // embedding endpoint configured, route auth to OpenAI (the only
    // embedding provider today) before falling through to the chat URLs.
    if matches_prefix(&s.base_url_embedding_common) {
        if !s.api_key.is_empty() {
            headers.insert("authorization".into(), format!("Bearer {}", s.api_key));
        }
        return Ok((Some(s.api_key), headers));
    }

    if matches_prefix(&s.base_url_anthropic) {
        if !s.api_key.is_empty() {
            headers.insert("x-api-key".into(), s.api_key.clone());
        }
        headers.insert("anthropic-version".into(), ANTHROPIC_VERSION.into());
        return Ok((Some(s.api_key), headers));
    }
    if matches_prefix(&s.base_url_openai) {
        if !s.api_key.is_empty() {
            headers.insert("authorization".into(), format!("Bearer {}", s.api_key));
        }
        return Ok((Some(s.api_key), headers));
    }
    if matches_prefix(&s.base_url_gemini) {
        if !s.api_key.is_empty() {
            headers.insert("x-goog-api-key".into(), s.api_key.clone());
        }
        return Ok((Some(s.api_key), headers));
    }

    // URL didn't match any configured provider. Fall back to the explicit
    // provider hint (set by e.g. the embeddings path when pointing at a
    // custom endpoint) so the shared API key still lands in the right
    // auth header.
    if let Some(hint) = provider_hint {
        match hint.to_ascii_lowercase().as_str() {
            "anthropic" => {
                if !s.api_key.is_empty() {
                    headers.insert("x-api-key".into(), s.api_key.clone());
                }
                headers.insert("anthropic-version".into(), ANTHROPIC_VERSION.into());
                return Ok((Some(s.api_key), headers));
            }
            "openai" => {
                if !s.api_key.is_empty() {
                    headers.insert("authorization".into(), format!("Bearer {}", s.api_key));
                }
                return Ok((Some(s.api_key), headers));
            }
            "gemini" | "google" => {
                if !s.api_key.is_empty() {
                    headers.insert("x-goog-api-key".into(), s.api_key.clone());
                }
                return Ok((Some(s.api_key), headers));
            }
            _ => {}
        }
    }

    // No match and no hint — forward verbatim. The SDK may be hitting a
    // custom endpoint the user configured to handle its own auth.
    Ok((None, headers))
}
