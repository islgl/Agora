//! Wiki Layer — the agent's structured, long-lived knowledge base.
//!
//! Phase 3 of the personal-assistant work. Every markdown file under
//! `~/.agora/wiki/` is a Wiki page with YAML frontmatter (title, tags,
//! category, summary, updated_at, sources). An auto-maintained
//! `wiki/index.md` mirrors all pages for the LLM-based selector
//! (`src/lib/ai/wiki-selector.ts`) to reason over at turn start.
//!
//! This module exposes low-level CRUD. Higher-level flows (ingest
//! subagents, index rebuild after bulk writes) live on the TS side so
//! they compose with the existing Vercel AI SDK pipeline.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use gray_matter::engine::YAML;
use gray_matter::Matter;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use walkdir::WalkDir;

use crate::paths;

const MAX_WIKI_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WikiPage {
    /// Path relative to the wiki root, using forward slashes
    /// (e.g. `concepts/cai.md`). This is the id the model addresses.
    pub rel_path: String,
    pub title: String,
    pub tags: Vec<String>,
    pub category: Option<String>,
    pub summary: Option<String>,
    pub updated_at: Option<String>,
    pub sources: Vec<String>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPageContents {
    pub rel_path: String,
    pub content: String,
    pub frontmatter: Value,
    pub truncated: bool,
}

#[tauri::command]
pub async fn list_wiki_pages(app: AppHandle) -> Result<Vec<WikiPage>, String> {
    let root = paths::wiki_dir(&app)?;
    let mut pages = scan_pages(&root);
    // Stable ordering — category, then title — so the LLM selector and
    // the UI both see the same sequence.
    pages.sort_by(|a, b| {
        a.category
            .as_deref()
            .unwrap_or("zzz")
            .cmp(b.category.as_deref().unwrap_or("zzz"))
            .then_with(|| a.title.cmp(&b.title))
    });
    Ok(pages)
}

#[tauri::command]
pub async fn read_wiki_page(app: AppHandle, rel_path: String) -> Result<WikiPageContents, String> {
    let root = paths::wiki_dir(&app)?;
    let rel = sanitize_rel(&rel_path)?;
    let full = root.join(&rel);
    if !full.exists() {
        return Err(format!("wiki page not found: {}", rel.display()));
    }
    let bytes = fs::read(&full).map_err(|e| format!("read {}: {e}", full.display()))?;
    let truncated = bytes.len() > MAX_WIKI_BYTES;
    let slice = if truncated {
        &bytes[..MAX_WIKI_BYTES]
    } else {
        &bytes[..]
    };
    let raw = String::from_utf8_lossy(slice).into_owned();
    let parsed = Matter::<YAML>::new().parse(&raw);
    let frontmatter: Value = parsed
        .data
        .and_then(|p| p.deserialize().ok())
        .unwrap_or(Value::Null);
    Ok(WikiPageContents {
        rel_path: rel_path_string(&rel),
        content: parsed.content,
        frontmatter,
        truncated,
    })
}

#[tauri::command]
pub async fn write_wiki_page(
    app: AppHandle,
    rel_path: String,
    content: String,
) -> Result<WikiPage, String> {
    let root = paths::wiki_dir(&app)?;
    let rel = sanitize_rel(&rel_path)?;
    let full = root.join(&rel);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    fs::write(&full, &content).map_err(|e| format!("write {}: {e}", full.display()))?;
    page_from_path(&root, &full).ok_or_else(|| {
        format!(
            "wrote {} but could not re-read page metadata",
            full.display()
        )
    })
}

#[tauri::command]
pub async fn delete_wiki_page(app: AppHandle, rel_path: String) -> Result<bool, String> {
    let root = paths::wiki_dir(&app)?;
    let rel = sanitize_rel(&rel_path)?;
    let full = root.join(&rel);
    if !full.exists() {
        return Ok(false);
    }
    fs::remove_file(&full).map_err(|e| format!("delete {}: {e}", full.display()))?;
    Ok(true)
}

/// Rebuild `wiki/index.md` so the model (and selector) has a single file
/// that lists every page, its summary, tags, and incoming backlinks.
#[tauri::command]
pub async fn update_wiki_index(app: AppHandle) -> Result<String, String> {
    let root = paths::wiki_dir(&app)?;
    let pages = scan_pages(&root);
    let backlinks = compute_backlinks(&root, &pages);
    let body = render_index(&pages, &backlinks);
    let index_path = root.join("index.md");
    fs::write(&index_path, &body).map_err(|e| format!("write index.md: {e}"))?;
    Ok(body)
}

fn scan_pages(root: &Path) -> Vec<WikiPage> {
    if !root.exists() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.path();
        // Skip the index itself — it's regenerated, not authored.
        if path.file_name().and_then(|n| n.to_str()) == Some("index.md") {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if let Some(page) = page_from_path(root, path) {
            out.push(page);
        }
    }
    out
}

fn page_from_path(root: &Path, path: &Path) -> Option<WikiPage> {
    let rel = path.strip_prefix(root).ok()?.to_path_buf();
    let raw = fs::read_to_string(path).ok()?;
    let parsed = Matter::<YAML>::new().parse(&raw);
    let data: Value = parsed
        .data
        .and_then(|p| p.deserialize().ok())
        .unwrap_or(Value::Null);

    // Fallback title: filename stem with underscores/dashes replaced.
    let fallback_title = rel
        .file_stem()
        .and_then(|n| n.to_str())
        .map(|s| s.replace(['-', '_'], " "))
        .unwrap_or_else(|| rel.to_string_lossy().into_owned());

    let title = extract_string(&data, "title").unwrap_or(fallback_title);
    let tags = extract_string_list(&data, "tags");
    let category = extract_string(&data, "category").or_else(|| {
        rel.parent()
            .and_then(|p| p.to_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    });
    let summary = extract_string(&data, "summary");
    let updated_at = extract_string(&data, "updated_at");
    let sources = extract_string_list(&data, "sources");

    let size_bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    Some(WikiPage {
        rel_path: rel_path_string(&rel),
        title,
        tags,
        category,
        summary,
        updated_at,
        sources,
        size_bytes,
    })
}

fn rel_path_string(rel: &Path) -> String {
    rel.to_string_lossy().replace('\\', "/")
}

fn extract_string(data: &Value, key: &str) -> Option<String> {
    data.get(key)?.as_str().map(|s| s.trim().to_string())
}

fn extract_string_list(data: &Value, key: &str) -> Vec<String> {
    match data.get(key) {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect(),
        Some(Value::String(s)) => s
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// Scan each page's body for `[[wiki-link]]` references and return a map
/// of page title → list of rel_paths that link TO it. Used when rendering
/// the index so a reader can see "what else references this".
fn compute_backlinks(root: &Path, pages: &[WikiPage]) -> BTreeMap<String, Vec<String>> {
    let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for page in pages {
        let Ok(raw) = fs::read_to_string(root.join(&page.rel_path)) else {
            continue;
        };
        let body = Matter::<YAML>::new().parse(&raw).content;
        for cap in WIKI_LINK_RE.captures_iter(&body) {
            if let Some(target) = cap.get(1) {
                let key = target.as_str().trim().to_string();
                if key.is_empty() {
                    continue;
                }
                map.entry(key).or_default().push(page.rel_path.clone());
            }
        }
    }
    map
}

static WIKI_LINK_RE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"\[\[([^\]]+)\]\]").unwrap());

fn render_index(pages: &[WikiPage], backlinks: &BTreeMap<String, Vec<String>>) -> String {
    let mut out = String::new();
    out.push_str("# Wiki Index\n\n");
    out.push_str(
        "_Auto-maintained by Agora. Do not edit by hand — changes will be overwritten \
         on the next rebuild._\n\n",
    );
    if pages.is_empty() {
        out.push_str(
            "No wiki pages yet. Drop a file into `~/.agora/raw/` or create a page manually.\n",
        );
        return out;
    }

    // Group by category. Empty / unknown category becomes "Uncategorized"
    // and sorts last.
    let mut by_cat: BTreeMap<String, Vec<&WikiPage>> = BTreeMap::new();
    for page in pages {
        let key = page
            .category
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "uncategorized".to_string());
        by_cat.entry(key).or_default().push(page);
    }

    // Preferred ordering: concepts → projects → domains → uncategorized →
    // anything else alphabetical.
    let mut cats: Vec<String> = by_cat.keys().cloned().collect();
    cats.sort_by(|a, b| {
        let rank = |s: &str| match s {
            "concepts" => 0,
            "projects" => 1,
            "domains" => 2,
            "uncategorized" => 99,
            _ => 50,
        };
        rank(a).cmp(&rank(b)).then_with(|| a.cmp(b))
    });

    for cat in cats {
        out.push_str(&format!("## {}\n\n", title_case(&cat)));
        if let Some(group) = by_cat.get(&cat) {
            for page in group {
                out.push_str(&format!(
                    "- [[{title}]] — `{path}`",
                    title = page.title,
                    path = page.rel_path,
                ));
                if let Some(sum) = page.summary.as_deref().filter(|s| !s.is_empty()) {
                    out.push_str(&format!(" — {sum}"));
                }
                out.push('\n');
                if !page.tags.is_empty() {
                    out.push_str(&format!(
                        "  - tags: {}\n",
                        page.tags
                            .iter()
                            .map(|t| format!("#{t}"))
                            .collect::<Vec<_>>()
                            .join(" ")
                    ));
                }
                let incoming = backlinks
                    .get(&page.title)
                    .map(|v| {
                        v.iter()
                            .filter(|r| **r != page.rel_path)
                            .cloned()
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                if !incoming.is_empty() {
                    out.push_str(&format!("  - referenced by: {}\n", incoming.join(", "),));
                }
            }
            out.push('\n');
        }
    }

    out
}

fn title_case(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Refuse absolute paths and parent-escapes (`..`) so a misbehaving
/// subagent can't wander outside wiki/.
fn sanitize_rel(rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().trim_start_matches('/');
    if rel.is_empty() {
        return Err("rel_path must not be empty".into());
    }
    let path = PathBuf::from(rel);
    if path.is_absolute() {
        return Err("rel_path must be relative".into());
    }
    for comp in path.components() {
        use std::path::Component;
        match comp {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("rel_path escapes wiki root: {rel}"));
            }
            _ => {}
        }
    }
    if path.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err("wiki pages must end in .md".into());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_page(root: &Path, rel: &str, body: &str) {
        let full = root.join(rel);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, body).unwrap();
    }

    #[test]
    fn scan_picks_up_md_files() {
        let td = tempfile::tempdir().unwrap();
        write_page(
            td.path(),
            "concepts/cai.md",
            "---\ntitle: Constitutional AI\ntags: [ai-safety]\ncategory: concepts\nsummary: A brief.\n---\nBody.",
        );
        write_page(td.path(), "concepts/raw.txt", "not a wiki page");
        let pages = scan_pages(td.path());
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].title, "Constitutional AI");
        assert_eq!(pages[0].tags, vec!["ai-safety"]);
        assert_eq!(pages[0].category.as_deref(), Some("concepts"));
    }

    #[test]
    fn index_skipped_from_scan() {
        let td = tempfile::tempdir().unwrap();
        write_page(td.path(), "index.md", "# skip me");
        write_page(td.path(), "concepts/x.md", "# x");
        let pages = scan_pages(td.path());
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].rel_path, "concepts/x.md");
    }

    #[test]
    fn render_index_buckets_categories_and_sorts() {
        let td = tempfile::tempdir().unwrap();
        write_page(
            td.path(),
            "concepts/alpha.md",
            "---\ntitle: Alpha\ncategory: concepts\nsummary: a\n---\n",
        );
        write_page(
            td.path(),
            "domains/beta.md",
            "---\ntitle: Beta\ncategory: domains\nsummary: b\n---\n",
        );
        let pages = scan_pages(td.path());
        let rendered = render_index(&pages, &BTreeMap::new());
        assert!(rendered.contains("## Concepts"));
        assert!(rendered.contains("## Domains"));
        // Concepts heading appears before Domains
        assert!(rendered.find("## Concepts").unwrap() < rendered.find("## Domains").unwrap());
    }

    #[test]
    fn backlinks_populated_for_wiki_references() {
        let td = tempfile::tempdir().unwrap();
        write_page(
            td.path(),
            "concepts/a.md",
            "---\ntitle: A\n---\n\nLinks to [[B]] and [[C]].\n",
        );
        write_page(
            td.path(),
            "concepts/b.md",
            "---\ntitle: B\n---\n\nStandalone.\n",
        );
        let pages = scan_pages(td.path());
        let bl = compute_backlinks(td.path(), &pages);
        assert_eq!(
            bl.get("B").map(|v| v.as_slice()),
            Some(&["concepts/a.md".to_string()][..])
        );
        assert_eq!(
            bl.get("C").map(|v| v.as_slice()),
            Some(&["concepts/a.md".to_string()][..])
        );
    }

    #[test]
    fn sanitize_rejects_escape_attempts() {
        // Parent-dir traversal is hard-blocked.
        assert!(sanitize_rel("../etc/passwd").is_err());
        assert!(sanitize_rel("concepts/../../etc/passwd").is_err());
        // Non-markdown files are rejected (keeps the wiki homogeneous).
        assert!(sanitize_rel("concepts/x.txt").is_err());
        // Empty / whitespace input rejected.
        assert!(sanitize_rel("  ").is_err());
        // Normal relative paths work; leading slash is stripped (the
        // result is still inside wiki/, so we stay permissive there).
        assert!(sanitize_rel("concepts/x.md").is_ok());
        assert!(sanitize_rel("/concepts/x.md").is_ok());
    }
}
