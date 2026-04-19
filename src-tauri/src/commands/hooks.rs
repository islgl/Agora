//! Phase E · user-defined hooks.
//!
//! Simple pre/post tool-use lifecycle hooks driven by a JSON blob stored in
//! `global_settings.hooks_json`. Each entry is `{matcher, command, failMode}`
//! where `matcher` is a tool name (or `*` for any) and `command` is passed
//! to `/bin/sh -c`. The hook receives `HOOK_EVENT`, `TOOL_NAME`,
//! `TOOL_INPUT` (JSON), and for post-hooks `TOOL_OUTPUT` (JSON) as env vars.
//!
//! Fail modes:
//! - `block` — a non-zero exit aborts the tool call (preToolUse only; post
//!   hooks log the error but can't un-invoke the tool).
//! - `warn`  — non-zero exits propagate as a warning but don't block.
//! - `ignore` — outcome is swallowed.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use tokio::process::Command;

use crate::db::DbPool;

/// Per-hook timeout — the user's shell command shouldn't be able to stall
/// every tool call indefinitely.
const HOOK_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookEntry {
    pub matcher: String,
    pub command: String,
    #[serde(default = "default_fail_mode")]
    pub fail_mode: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookConfig {
    #[serde(default)]
    pub pre_tool_use: Vec<HookEntry>,
    #[serde(default)]
    pub post_tool_use: Vec<HookEntry>,
}

fn default_fail_mode() -> String {
    "warn".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookOutcome {
    pub matcher: String,
    pub fail_mode: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    /// Present when `fail_mode == "block"` and the hook failed — the
    /// frontend propagates this as the reason the tool call was cancelled.
    pub blocked: bool,
}

#[tauri::command]
pub async fn run_hooks(
    pool: State<'_, DbPool>,
    event: String,
    tool_name: String,
    input: Value,
    output: Option<Value>,
) -> Result<Vec<HookOutcome>, String> {
    if !matches!(event.as_str(), "preToolUse" | "postToolUse") {
        return Err(format!("unknown hook event `{}`", event));
    }

    let json: String = sqlx::query_scalar(
        "SELECT hooks_json FROM global_settings WHERE id = 1",
    )
    .fetch_optional(&*pool)
    .await
    .map_err(|e| e.to_string())?
    .unwrap_or_else(|| "{}".to_string());

    let cfg: HookConfig = match serde_json::from_str(&json) {
        Ok(c) => c,
        Err(_) => HookConfig::default(),
    };
    let entries = match event.as_str() {
        "preToolUse" => cfg.pre_tool_use,
        "postToolUse" => cfg.post_tool_use,
        _ => unreachable!(),
    };

    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOOK_EVENT".into(), event.clone());
    env.insert("TOOL_NAME".into(), tool_name.clone());
    env.insert(
        "TOOL_INPUT".into(),
        serde_json::to_string(&input).unwrap_or_default(),
    );
    if let Some(out) = &output {
        env.insert(
            "TOOL_OUTPUT".into(),
            serde_json::to_string(out).unwrap_or_default(),
        );
    }

    let mut outcomes = Vec::new();
    for entry in entries {
        if !matches_tool(&entry.matcher, &tool_name) {
            continue;
        }
        let outcome = run_one(&entry, &env).await;
        outcomes.push(outcome);
    }
    Ok(outcomes)
}

/// Exact match, or `*` as a wildcard. Kept intentionally simple — regex
/// grammar tends to invite footguns in config files users edit by hand.
fn matches_tool(matcher: &str, tool_name: &str) -> bool {
    matcher == "*" || matcher == tool_name
}

async fn run_one(entry: &HookEntry, env: &HashMap<String, String>) -> HookOutcome {
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg(&entry.command).envs(env);
    let child = match cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(err) => {
            let blocked = entry.fail_mode == "block";
            return HookOutcome {
                matcher: entry.matcher.clone(),
                fail_mode: entry.fail_mode.clone(),
                exit_code: None,
                success: false,
                stdout: String::new(),
                stderr: format!("spawn failed: {err}"),
                timed_out: false,
                blocked,
            };
        }
    };

    let output_fut = child.wait_with_output();
    let outcome = tokio::time::timeout(
        Duration::from_secs(HOOK_TIMEOUT_SECS),
        output_fut,
    )
    .await;

    match outcome {
        Ok(Ok(out)) => {
            let success = out.status.success();
            let blocked = !success && entry.fail_mode == "block";
            HookOutcome {
                matcher: entry.matcher.clone(),
                fail_mode: entry.fail_mode.clone(),
                exit_code: out.status.code(),
                success,
                stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                timed_out: false,
                blocked,
            }
        }
        Ok(Err(err)) => HookOutcome {
            matcher: entry.matcher.clone(),
            fail_mode: entry.fail_mode.clone(),
            exit_code: None,
            success: false,
            stdout: String::new(),
            stderr: format!("wait failed: {err}"),
            timed_out: false,
            blocked: entry.fail_mode == "block",
        },
        Err(_elapsed) => HookOutcome {
            matcher: entry.matcher.clone(),
            fail_mode: entry.fail_mode.clone(),
            exit_code: None,
            success: false,
            stdout: String::new(),
            stderr: format!("hook timed out after {HOOK_TIMEOUT_SECS}s"),
            timed_out: true,
            blocked: entry.fail_mode == "block",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_matches_anything() {
        assert!(matches_tool("*", "bash"));
        assert!(matches_tool("*", "read_file"));
    }

    #[test]
    fn exact_match() {
        assert!(matches_tool("bash", "bash"));
        assert!(!matches_tool("bash", "read_file"));
    }

    #[test]
    fn empty_config_parses_default() {
        let cfg: HookConfig = serde_json::from_str("{}").unwrap();
        assert!(cfg.pre_tool_use.is_empty());
        assert!(cfg.post_tool_use.is_empty());
    }

    #[test]
    fn parses_sample_config() {
        let json = r#"{
            "preToolUse": [
                {"matcher": "bash", "command": "echo pre", "failMode": "block"}
            ],
            "postToolUse": [
                {"matcher": "*", "command": "echo post"}
            ]
        }"#;
        let cfg: HookConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.pre_tool_use.len(), 1);
        assert_eq!(cfg.pre_tool_use[0].matcher, "bash");
        assert_eq!(cfg.pre_tool_use[0].fail_mode, "block");
        assert_eq!(cfg.post_tool_use.len(), 1);
        assert_eq!(cfg.post_tool_use[0].fail_mode, "warn"); // defaulted
    }

    #[tokio::test]
    async fn runs_echo_and_captures_env() {
        let entry = HookEntry {
            matcher: "bash".into(),
            command: "printf '%s|%s' \"$TOOL_NAME\" \"$HOOK_EVENT\"".into(),
            fail_mode: "warn".into(),
        };
        let mut env = HashMap::new();
        env.insert("TOOL_NAME".into(), "bash".into());
        env.insert("HOOK_EVENT".into(), "preToolUse".into());
        let out = run_one(&entry, &env).await;
        assert!(out.success);
        assert_eq!(out.stdout, "bash|preToolUse");
    }

    #[tokio::test]
    async fn failing_hook_with_block_mode_is_blocked() {
        let entry = HookEntry {
            matcher: "*".into(),
            command: "exit 1".into(),
            fail_mode: "block".into(),
        };
        let env = HashMap::new();
        let out = run_one(&entry, &env).await;
        assert!(!out.success);
        assert!(out.blocked);
    }

    #[tokio::test]
    async fn failing_hook_with_warn_mode_is_not_blocked() {
        let entry = HookEntry {
            matcher: "*".into(),
            command: "exit 1".into(),
            fail_mode: "warn".into(),
        };
        let env = HashMap::new();
        let out = run_one(&entry, &env).await;
        assert!(!out.success);
        assert!(!out.blocked);
    }
}
