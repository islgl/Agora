//! One-shot, non-streaming helper that asks the active model to produce a
//! short 3-6 word title for a conversation. Very tight token budget; runs
//! in the background after a turn finalizes.

use serde_json::{json, Value};
use std::time::Duration;

use crate::models::{Message, ModelConfig, Provider, Role};

const ANTHROPIC_VERSION: &str = "2023-06-01";
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_TOKENS: u32 = 32;

const SYSTEM_PROMPT: &str = "\
You write very short titles for chat conversations. Given the opening turns, \
respond with ONLY a 3-6 word title that captures the main topic. \
No quotes, no trailing punctuation, no prefixes like 'Title:'. Title case.";

#[tauri::command]
pub async fn summarize_conversation_title(
    model_config: ModelConfig,
    messages: Vec<Message>,
) -> Result<String, String> {
    if model_config.api_key.trim().is_empty() || model_config.base_url.trim().is_empty() {
        return Err("model not configured".into());
    }

    // Take up to the first 4 non-system messages — title should reflect the
    // original intent, not where a long chat drifts to.
    let trimmed: Vec<&Message> = messages
        .iter()
        .filter(|m| !matches!(m.role, Role::System))
        .take(4)
        .collect();
    if trimmed.is_empty() {
        return Err("no messages to summarize".into());
    }
    let transcript = trimmed
        .iter()
        .map(|m| {
            let role = match m.role {
                Role::User => "User",
                Role::Assistant => "Assistant",
                Role::System => "System",
            };
            // Cap each message at 600 chars so prompts stay cheap.
            let body = truncate(&m.content, 600);
            format!("{}: {}", role, body)
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let raw = match model_config.provider {
        Provider::Openai => call_openai(&model_config, &transcript).await,
        Provider::Anthropic => call_anthropic(&model_config, &transcript).await,
        Provider::Gemini => call_gemini(&model_config, &transcript).await,
    }?;

    Ok(sanitize_title(&raw))
}

async fn call_openai(cfg: &ModelConfig, transcript: &str) -> Result<String, String> {
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user",   "content": transcript },
        ],
        "max_tokens": MAX_TOKENS,
        "stream": false,
    });
    let resp = http_client()?
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: Value = read_json(resp).await?;
    Ok(json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string())
}

async fn call_anthropic(cfg: &ModelConfig, transcript: &str) -> Result<String, String> {
    let url = format!("{}/v1/messages", cfg.base_url.trim_end_matches('/'));
    let body = json!({
        "model": cfg.model,
        "system": SYSTEM_PROMPT,
        "messages": [
            { "role": "user", "content": transcript },
        ],
        "max_tokens": MAX_TOKENS,
    });
    let resp = http_client()?
        .post(&url)
        .header("x-api-key", &cfg.api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: Value = read_json(resp).await?;
    Ok(json["content"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string())
}

async fn call_gemini(cfg: &ModelConfig, transcript: &str) -> Result<String, String> {
    let url = format!(
        "{}/v1beta/models/{}:generateContent",
        cfg.base_url.trim_end_matches('/'),
        cfg.model,
    );
    let body = json!({
        "systemInstruction": { "parts": [{ "text": SYSTEM_PROMPT }] },
        "contents": [
            { "role": "user", "parts": [{ "text": transcript }] },
        ],
        "generationConfig": { "maxOutputTokens": MAX_TOKENS },
    });
    let resp = http_client()?
        .post(&url)
        .header("x-goog-api-key", &cfg.api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: Value = read_json(resp).await?;
    Ok(json["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

async fn read_json(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, truncate(&text, 300)));
    }
    serde_json::from_str::<Value>(&text).map_err(|e| format!("bad json: {}", e))
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}

fn sanitize_title(raw: &str) -> String {
    let trimmed = raw
        .trim()
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '「' || c == '」')
        .trim_start_matches("Title:")
        .trim_start_matches("title:")
        .trim();
    // Drop trailing punctuation most models like to append.
    let cleaned = trimmed.trim_end_matches(|c: char| ".。!?".contains(c));
    // Keep it to the first line just in case.
    cleaned
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .chars()
        .take(120)
        .collect()
}
