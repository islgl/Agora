//! Bash built-in — foreground + background shell execution.
//!
//! Foreground (`bash`) blocks until the command exits or a timeout fires and
//! returns a JSON payload the model can parse. Background (`bash_background`)
//! spawns and returns a `task_id` the agent can later poll via
//! `read_task_output` or cancel with `stop_task`. All stdout/stderr is
//! captured; no terminal is attached, so interactive programs will hang.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};
use tokio::time::{timeout, Duration};
use uuid::Uuid;

/// Hard cap on captured output per invocation. A single noisy command (a
/// server log, a broken loop) won't blow out process memory.
const MAX_OUTPUT_BYTES: usize = 512 * 1024;
/// Default foreground timeout — matches the model-facing schema default.
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// After a SIGTERM on `stop_task`, how long we wait for the child to exit
/// before escalating to SIGKILL.
const STOP_GRACE_MS: u64 = 5_000;

/// Live state for a background command. The child handle is wrapped in a
/// mutex so `stop_task` can take + kill it without racing the reader.
pub struct BackgroundTask {
    // Kept for diagnostics / future listing UI even though the current
    // tool implementations don't read these fields directly.
    #[allow(dead_code)]
    pub id: String,
    #[allow(dead_code)]
    pub command: String,
    #[allow(dead_code)]
    pub started_at: i64,
    pub output: Arc<Mutex<CappedBuffer>>,
    pub status: Arc<Mutex<TaskStatus>>,
    pub child: Arc<Mutex<Option<Child>>>,
}

#[derive(Debug, Clone)]
pub enum TaskStatus {
    Running,
    Exited { code: Option<i32> },
    Killed,
    Failed(String),
}

impl TaskStatus {
    fn label(&self) -> &'static str {
        match self {
            TaskStatus::Running => "running",
            TaskStatus::Exited { .. } => "exited",
            TaskStatus::Killed => "killed",
            TaskStatus::Failed(_) => "failed",
        }
    }
}

/// Rolling output buffer that drops the oldest bytes when full. Keeps text
/// on UTF-8 char boundaries so the model never sees a half-codepoint.
pub struct CappedBuffer {
    buf: String,
    cap: usize,
}

impl CappedBuffer {
    pub fn new(cap: usize) -> Self {
        Self {
            buf: String::new(),
            cap,
        }
    }

    pub fn push(&mut self, s: &str) {
        self.buf.push_str(s);
        if self.buf.len() > self.cap {
            // Drop the oldest half when we overflow, to avoid O(n²) per-line
            // truncation costs on chatty commands. Find a char boundary.
            let drop_to = self.buf.len() - self.cap + self.cap / 2;
            let mut idx = drop_to.min(self.buf.len());
            while idx < self.buf.len() && !self.buf.is_char_boundary(idx) {
                idx += 1;
            }
            self.buf.drain(..idx);
            // Announce truncation once per drop so users aren't confused by
            // missing prefix.
            let prefix = "[… output truncated …]\n";
            self.buf.insert_str(0, prefix);
        }
    }

    pub fn snapshot(&self) -> String {
        self.buf.clone()
    }
}

pub type BackgroundStore = RwLock<HashMap<String, BackgroundTask>>;

/// Run a command in the foreground. Blocks until exit or `timeout_ms`
/// elapses. Returns a JSON string with `stdout`, `stderr`, `exit_code`, and
/// `timed_out` fields so the model gets structured output to reason over.
pub async fn bash(args: &Value, workspace_root: Option<&Path>) -> Result<String, String> {
    let command = require_command(args)?;
    let cwd = resolve_cwd(args, workspace_root)?;
    let timeout_ms = args
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS);

    let mut cmd = build_command(&command, cwd.as_deref());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let child = cmd
        .spawn()
        .map_err(|e| format!("bash: spawn failed: {}", e))?;

    let fut = run_with_output(child);
    match timeout(Duration::from_millis(timeout_ms), fut).await {
        Ok(Ok((stdout, stderr, status))) => {
            let payload = json!({
                "stdout": truncate_for_reply(&stdout),
                "stderr": truncate_for_reply(&stderr),
                "exit_code": status.code(),
                "timed_out": false,
            });
            Ok(format_payload(&payload))
        }
        Ok(Err(e)) => Err(format!("bash: {}", e)),
        Err(_elapsed) => Ok(format_payload(&json!({
            "stdout": "",
            "stderr": format!("command exceeded timeout of {}ms", timeout_ms),
            "exit_code": serde_json::Value::Null,
            "timed_out": true,
        }))),
    }
}

/// Spawn a background command and return its `task_id`. The task continues
/// running after this call returns; use `read_task_output` to poll and
/// `stop_task` to cancel.
pub async fn bash_background(
    args: &Value,
    workspace_root: Option<&Path>,
    store: &BackgroundStore,
) -> Result<String, String> {
    let command = require_command(args)?;
    let cwd = resolve_cwd(args, workspace_root)?;
    let task_id = Uuid::new_v4().to_string();

    let mut cmd = build_command(&command, cwd.as_deref());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("bash_background: spawn failed: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "bash_background: stdout pipe unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "bash_background: stderr pipe unavailable".to_string())?;

    let buffer = Arc::new(Mutex::new(CappedBuffer::new(MAX_OUTPUT_BYTES)));
    let status = Arc::new(Mutex::new(TaskStatus::Running));
    let child_handle = Arc::new(Mutex::new(Some(child)));

    // Reader tasks: each drains one pipe into the shared buffer. Closing
    // either pipe is not fatal — the child may only write to one.
    spawn_pipe_reader(stdout, buffer.clone(), "stdout");
    spawn_pipe_reader(stderr, buffer.clone(), "stderr");

    // Waiter task: resolves the status once the child exits naturally.
    {
        let status = status.clone();
        let child_handle = child_handle.clone();
        tokio::spawn(async move {
            let taken = {
                let mut guard = child_handle.lock().await;
                guard.take()
            };
            let Some(mut child) = taken else { return };
            match child.wait().await {
                Ok(es) => {
                    let mut s = status.lock().await;
                    // Respect a Killed status set by stop_task before exit.
                    if matches!(*s, TaskStatus::Running) {
                        *s = TaskStatus::Exited { code: es.code() };
                    }
                }
                Err(e) => {
                    let mut s = status.lock().await;
                    *s = TaskStatus::Failed(e.to_string());
                }
            }
            // Put the child back so callers that held a reference (e.g.
            // stop_task) can still see its absence. We drop here.
        });
    }

    let task = BackgroundTask {
        id: task_id.clone(),
        command,
        started_at: now_ms(),
        output: buffer,
        status,
        child: child_handle,
    };
    store.write().await.insert(task_id.clone(), task);

    Ok(format_payload(&json!({
        "task_id": task_id,
    })))
}

/// Snapshot of the captured output + current status of a background task.
pub async fn read_task_output(args: &Value, store: &BackgroundStore) -> Result<String, String> {
    let id = require_task_id(args, "read_task_output")?;
    let guard = store.read().await;
    let Some(task) = guard.get(&id) else {
        return Err(format!("read_task_output: no task `{}`", id));
    };
    let output = task.output.lock().await.snapshot();
    let status = task.status.lock().await.clone();
    let (label, code) = match &status {
        TaskStatus::Running => ("running", None),
        TaskStatus::Exited { code } => ("exited", *code),
        TaskStatus::Killed => ("killed", None),
        TaskStatus::Failed(_) => ("failed", None),
    };

    let detail = match &status {
        TaskStatus::Failed(msg) => Some(msg.clone()),
        _ => None,
    };

    Ok(format_payload(&json!({
        "task_id": id,
        "status": label,
        "exit_code": code,
        "failure": detail,
        "output": output,
    })))
}

/// Send SIGTERM to a background task; escalate to SIGKILL if it doesn't
/// exit within `STOP_GRACE_MS`.
pub async fn stop_task(args: &Value, store: &BackgroundStore) -> Result<String, String> {
    let id = require_task_id(args, "stop_task")?;
    let (child_handle, status) = {
        let guard = store.read().await;
        let Some(task) = guard.get(&id) else {
            return Err(format!("stop_task: no task `{}`", id));
        };
        (task.child.clone(), task.status.clone())
    };

    let current = status.lock().await.clone();
    if !matches!(current, TaskStatus::Running) {
        return Ok(format_payload(&json!({
            "task_id": id,
            "status": current.label(),
            "message": "already stopped",
        })));
    }

    // Graceful shutdown first.
    {
        let mut guard = child_handle.lock().await;
        if let Some(child) = guard.as_mut() {
            let _ = child.start_kill();
        }
    }

    let deadline = Duration::from_millis(STOP_GRACE_MS);
    let start = tokio::time::Instant::now();
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let exited = !matches!(*status.lock().await, TaskStatus::Running);
        if exited {
            break;
        }
        if start.elapsed() >= deadline {
            // Escalate. On unix `start_kill` is already SIGKILL (tokio
            // doesn't distinguish), so this is mostly defensive on other
            // platforms.
            let mut guard = child_handle.lock().await;
            if let Some(child) = guard.as_mut() {
                let _ = child.kill().await;
            }
            break;
        }
    }

    *status.lock().await = TaskStatus::Killed;

    Ok(format_payload(&json!({
        "task_id": id,
        "status": "killed",
    })))
}

// ─── helpers ───────────────────────────────────────────────────────────

fn require_command(args: &Value) -> Result<String, String> {
    args.get("command")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "bash: missing or empty `command`".into())
}

fn require_task_id(args: &Value, tool: &str) -> Result<String, String> {
    args.get("task_id")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| format!("{}: missing `task_id`", tool))
}

fn resolve_cwd(args: &Value, workspace_root: Option<&Path>) -> Result<Option<PathBuf>, String> {
    if let Some(cwd) = args.get("cwd").and_then(Value::as_str) {
        let p = Path::new(cwd);
        if p.is_absolute() {
            return Ok(Some(p.to_path_buf()));
        }
        if let Some(root) = workspace_root {
            return Ok(Some(root.join(p)));
        }
        return Err(format!(
            "bash: cwd `{}` is relative and no workspace root is set",
            cwd
        ));
    }
    Ok(workspace_root.map(Path::to_path_buf))
}

/// Build a `/bin/sh -c <command>` invocation. Keeping this in one place
/// lets the foreground and background variants stay byte-for-byte
/// identical w.r.t. shell handling.
fn build_command(command: &str, cwd: Option<&Path>) -> Command {
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg(command);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd
}

async fn run_with_output(
    mut child: Child,
) -> Result<(String, String, std::process::ExitStatus), String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout pipe unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "stderr pipe unavailable".to_string())?;

    let stdout_task = tokio::spawn(drain_to_string(stdout));
    let stderr_task = tokio::spawn(drain_to_string(stderr));

    let status = child
        .wait()
        .await
        .map_err(|e| format!("wait failed: {}", e))?;
    let out = stdout_task
        .await
        .map_err(|e| format!("stdout reader panicked: {}", e))?;
    let err = stderr_task
        .await
        .map_err(|e| format!("stderr reader panicked: {}", e))?;

    Ok((out, err, status))
}

async fn drain_to_string<R: tokio::io::AsyncRead + Unpin>(reader: R) -> String {
    let mut buf = Vec::new();
    let mut reader = BufReader::new(reader);
    let _ = tokio::io::copy_buf(&mut reader, &mut buf).await;
    String::from_utf8_lossy(&buf).into_owned()
}

fn spawn_pipe_reader<R>(reader: R, buffer: Arc<Mutex<CappedBuffer>>, _label: &str)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let mut guard = buffer.lock().await;
                    guard.push(&line);
                    guard.push("\n");
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
    });
}

fn truncate_for_reply(s: &str) -> String {
    if s.len() <= MAX_OUTPUT_BYTES {
        return s.to_string();
    }
    let mut idx = s.len() - MAX_OUTPUT_BYTES;
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    format!("[… truncated {} bytes …]\n{}", idx, &s[idx..])
}

fn format_payload(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string())
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

    fn is_unix() -> bool {
        cfg!(unix)
    }

    #[tokio::test]
    async fn bash_foreground_captures_stdout_and_exit_code() {
        if !is_unix() {
            return;
        }
        let out = bash(
            &json!({ "command": "echo hello && echo err 1>&2 && exit 3" }),
            None,
        )
        .await
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["stdout"], "hello\n");
        assert!(v["stderr"].as_str().unwrap().contains("err"));
        assert_eq!(v["exit_code"], 3);
        assert_eq!(v["timed_out"], false);
    }

    #[tokio::test]
    async fn bash_timeout_reports_timed_out() {
        if !is_unix() {
            return;
        }
        let out = bash(&json!({ "command": "sleep 2", "timeout_ms": 100 }), None)
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["timed_out"], true);
    }

    #[tokio::test]
    async fn bash_background_lifecycle() {
        if !is_unix() {
            return;
        }
        let store: BackgroundStore = RwLock::new(HashMap::new());
        let spawn_out = bash_background(
            &json!({ "command": "echo ready; sleep 0.1; echo done" }),
            None,
            &store,
        )
        .await
        .unwrap();
        let spawn_v: Value = serde_json::from_str(&spawn_out).unwrap();
        let task_id = spawn_v["task_id"].as_str().unwrap().to_string();

        // Poll up to a second for completion.
        let mut final_v: Value = Value::Null;
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let read = read_task_output(&json!({ "task_id": task_id }), &store)
                .await
                .unwrap();
            final_v = serde_json::from_str(&read).unwrap();
            if final_v["status"] != "running" {
                break;
            }
        }
        assert_eq!(final_v["status"], "exited");
        assert_eq!(final_v["exit_code"], 0);
        let out = final_v["output"].as_str().unwrap();
        assert!(out.contains("ready"));
        assert!(out.contains("done"));
    }

    #[tokio::test]
    async fn stop_task_kills_running_task() {
        if !is_unix() {
            return;
        }
        let store: BackgroundStore = RwLock::new(HashMap::new());
        let spawn_out = bash_background(&json!({ "command": "sleep 10" }), None, &store)
            .await
            .unwrap();
        let spawn_v: Value = serde_json::from_str(&spawn_out).unwrap();
        let task_id = spawn_v["task_id"].as_str().unwrap().to_string();

        let stop = stop_task(&json!({ "task_id": task_id }), &store)
            .await
            .unwrap();
        let stop_v: Value = serde_json::from_str(&stop).unwrap();
        assert_eq!(stop_v["status"], "killed");
    }

    #[tokio::test]
    async fn capped_buffer_preserves_tail() {
        let mut cb = CappedBuffer::new(64);
        for i in 0..100 {
            cb.push(&format!("line {}\n", i));
        }
        let snap = cb.snapshot();
        assert!(snap.starts_with("[… output truncated …]"));
        assert!(snap.contains("line 99"));
        assert!(!snap.contains("line 0\n"));
    }
}
