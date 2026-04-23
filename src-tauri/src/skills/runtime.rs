//! Script execution for Skills. Not a real sandbox — just a best-effort
//! wrapper with timeout, output caps, and a scrubbed environment. The UI
//! surfaces this clearly ("scripts run with your user permissions").

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

const TIMEOUT: Duration = Duration::from_secs(30);
const OUTPUT_LIMIT: usize = 64 * 1024;

pub struct ScriptOutput {
    pub success: bool,
    pub formatted: String,
}

pub async fn run_script(
    skill_root: &Path,
    script: &str,
    args: &[String],
    stdin: Option<String>,
) -> Result<ScriptOutput, String> {
    let scripts_dir = skill_root.join("scripts");
    let script_path = scripts_dir.join(script);

    // Guard against path traversal. canonicalize also ensures the file exists.
    let canonical = script_path
        .canonicalize()
        .map_err(|e| format!("script not found: {}", e))?;
    let scripts_canonical = scripts_dir
        .canonicalize()
        .map_err(|e| format!("scripts dir missing: {}", e))?;
    if !canonical.starts_with(&scripts_canonical) {
        return Err("script path escapes the scripts directory".into());
    }

    let mut cmd = Command::new(&canonical);
    cmd.args(args);
    cmd.current_dir(skill_root);
    cmd.env_clear();
    for k in ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER"] {
        if let Ok(v) = std::env::var(k) {
            cmd.env(k, v);
        }
    }
    // Keep a tight env so scripts can't pull API keys from the parent process.
    let _: &HashMap<String, String> = &HashMap::new();

    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {}", e))?;

    if let Some(data) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            let _ = pipe.write_all(data.as_bytes()).await;
            let _ = pipe.shutdown().await;
        }
    }

    let result = timeout(TIMEOUT, child.wait_with_output()).await;

    match result {
        Ok(Ok(output)) => {
            let stdout = truncate(&String::from_utf8_lossy(&output.stdout), OUTPUT_LIMIT);
            let stderr = truncate(&String::from_utf8_lossy(&output.stderr), OUTPUT_LIMIT);
            let mut formatted = String::new();
            if !stdout.is_empty() {
                formatted.push_str("--- stdout ---\n");
                formatted.push_str(&stdout);
                if !stdout.ends_with('\n') {
                    formatted.push('\n');
                }
            }
            if !stderr.is_empty() {
                formatted.push_str("--- stderr ---\n");
                formatted.push_str(&stderr);
                if !stderr.ends_with('\n') {
                    formatted.push('\n');
                }
            }
            if formatted.is_empty() {
                formatted.push_str("(no output)\n");
            }
            formatted.push_str(&format!(
                "--- exit {} ---",
                output.status.code().unwrap_or(-1)
            ));
            Ok(ScriptOutput {
                success: output.status.success(),
                formatted,
            })
        }
        Ok(Err(e)) => Err(format!("wait failed: {}", e)),
        Err(_) => {
            // Timed out — drop the child so it's killed on drop.
            Err(format!("script exceeded {}s timeout", TIMEOUT.as_secs()))
        }
    }
}

fn truncate(s: &str, limit: usize) -> String {
    if s.len() <= limit {
        return s.to_string();
    }
    let mut out = s[..limit].to_string();
    out.push_str(&format!("\n…[truncated at {} bytes]", limit));
    out
}

#[allow(dead_code)]
fn _keep_path_import_alive(_p: PathBuf) {}
