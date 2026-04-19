//! Tool permission gate.
//!
//! Built-in tools that can modify the filesystem or execute processes
//! (`write_file`, `edit_file`, `bash`, …) funnel through `check_permission`
//! before the frontend actually dispatches them. Session-level "allow once /
//! this session" lives in memory on the frontend — this module only manages
//! the *persisted* allow/deny rules.

use std::path::{Path, PathBuf};

use globset::GlobBuilder;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;
use crate::models::ToolPermission;
use crate::state::RuntimeHandles;
use crate::tools::BuiltinKind;

/// Outcome returned to the frontend. `Ask` means we need the user to confirm
/// interactively; `Allow`/`Deny` are final.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionCheckResult {
    /// "allow" | "deny" | "ask"
    pub decision: String,
    pub matched_rule: Option<ToolPermission>,
    /// Human-readable reason, surfaced in the approval prompt.
    pub reason: Option<String>,
}

impl PermissionCheckResult {
    fn allow(rule: Option<ToolPermission>, reason: Option<&str>) -> Self {
        Self {
            decision: "allow".into(),
            matched_rule: rule,
            reason: reason.map(str::to_string),
        }
    }
    fn deny(rule: Option<ToolPermission>, reason: Option<&str>) -> Self {
        Self {
            decision: "deny".into(),
            matched_rule: rule,
            reason: reason.map(str::to_string),
        }
    }
    fn ask(reason: Option<&str>) -> Self {
        Self {
            decision: "ask".into(),
            matched_rule: None,
            reason: reason.map(str::to_string),
        }
    }
}

#[tauri::command]
pub async fn list_permissions(
    pool: State<'_, DbPool>,
) -> Result<Vec<ToolPermission>, String> {
    sqlx::query_as::<_, ToolPermission>(
        "SELECT id, tool_name, pattern, decision, created_at \
         FROM tool_permissions ORDER BY created_at DESC",
    )
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_permission(
    pool: State<'_, DbPool>,
    mut perm: ToolPermission,
) -> Result<ToolPermission, String> {
    if perm.tool_name.trim().is_empty() {
        return Err("tool_name is required".into());
    }
    if !matches!(perm.decision.as_str(), "allow" | "deny") {
        return Err(format!("invalid decision `{}`", perm.decision));
    }
    if perm.id.trim().is_empty() {
        perm.id = Uuid::new_v4().to_string();
    }
    if perm.created_at == 0 {
        perm.created_at = now_ms();
    }

    // Upsert by (tool_name, pattern). If an existing row has the same pair,
    // overwrite its decision and bump created_at so the user sees the change
    // at the top of the list. Keep the original id so external references stay
    // stable.
    sqlx::query(
        "INSERT INTO tool_permissions (id, tool_name, pattern, decision, created_at) \
         VALUES (?,?,?,?,?) \
         ON CONFLICT(tool_name, pattern) DO UPDATE SET \
             decision = excluded.decision, \
             created_at = excluded.created_at",
    )
    .bind(&perm.id)
    .bind(&perm.tool_name)
    .bind(&perm.pattern)
    .bind(&perm.decision)
    .bind(perm.created_at)
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    // Return the canonical row (id may differ from what we bound if the
    // conflict branch ran).
    sqlx::query_as::<_, ToolPermission>(
        "SELECT id, tool_name, pattern, decision, created_at \
         FROM tool_permissions WHERE tool_name = ? AND pattern = ?",
    )
    .bind(&perm.tool_name)
    .bind(&perm.pattern)
    .fetch_one(&*pool)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_permission(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    sqlx::query("DELETE FROM tool_permissions WHERE id = ?")
        .bind(&id)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn check_permission(
    pool: State<'_, DbPool>,
    handles: State<'_, RuntimeHandles>,
    tool_name: String,
    input: Value,
) -> Result<PermissionCheckResult, String> {
    let auto_approve: bool = sqlx::query_scalar(
        "SELECT auto_approve_readonly FROM global_settings WHERE id = 1",
    )
    .fetch_one(&*pool)
    .await
    .unwrap_or(true);

    let workspace_root = handles.builtins.workspace_root().await;
    let rules = sqlx::query_as::<_, ToolPermission>(
        "SELECT id, tool_name, pattern, decision, created_at \
         FROM tool_permissions WHERE tool_name = ?",
    )
    .bind(&tool_name)
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(evaluate(
        &tool_name,
        &input,
        workspace_root.as_deref(),
        auto_approve,
        &rules,
    ))
}

/// Pure decision engine, isolated so unit tests don't need the DB.
fn evaluate(
    tool_name: &str,
    input: &Value,
    workspace_root: Option<&Path>,
    auto_approve_readonly: bool,
    rules: &[ToolPermission],
) -> PermissionCheckResult {
    // Fast path: read-only built-ins with auto-approve on.
    if auto_approve_readonly {
        if let Some(kind) = BuiltinKind::from_tool_name(tool_name) {
            if kind.is_readonly() {
                return PermissionCheckResult::allow(None, Some("read-only built-in"));
            }
        }
    }

    // Any filesystem-touching input outside the configured workspace root
    // earns an Ask regardless of stored rules — the user just agreed to
    // scope the agent, so escaping it shouldn't be silent.
    if let Some(root) = workspace_root {
        if let Some(escaping_path) = outside_workspace(input, root) {
            return PermissionCheckResult::ask(Some(&format!(
                "path `{}` is outside the workspace root",
                escaping_path.display()
            )));
        }
    }

    // Deny wins over allow. Iterate twice so a broader allow rule can't
    // mask a narrower deny.
    for rule in rules.iter().filter(|r| r.decision == "deny") {
        if matches_pattern(tool_name, &rule.pattern, input) {
            return PermissionCheckResult::deny(
                Some(rule.clone()),
                Some("matched deny rule"),
            );
        }
    }
    for rule in rules.iter().filter(|r| r.decision == "allow") {
        if matches_pattern(tool_name, &rule.pattern, input) {
            return PermissionCheckResult::allow(
                Some(rule.clone()),
                Some("matched allow rule"),
            );
        }
    }

    PermissionCheckResult::ask(None)
}

/// Does `pattern` match this invocation's input?
///
/// Semantics:
/// - empty pattern → always matches (covers "any call to this tool")
/// - `bash`/`bash_background` → pattern is a shell-style glob against the
///   full command string (spaces allowed in `*`)
/// - everything else → pattern is a path glob against `input.path` (or
///   `input.cwd` as a fallback)
pub fn matches_pattern(tool_name: &str, pattern: &str, input: &Value) -> bool {
    if pattern.is_empty() {
        return true;
    }

    let Ok(matcher) = GlobBuilder::new(pattern)
        .literal_separator(false)
        .build()
    else {
        return false;
    };
    let matcher = matcher.compile_matcher();

    match tool_name {
        "bash" | "bash_background" => {
            let Some(cmd) = input.get("command").and_then(Value::as_str) else {
                return false;
            };
            matcher.is_match(cmd)
        }
        _ => {
            let target = input
                .get("path")
                .and_then(Value::as_str)
                .or_else(|| input.get("cwd").and_then(Value::as_str));
            match target {
                Some(t) => matcher.is_match(t),
                None => false,
            }
        }
    }
}

/// Check whether any path-like input field lives outside the workspace.
/// Returns the offending absolute path for the error message.
fn outside_workspace(input: &Value, root: &Path) -> Option<PathBuf> {
    let candidates = ["path", "cwd"];
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());

    for key in candidates {
        let Some(raw) = input.get(key).and_then(Value::as_str) else {
            continue;
        };
        let p = Path::new(raw);
        // Relative paths resolve inside the root by construction — skip.
        if !p.is_absolute() {
            continue;
        }
        // Use `canonicalize` when possible (handles symlinks, `..`). For
        // non-existing paths fall back to the raw absolute — write targets
        // often don't exist yet.
        let abs = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        if !abs.starts_with(&root) {
            return Some(abs);
        }
    }
    None
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rule(tool: &str, pat: &str, decision: &str) -> ToolPermission {
        ToolPermission {
            id: "id".into(),
            tool_name: tool.into(),
            pattern: pat.into(),
            decision: decision.into(),
            created_at: 0,
        }
    }

    #[test]
    fn readonly_auto_approved() {
        let r = evaluate("read_file", &json!({"path": "a.txt"}), None, true, &[]);
        assert_eq!(r.decision, "allow");
    }

    #[test]
    fn readonly_not_auto_approved_when_toggle_off() {
        let r = evaluate("read_file", &json!({"path": "a.txt"}), None, false, &[]);
        assert_eq!(r.decision, "ask");
    }

    #[test]
    fn path_outside_workspace_asks() {
        let td = tempfile::tempdir().unwrap();
        let r = evaluate(
            "write_file",
            &json!({"path": "/etc/hosts"}),
            Some(td.path()),
            true,
            &[],
        );
        assert_eq!(r.decision, "ask");
        assert!(r.reason.unwrap().contains("outside"));
    }

    #[test]
    fn deny_wins_over_allow() {
        let rules = [
            rule("write_file", "**/.env", "deny"),
            rule("write_file", "**/*", "allow"),
        ];
        let r = evaluate(
            "write_file",
            &json!({"path": "src/.env"}),
            None,
            true,
            &rules,
        );
        assert_eq!(r.decision, "deny");
    }

    #[test]
    fn allow_only_matches_allows() {
        let rules = [rule("write_file", "src/**", "allow")];
        let r = evaluate(
            "write_file",
            &json!({"path": "src/a.ts"}),
            None,
            true,
            &rules,
        );
        assert_eq!(r.decision, "allow");
    }

    #[test]
    fn no_rule_match_asks() {
        let rules = [rule("write_file", "docs/**", "allow")];
        let r = evaluate(
            "write_file",
            &json!({"path": "src/a.ts"}),
            None,
            true,
            &rules,
        );
        assert_eq!(r.decision, "ask");
    }

    #[test]
    fn empty_pattern_matches_anything() {
        let rules = [rule("bash", "", "allow")];
        let r = evaluate(
            "bash",
            &json!({"command": "anything goes"}),
            None,
            true,
            &rules,
        );
        assert_eq!(r.decision, "allow");
    }

    #[test]
    fn bash_glob_matches_across_spaces() {
        let rules = [rule("bash", "git *", "allow")];
        let ok = evaluate(
            "bash",
            &json!({"command": "git status"}),
            None,
            true,
            &rules,
        );
        assert_eq!(ok.decision, "allow");

        let miss = evaluate(
            "bash",
            &json!({"command": "npm install"}),
            None,
            true,
            &rules,
        );
        assert_eq!(miss.decision, "ask");
    }

    #[test]
    fn bash_long_command_still_matches() {
        let rules = [rule("bash", "git *", "allow")];
        let r = evaluate(
            "bash",
            &json!({"command": "git log --oneline -n 20"}),
            None,
            true,
            &rules,
        );
        assert_eq!(r.decision, "allow");
    }
}
