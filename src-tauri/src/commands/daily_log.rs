//! Daily conversation log — source of truth for Dreaming.
//!
//! Each completed turn appends a two-block entry to
//! `~/.agora/logs/YYYY-MM-DD.md`. The nightly Dreaming pass reads the
//! previous day's log and appends distilled memories to the Brand
//! files directly; review/undo happens in Settings → Personalization.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::paths;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyLogEntry {
    pub conversation_id: String,
    pub user_text: String,
    pub assistant_text: String,
    /// Optional explicit date override (YYYY-MM-DD). Default: today
    /// (local). Used by tests and manual imports.
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyLogContent {
    pub date: String,
    pub path: Option<String>,
    pub content: String,
}

#[tauri::command]
pub async fn append_daily_log(app: AppHandle, entry: DailyLogEntry) -> Result<(), String> {
    let dir = paths::logs_dir(&app)?;
    let date = entry
        .date
        .as_deref()
        .map(ToString::to_string)
        .unwrap_or_else(today_local);
    let path = dir.join(format!("{date}.md"));
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;

    let stamp = now_hhmm_local();
    let body = format!(
        "\n## {stamp} · conversation `{conv}`\n\n**User:**\n{user}\n\n**Assistant:**\n{asst}\n",
        conv = entry.conversation_id,
        user = entry.user_text.trim(),
        asst = entry.assistant_text.trim(),
    );
    f.write_all(body.as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))
}

#[tauri::command]
pub async fn read_daily_log(app: AppHandle, date: String) -> Result<DailyLogContent, String> {
    let dir = paths::logs_dir(&app)?;
    let path = dir.join(format!("{date}.md"));
    if !path.exists() {
        return Ok(DailyLogContent {
            date,
            path: None,
            content: String::new(),
        });
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(DailyLogContent {
        date,
        path: Some(path.to_string_lossy().into_owned()),
        content,
    })
}

/// Check if the Dreaming job is due — no run in the last 20 hours.
/// The auto trigger is now idle-based (frontend), so this is purely a
/// rate-limit gate: return true iff the last run was >20h ago (or has
/// never happened). Manual `run_dreaming` calls bypass this entirely.
#[tauri::command]
pub async fn dreaming_should_run(
    app: AppHandle,
    pool: tauri::State<'_, crate::db::DbPool>,
) -> Result<bool, String> {
    let _ = app;
    let last = read_last_run_ts(&*pool).await?;
    let now = now_secs();
    let recent_cutoff = now - 20 * 3600;
    Ok(last.map(|ts| ts <= recent_cutoff).unwrap_or(true))
}

/// Read the concatenated daily-log content between `dreaming_last_run`
/// and now. Used by the idle trigger so Dreaming sees every turn that
/// happened since the last distillation, not just "yesterday".
///
/// When `dreaming_last_run` is missing (never run before), falls back
/// to a 24h lookback so the first run has bounded scope.
#[tauri::command]
pub async fn read_daily_logs_since_last_dreaming(
    app: AppHandle,
    pool: tauri::State<'_, crate::db::DbPool>,
) -> Result<DailyLogContent, String> {
    let now = now_secs();
    let since = read_last_run_ts(&*pool).await?.unwrap_or(now - 24 * 3600);
    let dir = paths::logs_dir(&app)?;
    let content = collect_entries_since(&dir, since, now)?;
    Ok(DailyLogContent {
        date: date_from_secs_utc(since),
        path: None,
        content,
    })
}

async fn read_last_run_ts(pool: &sqlx::SqlitePool) -> Result<Option<i64>, String> {
    let row: Option<String> =
        sqlx::query_scalar("SELECT value FROM meta_flags WHERE key = 'dreaming_last_run'")
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("meta_flags read: {e}"))?;
    Ok(row.and_then(|s| s.parse::<i64>().ok()))
}

/// Walk `logs/*.md`, parse per-entry `## HH:MM UTC · conversation` headers,
/// and keep entries whose timestamp falls in `[since_ts, until_ts)`.
/// Returns the concatenation in chronological order.
fn collect_entries_since(dir: &std::path::Path, since_ts: i64, until_ts: i64) -> Result<String, String> {
    if !dir.exists() {
        return Ok(String::new());
    }
    let since_day = since_ts.div_euclid(86_400);
    let until_day = until_ts.div_euclid(86_400);

    let mut day_files: Vec<(i64, std::path::PathBuf)> = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
        let path = entry.path();
        let name = match path.file_stem().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let day = match parse_yyyy_mm_dd_to_day(name) {
            Some(d) => d,
            None => continue,
        };
        if day < since_day || day > until_day {
            continue;
        }
        day_files.push((day, path));
    }
    day_files.sort_by_key(|(d, _)| *d);

    let mut out = String::new();
    for (day, path) in day_files {
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        for chunk in split_entries(&text) {
            let hhmm = match parse_entry_hhmm(&chunk) {
                Some(p) => p,
                None => continue,
            };
            let ts = day * 86_400 + hhmm;
            if ts < since_ts || ts >= until_ts {
                continue;
            }
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(chunk.trim_end());
            out.push('\n');
        }
    }
    Ok(out)
}

/// Split a log file into per-entry chunks on "\n## " boundaries. The
/// header-less preamble (if any) is dropped — entries are everything
/// starting from the first "## " heading.
fn split_entries(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        if line.starts_with("## ") {
            if let Some(prev) = current.take() {
                out.push(prev);
            }
            current = Some(String::from(line));
        } else if let Some(buf) = current.as_mut() {
            buf.push('\n');
            buf.push_str(line);
        }
    }
    if let Some(prev) = current {
        out.push(prev);
    }
    out
}

/// Pull the "HH:MM" from an entry header like "## 14:05 UTC · conversation `abc`".
/// Returns seconds-since-midnight.
fn parse_entry_hhmm(chunk: &str) -> Option<i64> {
    let line = chunk.lines().next()?;
    let rest = line.strip_prefix("## ")?;
    let hhmm_str = rest.split_whitespace().next()?;
    let (h_str, m_str) = hhmm_str.split_once(':')?;
    let h: i64 = h_str.parse().ok()?;
    let m: i64 = m_str.parse().ok()?;
    if !(0..24).contains(&h) || !(0..60).contains(&m) {
        return None;
    }
    Some(h * 3600 + m * 60)
}

/// "2026-04-23" -> days since 1970-01-01, matching `civil_from_days`.
fn parse_yyyy_mm_dd_to_day(name: &str) -> Option<i64> {
    let bytes = name.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let y: i64 = name[0..4].parse().ok()?;
    let m: u32 = name[5..7].parse().ok()?;
    let d: u32 = name[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

/// Hinnant days_from_civil — inverse of `civil_from_days`.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = (y - era * 400) as u64;
    let m_u = m as u64;
    let d_u = d as u64;
    let doy = (153 * (if m_u > 2 { m_u - 3 } else { m_u + 9 }) + 2) / 5 + d_u - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

#[tauri::command]
pub async fn mark_dreaming_ran(pool: tauri::State<'_, crate::db::DbPool>) -> Result<(), String> {
    let ts = now_secs().to_string();
    sqlx::query("INSERT OR REPLACE INTO meta_flags (key, value) VALUES ('dreaming_last_run', ?)")
        .bind(&ts)
        .execute(&*pool)
        .await
        .map_err(|e| format!("meta_flags write: {e}"))?;
    Ok(())
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn today_local() -> String {
    // We avoid pulling in `chrono` for this single formatter. SystemTime →
    // UTC offset is close enough; a user with a DST boundary at midnight
    // local sees at worst a 1-hour mismatch on the log filename once a
    // year, which is fine.
    let secs = now_secs();
    date_from_secs_utc(secs)
}

fn now_hhmm_local() -> String {
    let secs = now_secs();
    let h = ((secs / 3600) % 24) as i64;
    let m = ((secs / 60) % 60) as i64;
    format!("{:02}:{:02} UTC", h, m)
}

fn date_from_secs_utc(secs: i64) -> String {
    // Shell-out-free date formatter. Algorithm:
    //   1. Days since 1970-01-01 = secs / 86400
    //   2. Convert days → Y/M/D using civil-from-days (Howard Hinnant).
    let days = (secs / 86_400) as i64;
    let (y, m, d) = civil_from_days(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

// Hinnant, http://howardhinnant.github.io/date_algorithms.html
fn civil_from_days(mut z: i64) -> (i64, u32, u32) {
    z += 719_468;
    let era = z.div_euclid(146_097);
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_days_epoch() {
        // 1970-01-01 is days=0.
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(31), (1970, 2, 1));
        assert_eq!(civil_from_days(365), (1971, 1, 1));
    }

    #[test]
    fn date_from_secs_sanity() {
        // Deliberately pinned timestamps.
        assert_eq!(date_from_secs_utc(0), "1970-01-01");
        assert_eq!(date_from_secs_utc(86400 * 366), "1971-01-02"); // 1970 was non-leap
    }

    fn tmp_path() -> std::path::PathBuf {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().to_path_buf();
        std::mem::forget(td);
        p
    }

    #[test]
    fn parse_hhmm_handles_known_shape() {
        let chunk = "## 14:05 UTC · conversation `abc`\n\n**User:**\nhello\n";
        assert_eq!(parse_entry_hhmm(chunk), Some(14 * 3600 + 5 * 60));
    }

    #[test]
    fn parse_hhmm_rejects_garbage() {
        assert_eq!(parse_entry_hhmm("not a header"), None);
        assert_eq!(parse_entry_hhmm("## 99:00 UTC · foo"), None);
        assert_eq!(parse_entry_hhmm("## notime UTC"), None);
    }

    #[test]
    fn civil_roundtrip() {
        // Roundtrip a few sample dates through days_from_civil/civil_from_days.
        for &(y, m, d) in &[(1970, 1, 1), (2000, 2, 29), (2026, 4, 23), (1999, 12, 31)] {
            let days = days_from_civil(y, m, d);
            assert_eq!(civil_from_days(days), (y, m as u32, d as u32));
        }
    }

    #[test]
    fn parse_yyyy_mm_dd() {
        assert_eq!(parse_yyyy_mm_dd_to_day("2026-04-23"), Some(days_from_civil(2026, 4, 23)));
        assert_eq!(parse_yyyy_mm_dd_to_day("2026-4-23"), None);
        assert_eq!(parse_yyyy_mm_dd_to_day("bogus"), None);
    }

    #[test]
    fn collect_entries_filters_by_timestamp() {
        let td = tempfile::tempdir().unwrap();
        let dir = td.path();
        // Day 2026-04-22 has two entries at 10:00 and 23:45.
        std::fs::write(
            dir.join("2026-04-22.md"),
            "\n## 10:00 UTC · conversation `a`\n\n**User:**\nold\n\n## 23:45 UTC · conversation `b`\n\n**User:**\nmid\n",
        )
        .unwrap();
        // Day 2026-04-23 has one entry at 08:00.
        std::fs::write(
            dir.join("2026-04-23.md"),
            "\n## 08:00 UTC · conversation `c`\n\n**User:**\nnew\n",
        )
        .unwrap();
        // since = 2026-04-22 22:00, until = 2026-04-23 10:00.
        let since = days_from_civil(2026, 4, 22) * 86_400 + 22 * 3600;
        let until = days_from_civil(2026, 4, 23) * 86_400 + 10 * 3600;
        let out = collect_entries_since(dir, since, until).unwrap();
        assert!(!out.contains("old"));
        assert!(out.contains("mid"));
        assert!(out.contains("new"));
    }

    #[test]
    fn append_creates_and_appends() {
        let base = tmp_path();
        let path = base.join("2026-04-20.md");
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .unwrap();
        f.write_all(b"# 2026-04-20 conversation log\n").unwrap();
        drop(f);
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"entry\n").unwrap();
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.contains("# 2026-04-20"));
        assert!(body.contains("entry"));
    }
}
