//! Auto-memory vector store — Phase 5.
//!
//! Keeps a SQLite-backed table of memory snippets (text + kind + source
//! pointers) with a parallel in-memory HNSW graph for k-NN search.
//! The HNSW graph is rebuilt from SQLite at app start so we don't have
//! to commit to hnsw_rs' on-disk format across crate upgrades.
//!
//! Embedding is done frontend-side via the AI SDK (same `tauriProxyFetch`
//! that carries chat traffic) — this module just stores whatever f32
//! vector the caller hands in. Dimensions are inferred from the first
//! insert; later inserts must match or they're rejected.

use std::sync::Arc;

use hnsw_rs::prelude::*;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::db::DbPool;

const HNSW_MAX_ELEMENTS: usize = 100_000;
const HNSW_M: usize = 16;
const HNSW_EF_CONSTRUCTION: usize = 200;

/// Narrow façade over `Hnsw` that keeps dimension + ef_search on the
/// handle. We wrap the inner graph in a `Mutex` (not `RwLock`) because
/// `hnsw_rs` insertion needs `&self` but isn't truly `Sync` — a mutex
/// serialises the calls and is plenty fast for our traffic.
pub struct MemoryStore {
    pool: DbPool,
    inner: RwLock<Option<InnerHnsw>>,
}

struct InnerHnsw {
    hnsw: Hnsw<'static, f32, DistCosine>,
    dim: usize,
    /// Maps HNSW internal id (usize) back to the SQLite row id string.
    id_by_pos: Vec<String>,
}

pub type SharedMemoryStore = Arc<MemoryStore>;

impl MemoryStore {
    pub fn new(pool: DbPool) -> SharedMemoryStore {
        Arc::new(Self {
            pool,
            inner: RwLock::new(None),
        })
    }

    /// Load every stored row back into a fresh HNSW. Called once at
    /// startup — cheap at our scale (≤ 10K rows).
    pub async fn rehydrate(&self) -> Result<(), String> {
        let rows = sqlx::query("SELECT id, vector FROM memory_auto WHERE vector IS NOT NULL")
            .fetch_all(&self.pool)
            .await
            .map_err(|e| format!("memory_auto select: {e}"))?;

        let mut vectors: Vec<(String, Vec<f32>)> = Vec::with_capacity(rows.len());
        let mut dim: Option<usize> = None;
        for row in rows {
            let id: String = row.get("id");
            let blob: Vec<u8> = row.get::<Vec<u8>, _>("vector");
            if blob.is_empty() {
                continue;
            }
            let v = bytes_to_vec_f32(&blob);
            if v.is_empty() {
                continue;
            }
            if let Some(d) = dim {
                if v.len() != d {
                    // Skip rows with mismatched dimension (e.g. user
                    // switched embedding models). Delete on sight so we
                    // don't keep silently dropping them.
                    sqlx::query("UPDATE memory_auto SET vector = NULL WHERE id = ?")
                        .bind(&id)
                        .execute(&self.pool)
                        .await
                        .ok();
                    continue;
                }
            } else {
                dim = Some(v.len());
            }
            vectors.push((id, v));
        }

        if let Some(d) = dim {
            let hnsw = Hnsw::<f32, DistCosine>::new(
                HNSW_M,
                HNSW_MAX_ELEMENTS,
                16,
                HNSW_EF_CONSTRUCTION,
                DistCosine {},
            );
            let mut id_by_pos = Vec::with_capacity(vectors.len());
            for (i, (id, v)) in vectors.iter().enumerate() {
                hnsw.insert((v.as_slice(), i));
                id_by_pos.push(id.clone());
                let _ = (id, v);
            }
            let _ = id_by_pos.len();
            *self.inner.write().await = Some(InnerHnsw {
                hnsw,
                dim: d,
                id_by_pos,
            });
        }
        Ok(())
    }

    pub async fn add(&self, row: NewMemory) -> Result<MemoryRow, String> {
        let id = Uuid::new_v4().to_string();
        let vec_bytes = vec_f32_to_bytes(&row.vector);
        let created_at = chrono_now_secs();
        sqlx::query(
            "INSERT INTO memory_auto (id, text, kind, vector, source_conversation_id, \
             source_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&row.text)
        .bind(&row.kind)
        .bind(&vec_bytes)
        .bind(&row.source_conversation_id)
        .bind(&row.source_message_id)
        .bind(created_at)
        .execute(&self.pool)
        .await
        .map_err(|e| format!("memory_auto insert: {e}"))?;

        if !row.vector.is_empty() {
            let mut guard = self.inner.write().await;
            match guard.as_mut() {
                Some(inner) if inner.dim == row.vector.len() => {
                    let pos = inner.id_by_pos.len();
                    inner.hnsw.insert((row.vector.as_slice(), pos));
                    inner.id_by_pos.push(id.clone());
                }
                Some(_) => {
                    // Dimension mismatch — we refuse to mix two embedding
                    // models in the same index. Best the caller can do is
                    // wipe the old memory or stick with the first model.
                    return Err(
                        "embedding dimension mismatch — clear existing auto memory first".into(),
                    );
                }
                None => {
                    let hnsw = Hnsw::<f32, DistCosine>::new(
                        HNSW_M,
                        HNSW_MAX_ELEMENTS,
                        16,
                        HNSW_EF_CONSTRUCTION,
                        DistCosine {},
                    );
                    hnsw.insert((row.vector.as_slice(), 0));
                    *guard = Some(InnerHnsw {
                        hnsw,
                        dim: row.vector.len(),
                        id_by_pos: vec![id.clone()],
                    });
                }
            }
        }

        Ok(MemoryRow {
            id,
            text: row.text,
            kind: row.kind,
            source_conversation_id: row.source_conversation_id,
            source_message_id: row.source_message_id,
            created_at,
            score: None,
        })
    }

    pub async fn search(&self, query: Vec<f32>, limit: usize) -> Result<Vec<MemoryRow>, String> {
        let guard = self.inner.read().await;
        let inner = match guard.as_ref() {
            Some(i) if i.dim == query.len() => i,
            _ => return Ok(Vec::new()),
        };
        let ef = (limit * 4).max(16).min(200);
        let neighbors = inner.hnsw.search(&query, limit, ef);
        let ids: Vec<String> = neighbors
            .iter()
            .filter_map(|n| inner.id_by_pos.get(n.d_id).cloned())
            .collect();
        drop(guard); // release before DB hit

        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT id, text, kind, source_conversation_id, source_message_id, created_at \
             FROM memory_auto WHERE id IN ({placeholders})"
        );
        let mut q = sqlx::query(&sql);
        for id in &ids {
            q = q.bind(id);
        }
        let rows = q
            .fetch_all(&self.pool)
            .await
            .map_err(|e| format!("memory_auto search fetch: {e}"))?;

        // Preserve HNSW ordering by id.
        let mut by_id: std::collections::HashMap<String, MemoryRow> =
            std::collections::HashMap::new();
        for row in rows {
            let id: String = row.get("id");
            by_id.insert(
                id.clone(),
                MemoryRow {
                    id,
                    text: row.get("text"),
                    kind: row.get("kind"),
                    source_conversation_id: row.get("source_conversation_id"),
                    source_message_id: row.get("source_message_id"),
                    created_at: row.get("created_at"),
                    score: None,
                },
            );
        }
        // Iterate neighbors again for scoring since we dropped the guard
        // above. It's cheap to re-acquire.
        let guard = self.inner.read().await;
        let inner = match guard.as_ref() {
            Some(i) => i,
            None => return Ok(Vec::new()),
        };
        let neighbors = inner.hnsw.search(&query, limit, ef);
        let mut out = Vec::with_capacity(neighbors.len());
        for n in neighbors {
            if let Some(id) = inner.id_by_pos.get(n.d_id) {
                if let Some(mut row) = by_id.remove(id) {
                    row.score = Some(1.0 - n.distance);
                    out.push(row);
                }
            }
        }
        Ok(out)
    }

    pub async fn list(&self, limit: usize) -> Result<Vec<MemoryRow>, String> {
        let rows = sqlx::query(
            "SELECT id, text, kind, source_conversation_id, source_message_id, created_at \
             FROM memory_auto ORDER BY created_at DESC LIMIT ?",
        )
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| format!("memory_auto list: {e}"))?;
        Ok(rows
            .into_iter()
            .map(|r| MemoryRow {
                id: r.get("id"),
                text: r.get("text"),
                kind: r.get("kind"),
                source_conversation_id: r.get("source_conversation_id"),
                source_message_id: r.get("source_message_id"),
                created_at: r.get("created_at"),
                score: None,
            })
            .collect())
    }

    pub async fn delete(&self, id: &str) -> Result<bool, String> {
        let res = sqlx::query("DELETE FROM memory_auto WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| format!("memory_auto delete: {e}"))?;
        // The HNSW graph doesn't support removals; we just leak the
        // orphan slot. Search still returns the SQLite row — since that
        // row is gone, the id_by_pos lookup on the next search will
        // filter it out naturally via the `by_id.remove` fallthrough.
        if res.rows_affected() > 0 {
            let mut guard = self.inner.write().await;
            if let Some(inner) = guard.as_mut() {
                for slot in inner.id_by_pos.iter_mut() {
                    if slot == id {
                        slot.clear();
                    }
                }
            }
        }
        Ok(res.rows_affected() > 0)
    }

    pub async fn clear(&self) -> Result<u64, String> {
        let res = sqlx::query("DELETE FROM memory_auto")
            .execute(&self.pool)
            .await
            .map_err(|e| format!("memory_auto clear: {e}"))?;
        *self.inner.write().await = None;
        Ok(res.rows_affected())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewMemory {
    pub text: String,
    pub kind: String,
    pub vector: Vec<f32>,
    pub source_conversation_id: Option<String>,
    pub source_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRow {
    pub id: String,
    pub text: String,
    pub kind: String,
    pub source_conversation_id: Option<String>,
    pub source_message_id: Option<String>,
    pub created_at: i64,
    /// Cosine similarity (1.0 = perfect match). Only populated on search,
    /// always None on list/add.
    pub score: Option<f32>,
}

fn vec_f32_to_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

fn bytes_to_vec_f32(b: &[u8]) -> Vec<f32> {
    let mut out = Vec::with_capacity(b.len() / 4);
    for chunk in b.chunks_exact(4) {
        let arr = [chunk[0], chunk[1], chunk[2], chunk[3]];
        out.push(f32::from_le_bytes(arr));
    }
    out
}

fn chrono_now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_vec(seed: f32, dim: usize) -> Vec<f32> {
        (0..dim).map(|i| ((i as f32) + seed).sin()).collect()
    }

    async fn pool() -> DbPool {
        // Each test gets its own file-backed SQLite so parallel runs
        // don't share schema state. Previously we tried in-memory, but
        // SQLite's `:memory:` shares state across the same pool's
        // connections and that subtlety tripped us up when combined
        // with the `max_connections=5` pool setting in `db::init`.
        let td = tempfile::tempdir().unwrap();
        let db = td.path().join("agora.db");
        std::mem::forget(td);
        crate::db::init(&db).await.unwrap()
    }

    #[tokio::test]
    async fn round_trip_add_and_search() {
        let p = pool().await;
        let store = MemoryStore::new(p);
        store.rehydrate().await.unwrap();
        let v1 = mk_vec(0.0, 8);
        let v2 = mk_vec(100.0, 8);
        store
            .add(NewMemory {
                text: "user prefers pnpm".into(),
                kind: "preference".into(),
                vector: v1.clone(),
                source_conversation_id: None,
                source_message_id: None,
            })
            .await
            .unwrap();
        store
            .add(NewMemory {
                text: "user lives in Shanghai".into(),
                kind: "fact".into(),
                vector: v2.clone(),
                source_conversation_id: None,
                source_message_id: None,
            })
            .await
            .unwrap();

        let hits = store.search(v1.clone(), 1).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].text.contains("pnpm"));
        assert!(hits[0].score.unwrap_or(0.0) > 0.9);
    }

    #[tokio::test]
    async fn rehydrate_restores_index() {
        let p = pool().await;
        let store = MemoryStore::new(p.clone());
        store.rehydrate().await.unwrap();
        let v = mk_vec(7.0, 4);
        store
            .add(NewMemory {
                text: "durable".into(),
                kind: "fact".into(),
                vector: v.clone(),
                source_conversation_id: None,
                source_message_id: None,
            })
            .await
            .unwrap();
        // Fresh store, same pool — hydration should find the row.
        let fresh = MemoryStore::new(p);
        fresh.rehydrate().await.unwrap();
        let hits = fresh.search(v, 1).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "durable");
    }

    #[tokio::test]
    async fn list_returns_newest_first() {
        // Sleep twice across second boundaries — tests run in parallel
        // and a sub-second collision makes created_at ambiguous, which
        // flakes ORDER BY created_at DESC. Two full seconds is overkill
        // but removes the race entirely.
        let p = pool().await;
        let store = MemoryStore::new(p);
        store.rehydrate().await.unwrap();
        store
            .add(NewMemory {
                text: "older".into(),
                kind: "fact".into(),
                vector: mk_vec(1.0, 4),
                source_conversation_id: None,
                source_message_id: None,
            })
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        store
            .add(NewMemory {
                text: "mid".into(),
                kind: "fact".into(),
                vector: mk_vec(1.5, 4),
                source_conversation_id: None,
                source_message_id: None,
            })
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        store
            .add(NewMemory {
                text: "newer".into(),
                kind: "fact".into(),
                vector: mk_vec(2.0, 4),
                source_conversation_id: None,
                source_message_id: None,
            })
            .await
            .unwrap();
        let rows = store.list(10).await.unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].text, "newer");
        assert_eq!(rows[2].text, "older");
    }

    #[tokio::test]
    async fn delete_and_clear() {
        let p = pool().await;
        let store = MemoryStore::new(p);
        store.rehydrate().await.unwrap();
        let row = store
            .add(NewMemory {
                text: "to delete".into(),
                kind: "fact".into(),
                vector: mk_vec(3.0, 4),
                source_conversation_id: None,
                source_message_id: None,
            })
            .await
            .unwrap();
        assert!(store.delete(&row.id).await.unwrap());
        let rows = store.list(10).await.unwrap();
        assert!(rows.is_empty());
        let _ = store.clear().await.unwrap();
    }

    #[test]
    fn vector_roundtrip() {
        let v: Vec<f32> = vec![0.1, 0.2, -0.3, 1.5];
        let bytes = vec_f32_to_bytes(&v);
        let back = bytes_to_vec_f32(&bytes);
        for (a, b) in v.iter().zip(back.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }
}
