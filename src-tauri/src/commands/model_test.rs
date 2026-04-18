//! Connectivity probe for a `ModelConfig`. Sends the smallest possible
//! non-streaming request to the provider to confirm api key + base url +
//! model name are all valid. Errors bubble up with the HTTP body so users
//! can debug gateway issues directly from the Models tab.

use serde_json::json;
use std::time::Duration;

use crate::models::{ModelConfig, Provider};

const ANTHROPIC_VERSION: &str = "2023-06-01";
const TIMEOUT: Duration = Duration::from_secs(20);

#[tauri::command]
pub async fn test_model_config(model_config: ModelConfig) -> Result<String, String> {
    if model_config.api_key.trim().is_empty() {
        return Err("API key is empty — set one in Settings → Providers".into());
    }
    if model_config.base_url.trim().is_empty() {
        return Err("Base URL is empty".into());
    }
    if model_config.model.trim().is_empty() {
        return Err("Model ID is empty".into());
    }

    match model_config.provider {
        Provider::Openai => test_openai(&model_config).await,
        Provider::Anthropic => test_anthropic(&model_config).await,
        Provider::Gemini => test_gemini(&model_config).await,
    }
}

async fn test_openai(cfg: &ModelConfig) -> Result<String, String> {
    let url = format!(
        "{}/chat/completions",
        cfg.base_url.trim_end_matches('/')
    );
    let body = json!({
        "model": cfg.model,
        "messages": [{ "role": "user", "content": "hi" }],
        "max_tokens": 1,
        "stream": false,
    });
    let resp = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;
    check_ok(resp, &cfg.model).await
}

async fn test_anthropic(cfg: &ModelConfig) -> Result<String, String> {
    let url = format!("{}/v1/messages", cfg.base_url.trim_end_matches('/'));
    let body = json!({
        "model": cfg.model,
        "messages": [{ "role": "user", "content": "hi" }],
        "max_tokens": 1,
    });
    let resp = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?
        .post(&url)
        .header("x-api-key", &cfg.api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;
    check_ok(resp, &cfg.model).await
}

async fn test_gemini(cfg: &ModelConfig) -> Result<String, String> {
    let url = format!(
        "{}/v1beta/models/{}:generateContent",
        cfg.base_url.trim_end_matches('/'),
        cfg.model,
    );
    let body = json!({
        "contents": [{ "role": "user", "parts": [{ "text": "hi" }] }],
        "generationConfig": { "maxOutputTokens": 1 },
    });
    let resp = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?
        .post(&url)
        .header("x-goog-api-key", &cfg.api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;
    check_ok(resp, &cfg.model).await
}

async fn check_ok(resp: reqwest::Response, model: &str) -> Result<String, String> {
    let status = resp.status();
    if status.is_success() {
        return Ok(format!("{} · connection OK", model));
    }
    let body = resp.text().await.unwrap_or_default();
    let snippet = body.chars().take(400).collect::<String>();
    Err(format!("HTTP {}: {}", status, snippet))
}
