#![allow(dead_code)]

pub mod runtime;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use gray_matter::engine::YAML;
use gray_matter::Matter;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::fs;
use tokio::sync::RwLock;

use crate::tools::{SkillBuiltinKind, ToolCall, ToolResult, ToolSource, ToolSpec};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// Absolute path to the skill's root directory.
    pub path: String,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    pub body: String,
}

#[derive(Default)]
pub struct SkillRegistry {
    inner: RwLock<Inner>,
}

#[derive(Default)]
struct Inner {
    skills: Vec<Skill>,
    root: Option<PathBuf>,
    scripts_enabled: bool,
}

pub type SharedSkillRegistry = Arc<SkillRegistry>;

impl SkillRegistry {
    pub fn new() -> SharedSkillRegistry {
        Arc::new(Self::default())
    }

    /// Walk `<root>/<skill>/SKILL.md`, parse frontmatter, replace the in-memory
    /// cache. Non-skill folders are silently skipped; a malformed SKILL.md
    /// logs but does not abort the scan.
    pub async fn load_from(&self, root: &str, scripts_enabled: bool) -> Result<usize, String> {
        let root_path = PathBuf::from(root);
        if !root_path.is_dir() {
            return Err(format!("Skills directory does not exist: {}", root));
        }
        let mut skills = Vec::new();
        let mut read_dir = fs::read_dir(&root_path)
            .await
            .map_err(|e| format!("read_dir failed: {}", e))?;
        while let Some(entry) = read_dir
            .next_entry()
            .await
            .map_err(|e| e.to_string())?
        {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            if !skill_md.exists() {
                continue;
            }
            match load_skill(&path, &skill_md).await {
                Ok(skill) => skills.push(skill),
                Err(e) => eprintln!("Skipping skill at {}: {}", path.display(), e),
            }
        }

        let mut inner = self.inner.write().await;
        inner.skills = skills;
        inner.root = Some(root_path);
        inner.scripts_enabled = scripts_enabled;
        Ok(inner.skills.len())
    }

    pub async fn set_scripts_enabled(&self, enabled: bool) {
        let mut inner = self.inner.write().await;
        inner.scripts_enabled = enabled;
    }

    pub async fn snapshot(&self) -> Vec<Skill> {
        self.inner.read().await.skills.clone()
    }

    pub async fn list_tools(&self) -> Vec<ToolSpec> {
        let inner = self.inner.read().await;
        if inner.skills.is_empty() {
            return Vec::new();
        }

        let mut tools = vec![
            ToolSpec {
                name: "read_skill".into(),
                description: "Read the full body of a Skill that was listed in `## Available Skills`. Pass the skill's `name`."
                    .into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Skill name" }
                    },
                    "required": ["name"]
                }),
                source: ToolSource::SkillBuiltin { kind: SkillBuiltinKind::ReadSkill },
            },
            ToolSpec {
                name: "read_skill_file".into(),
                description: "Read any file inside a Skill's folder (e.g. REFERENCE.md, templates). Reads are sandboxed to the skill's directory."
                    .into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "path": { "type": "string", "description": "Path relative to the skill root." }
                    },
                    "required": ["name", "path"]
                }),
                source: ToolSource::SkillBuiltin { kind: SkillBuiltinKind::ReadSkillFile },
            },
        ];

        if inner.scripts_enabled {
            tools.push(ToolSpec {
                name: "run_skill_script".into(),
                description: "Execute a script inside a Skill's `scripts/` folder. Optional `args` (array of strings) and `stdin` (string). Output is truncated to 64 KB; wall-clock timeout is 30 s."
                    .into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "name":   { "type": "string" },
                        "script": { "type": "string", "description": "File inside <skill>/scripts/" },
                        "args":   { "type": "array", "items": { "type": "string" } },
                        "stdin":  { "type": "string" }
                    },
                    "required": ["name", "script"]
                }),
                source: ToolSource::SkillBuiltin { kind: SkillBuiltinKind::RunSkillScript },
            });
        }

        tools
    }

    pub async fn system_prefix(&self) -> Option<String> {
        let inner = self.inner.read().await;
        if inner.skills.is_empty() {
            return None;
        }
        let mut out = String::from("## Available Skills\n\n");
        for s in &inner.skills {
            out.push_str(&format!("- **{}**: {}\n", s.name, s.description));
        }
        out.push_str("\nUse `read_skill(name)` to load a skill's full instructions before acting on it.\n");
        Some(out)
    }

    pub async fn invoke(&self, call: &ToolCall) -> ToolResult {
        match call.name.as_str() {
            "read_skill" => self.handle_read_skill(call).await,
            "read_skill_file" => self.handle_read_skill_file(call).await,
            "run_skill_script" => self.handle_run_skill_script(call).await,
            other => ToolResult::err(&call.id, format!("Unknown skill tool: {}", other)),
        }
    }

    async fn handle_read_skill(&self, call: &ToolCall) -> ToolResult {
        let Some(name) = call.input.get("name").and_then(Value::as_str) else {
            return ToolResult::err(&call.id, "missing `name`");
        };
        let inner = self.inner.read().await;
        match inner.skills.iter().find(|s| s.name == name) {
            Some(s) => ToolResult::ok(&call.id, s.body.clone()),
            None => ToolResult::err(&call.id, format!("Skill '{}' not found", name)),
        }
    }

    async fn handle_read_skill_file(&self, call: &ToolCall) -> ToolResult {
        let name = match call.input.get("name").and_then(Value::as_str) {
            Some(n) => n.to_string(),
            None => return ToolResult::err(&call.id, "missing `name`"),
        };
        let rel = match call.input.get("path").and_then(Value::as_str) {
            Some(p) => p.to_string(),
            None => return ToolResult::err(&call.id, "missing `path`"),
        };

        let skill_path = {
            let inner = self.inner.read().await;
            let Some(s) = inner.skills.iter().find(|s| s.name == name) else {
                return ToolResult::err(&call.id, format!("Skill '{}' not found", name));
            };
            PathBuf::from(&s.path)
        };

        let full = skill_path.join(&rel);
        let canonical = match full.canonicalize() {
            Ok(p) => p,
            Err(e) => return ToolResult::err(&call.id, format!("canonicalize failed: {}", e)),
        };
        let skill_root = match skill_path.canonicalize() {
            Ok(p) => p,
            Err(e) => return ToolResult::err(&call.id, format!("skill root invalid: {}", e)),
        };
        if !canonical.starts_with(&skill_root) {
            return ToolResult::err(&call.id, "path escapes the skill directory");
        }

        match fs::read_to_string(&canonical).await {
            Ok(contents) => {
                let truncated = truncate_content(&contents, 64 * 1024);
                ToolResult::ok(&call.id, truncated)
            }
            Err(e) => ToolResult::err(&call.id, format!("read failed: {}", e)),
        }
    }

    async fn handle_run_skill_script(&self, call: &ToolCall) -> ToolResult {
        let (scripts_enabled, skill_path) = {
            let inner = self.inner.read().await;
            if !inner.scripts_enabled {
                return ToolResult::err(
                    &call.id,
                    "Skill script execution is disabled. Enable it in Settings → Skills.",
                );
            }
            let name = match call.input.get("name").and_then(Value::as_str) {
                Some(n) => n,
                None => return ToolResult::err(&call.id, "missing `name`"),
            };
            let Some(s) = inner.skills.iter().find(|s| s.name == name) else {
                return ToolResult::err(&call.id, format!("Skill '{}' not found", name));
            };
            (inner.scripts_enabled, PathBuf::from(&s.path))
        };
        let _ = scripts_enabled;

        let script = match call.input.get("script").and_then(Value::as_str) {
            Some(s) => s,
            None => return ToolResult::err(&call.id, "missing `script`"),
        };
        let args: Vec<String> = call
            .input
            .get("args")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let stdin = call.input.get("stdin").and_then(Value::as_str).map(String::from);

        match runtime::run_script(&skill_path, script, &args, stdin).await {
            Ok(output) => ToolResult {
                call_id: call.id.clone(),
                content: output.formatted,
                is_error: !output.success,
            },
            Err(e) => ToolResult::err(&call.id, e),
        }
    }
}

async fn load_skill(dir: &Path, skill_md: &Path) -> Result<Skill, String> {
    let raw = fs::read_to_string(skill_md)
        .await
        .map_err(|e| format!("read SKILL.md: {}", e))?;
    let matter = Matter::<YAML>::new();
    let result = matter.parse(&raw);

    #[derive(Deserialize)]
    struct Frontmatter {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default, rename = "allowed-tools")]
        allowed_tools: Option<Vec<String>>,
    }

    let data = result
        .data
        .as_ref()
        .and_then(|p| p.deserialize::<Frontmatter>().ok())
        .ok_or_else(|| "SKILL.md missing YAML frontmatter".to_string())?;

    let name = data
        .name
        .or_else(|| {
            dir.file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
        })
        .ok_or_else(|| "SKILL.md missing `name` and folder name is unusable".to_string())?;
    let description = data.description.unwrap_or_default();

    Ok(Skill {
        name,
        description,
        path: dir.to_string_lossy().into_owned(),
        allowed_tools: data.allowed_tools.unwrap_or_default(),
        body: result.content,
    })
}

fn truncate_content(s: &str, limit: usize) -> String {
    if s.len() <= limit {
        return s.to_string();
    }
    let mut out = s[..limit].to_string();
    out.push_str(&format!("\n…[truncated at {} bytes]", limit));
    out
}
