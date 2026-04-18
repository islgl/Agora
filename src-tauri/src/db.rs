use std::path::Path;

use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;

pub type DbPool = SqlitePool;

const INIT_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS conversations (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    model_id       TEXT NOT NULL,
    active_leaf_id TEXT,
    pinned         INTEGER NOT NULL DEFAULT 0,
    title_locked   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id               TEXT PRIMARY KEY,
    conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    parent_id        TEXT REFERENCES messages(id) ON DELETE CASCADE,
    role             TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
    content          TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    parts_json       TEXT,
    model_name       TEXT,
    input_tokens     INTEGER,
    output_tokens    INTEGER,
    thinking_skipped INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_conv
    ON messages(conversation_id, created_at);
-- NOTE: idx_messages_parent is created in MIGRATIONS so it runs after the
-- ALTER TABLE ADD COLUMN parent_id step on pre-existing databases.

CREATE TABLE IF NOT EXISTS model_configs (
    id       TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('openai','anthropic','gemini')),
    name     TEXT NOT NULL,
    base_url TEXT NOT NULL DEFAULT '',
    api_key  TEXT NOT NULL DEFAULT '',
    model    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS global_settings (
    id                     INTEGER PRIMARY KEY CHECK (id = 1),
    api_key                TEXT NOT NULL DEFAULT '',
    base_url_openai        TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
    base_url_anthropic     TEXT NOT NULL DEFAULT 'https://api.anthropic.com',
    base_url_gemini        TEXT NOT NULL DEFAULT 'https://generativelanguage.googleapis.com',
    tavily_api_key         TEXT NOT NULL DEFAULT '',
    skills_directory       TEXT NOT NULL DEFAULT '',
    skills_scripts_enabled INTEGER NOT NULL DEFAULT 0,
    web_search_enabled     INTEGER NOT NULL DEFAULT 1,
    auto_title_mode        TEXT NOT NULL DEFAULT 'every',
    thinking_effort        TEXT NOT NULL DEFAULT 'off'
);

INSERT OR IGNORE INTO global_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS mcp_servers (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    transport    TEXT NOT NULL CHECK (transport IN ('stdio','http','sse')),
    command      TEXT,
    args_json    TEXT,
    env_json     TEXT,
    url          TEXT,
    headers_json TEXT,
    login_shell  INTEGER NOT NULL DEFAULT 0,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta_flags (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Full-text search index for message bodies. Contentless table mirrors the
-- messages table via triggers so we never double-store content.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid',
    tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert
    AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete
    AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
            VALUES('delete', old.rowid, old.content);
    END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update
    AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
            VALUES('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
"#;

/// Additive migrations for columns that might be missing on DBs created by
/// earlier versions. Each ALTER is attempted once; "duplicate column name"
/// errors are swallowed because they mean the upgrade already happened.
const MIGRATIONS: &[&str] = &[
    "ALTER TABLE global_settings ADD COLUMN tavily_api_key TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE global_settings ADD COLUMN skills_directory TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE global_settings ADD COLUMN skills_scripts_enabled INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE messages ADD COLUMN parts_json TEXT",
    "ALTER TABLE messages ADD COLUMN parent_id TEXT REFERENCES messages(id) ON DELETE CASCADE",
    "ALTER TABLE conversations ADD COLUMN active_leaf_id TEXT",
    "CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id)",
    "ALTER TABLE messages ADD COLUMN model_name TEXT",
    "ALTER TABLE global_settings ADD COLUMN web_search_enabled INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE conversations ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE global_settings ADD COLUMN auto_title_mode TEXT NOT NULL DEFAULT 'every'",
    "ALTER TABLE messages ADD COLUMN input_tokens INTEGER",
    "ALTER TABLE messages ADD COLUMN output_tokens INTEGER",
    "ALTER TABLE global_settings ADD COLUMN thinking_effort TEXT NOT NULL DEFAULT 'off'",
    "ALTER TABLE messages ADD COLUMN thinking_skipped INTEGER NOT NULL DEFAULT 0",
];

/// One-shot backfills. Keyed by a flag in `meta_flags`; skipped once done.
/// Each entry: (flag_key, SQL). The SQL may contain multiple statements
/// separated by `---`.
const ONE_SHOT_BACKFILLS: &[(&str, &str)] = &[
    (
        "backfill_message_tree_v1",
        r#"
WITH ordered AS (
    SELECT id,
           LAG(id) OVER (
               PARTITION BY conversation_id
               ORDER BY created_at
           ) AS prev_id
    FROM messages
    WHERE parent_id IS NULL
)
UPDATE messages
   SET parent_id = (SELECT prev_id FROM ordered WHERE ordered.id = messages.id)
 WHERE id IN (SELECT id FROM ordered WHERE prev_id IS NOT NULL)
---
UPDATE conversations
   SET active_leaf_id = (
       SELECT id FROM messages
        WHERE conversation_id = conversations.id
        ORDER BY created_at DESC
        LIMIT 1
   )
 WHERE active_leaf_id IS NULL
"#,
    ),
    // Populate the FTS index with any rows that existed before the virtual
    // table was created. Noop for fresh databases.
    (
        "backfill_messages_fts_v1",
        r#"
INSERT INTO messages_fts(rowid, content)
    SELECT rowid, content FROM messages
"#,
    ),
];

pub async fn init(db_path: &Path) -> Result<DbPool, sqlx::Error> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let url = format!("sqlite://{}?mode=rwc", db_path.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await?;

    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await?;

    // Run the full INIT block as one multi-statement script. Splitting on `;`
    // would break `BEGIN … END;` trigger bodies (their inner `;` look like
    // statement terminators).
    sqlx::raw_sql(INIT_SQL).execute(&pool).await?;

    // Idempotent column additions for older DBs — ignore "duplicate column"
    // errors since they indicate the column already exists.
    for stmt in MIGRATIONS {
        if let Err(e) = sqlx::query(stmt).execute(&pool).await {
            let msg = e.to_string();
            if !msg.contains("duplicate column name") {
                return Err(e);
            }
        }
    }

    // One-shot backfills — guarded by `meta_flags` so they only run once.
    for (key, sql) in ONE_SHOT_BACKFILLS {
        let already: Option<String> =
            sqlx::query_scalar("SELECT value FROM meta_flags WHERE key = ?")
                .bind(key)
                .fetch_optional(&pool)
                .await?;
        if already.is_some() {
            continue;
        }
        for stmt in sql.split("---").map(str::trim).filter(|s| !s.is_empty()) {
            sqlx::raw_sql(stmt).execute(&pool).await?;
        }
        sqlx::query("INSERT OR REPLACE INTO meta_flags (key, value) VALUES (?, '1')")
            .bind(key)
            .execute(&pool)
            .await?;
    }

    Ok(pool)
}
