use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub const SCHEMA_VERSION: &str = "1";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Block {
    pub id: String,
    pub seq: i64,
    pub rev: i64,
    pub sort_key: String,
    pub nonce: Vec<u8>,
    pub ct: Vec<u8>,
    pub deleted: bool,
}

#[derive(Debug, PartialEq)]
pub enum PutResult {
    Ok { seq: i64, rev: i64 },
    Conflict { rev: i64, seq: i64 },
}

#[derive(Debug, PartialEq)]
pub enum DeleteResult {
    Ok { seq: i64, rev: i64 },
    Conflict { rev: i64, seq: i64 },
    NotFound,
}

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  rev INTEGER NOT NULL,
  sort_key TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS blocks_seq ON blocks(seq);
CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  size INTEGER NOT NULL
);
";

fn row_to_block(r: &rusqlite::Row<'_>) -> rusqlite::Result<Block> {
    Ok(Block {
        id: r.get(0)?,
        seq: r.get(1)?,
        rev: r.get(2)?,
        sort_key: r.get(3)?,
        nonce: r.get(4)?,
        ct: r.get(5)?,
        deleted: r.get::<_, i64>(6)? != 0,
    })
}

const BLOCK_COLS: &str = "id, seq, rev, sort_key, nonce, ciphertext, deleted";

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        Self::from_conn(Connection::open(path)?, true)
    }

    pub fn open_memory() -> rusqlite::Result<Store> {
        Self::from_conn(Connection::open_in_memory()?, false)
    }

    fn from_conn(conn: Connection, wal: bool) -> rusqlite::Result<Store> {
        if wal {
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.pragma_update(None, "synchronous", "FULL")?;
        }
        conn.execute_batch(SCHEMA)?;
        conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?1)",
            params![SCHEMA_VERSION.as_bytes()],
        )?;
        Ok(Store { conn: Arc::new(Mutex::new(conn)) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get_meta(&self) -> rusqlite::Result<Option<Vec<u8>>> {
        self.lock()
            .query_row("SELECT value FROM meta WHERE key='notebook'", [], |r| r.get(0))
            .optional()
    }

    /// Returns false if the notebook was already initialised.
    pub fn init_meta(&self, value: &[u8]) -> rusqlite::Result<bool> {
        let n = self.lock().execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('notebook', ?1)",
            params![value],
        )?;
        Ok(n == 1)
    }

    pub fn put_block(
        &self,
        id: &str,
        expected_rev: i64,
        sort_key: &str,
        nonce: &[u8],
        ct: &[u8],
    ) -> rusqlite::Result<PutResult> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let cur: Option<(i64, i64, i64)> = tx
            .query_row("SELECT rev, seq, deleted FROM blocks WHERE id=?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()?;
        let (cur_rev, cur_seq, deleted) = cur.unwrap_or((0, 0, 0));
        if cur_rev != expected_rev || deleted != 0 {
            return Ok(PutResult::Conflict { rev: cur_rev, seq: cur_seq });
        }
        let seq: i64 = tx.query_row("SELECT COALESCE(MAX(seq),0)+1 FROM blocks", [], |r| r.get(0))?;
        let rev = cur_rev + 1;
        tx.execute(
            "INSERT INTO blocks (id, seq, rev, sort_key, nonce, ciphertext, deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
             ON CONFLICT(id) DO UPDATE SET seq=?2, rev=?3, sort_key=?4, nonce=?5, ciphertext=?6",
            params![id, seq, rev, sort_key, nonce, ct],
        )?;
        tx.commit()?;
        Ok(PutResult::Ok { seq, rev })
    }

    pub fn delete_block(&self, id: &str, expected_rev: i64) -> rusqlite::Result<DeleteResult> {
        let mut conn: std::sync::MutexGuard<'_, Connection> = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let cur: Option<(i64, i64, i64)> = tx
            .query_row("SELECT rev, seq, deleted FROM blocks WHERE id=?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()?;
        let Some((cur_rev, cur_seq, deleted)) = cur else {
            return Ok(DeleteResult::NotFound);
        };
        if deleted != 0 {
            return Ok(DeleteResult::Ok { seq: cur_seq, rev: cur_rev });
        }
        if cur_rev != expected_rev {
            return Ok(DeleteResult::Conflict { rev: cur_rev, seq: cur_seq });
        }
        let seq: i64 = tx.query_row("SELECT COALESCE(MAX(seq),0)+1 FROM blocks", [], |r| r.get(0))?;
        let rev = cur_rev + 1;
        tx.execute(
            "UPDATE blocks SET seq=?2, rev=?3, deleted=1, nonce=x'', ciphertext=x'' WHERE id=?1",
            params![id, seq, rev],
        )?;
        tx.commit()?;
        Ok(DeleteResult::Ok { seq, rev })
    }

    pub fn get_block(&self, id: &str) -> rusqlite::Result<Option<Block>> {
        self.lock()
            .query_row(
                &format!("SELECT {BLOCK_COLS} FROM blocks WHERE id=?1"),
                params![id],
                row_to_block,
            )
            .optional()
    }

    /// Returns up to `limit` blocks with seq > since, ascending, and whether more remain.
    pub fn blocks_since(&self, since: i64, limit: i64) -> rusqlite::Result<(Vec<Block>, bool)> {
        let conn = self.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {BLOCK_COLS} FROM blocks WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2"
        ))?;
        let mut rows: Vec<Block> = stmt
            .query_map(params![since, limit + 1], row_to_block)?
            .collect::<Result<_, _>>()?;
        let more = rows.len() as i64 > limit;
        rows.truncate(limit as usize);
        Ok((rows, more))
    }

    /// Returns true if created, false if the id already existed (blobs are immutable).
    pub fn put_blob(&self, id: &str, nonce: &[u8], ct: &[u8]) -> rusqlite::Result<bool> {
        let n = self.lock().execute(
            "INSERT OR IGNORE INTO blobs (id, nonce, ciphertext, size) VALUES (?1, ?2, ?3, ?4)",
            params![id, nonce, ct, ct.len() as i64],
        )?;
        Ok(n == 1)
    }

    pub fn get_blob(&self, id: &str) -> rusqlite::Result<Option<(Vec<u8>, Vec<u8>)>> {
        self.lock()
            .query_row("SELECT nonce, ciphertext FROM blobs WHERE id=?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()
    }

    pub fn export(&self) -> rusqlite::Result<(Option<Vec<u8>>, Vec<Block>, Vec<(String, Vec<u8>, Vec<u8>)>)> {
        let meta = self.get_meta()?;
        let (blocks, _) = self.blocks_since(0, i64::MAX - 1)?;
        let conn = self.lock();
        let mut stmt = conn.prepare("SELECT id, nonce, ciphertext FROM blobs ORDER BY id")?;
        let blobs = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        Ok((meta, blocks, blobs))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s() -> Store {
        Store::open_memory().unwrap()
    }

    #[test]
    fn insert_then_update_with_correct_rev() {
        let st = s();
        assert_eq!(st.put_block("a", 0, "i", b"n", b"c1").unwrap(), PutResult::Ok { seq: 1, rev: 1 });
        assert_eq!(st.put_block("a", 1, "i", b"n", b"c2").unwrap(), PutResult::Ok { seq: 2, rev: 2 });
        let b = st.get_block("a").unwrap().unwrap();
        assert_eq!((b.rev, b.seq, b.ct), (2, 2, b"c2".to_vec()));
    }

    #[test]
    fn stale_rev_is_rejected() {
        let st = s();
        st.put_block("a", 0, "i", b"n", b"c1").unwrap();
        st.put_block("a", 1, "i", b"n", b"c2").unwrap();
        assert_eq!(st.put_block("a", 1, "i", b"n", b"c3").unwrap(), PutResult::Conflict { rev: 2, seq: 2 });
        assert_eq!(st.put_block("a", 0, "i", b"n", b"c3").unwrap(), PutResult::Conflict { rev: 2, seq: 2 });
        assert_eq!(st.get_block("a").unwrap().unwrap().ct, b"c2".to_vec());
    }

    #[test]
    fn new_block_must_expect_rev_zero() {
        let st = s();
        assert_eq!(st.put_block("a", 3, "i", b"n", b"c").unwrap(), PutResult::Conflict { rev: 0, seq: 0 });
    }

    #[test]
    fn tombstone_is_synced_and_blocks_resurrection() {
        let st = s();
        st.put_block("a", 0, "i", b"n", b"c").unwrap();
        assert_eq!(st.delete_block("a", 1).unwrap(), DeleteResult::Ok { seq: 2, rev: 2 });
        let (rows, _) = st.blocks_since(1, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].deleted && rows[0].ct.is_empty());
        assert!(matches!(st.put_block("a", 2, "i", b"n", b"c").unwrap(), PutResult::Conflict { .. }));
        assert_eq!(st.delete_block("zzz", 0).unwrap(), DeleteResult::NotFound);
    }

    #[test]
    fn seq_is_monotonic_and_ordered() {
        let st = s();
        st.put_block("a", 0, "i", b"n", b"1").unwrap();
        st.put_block("b", 0, "j", b"n", b"2").unwrap();
        st.put_block("a", 1, "i", b"n", b"3").unwrap();
        let (rows, more) = st.blocks_since(0, 10).unwrap();
        assert!(!more);
        assert_eq!(rows.iter().map(|b| (b.id.as_str(), b.seq)).collect::<Vec<_>>(), vec![("b", 2), ("a", 3)]);
        let (rows, more) = st.blocks_since(0, 1).unwrap();
        assert!(more && rows.len() == 1);
        let (rows, _) = st.blocks_since(2, 10).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn meta_initialises_once() {
        let st = s();
        assert!(st.get_meta().unwrap().is_none());
        assert!(st.init_meta(b"one").unwrap());
        assert!(!st.init_meta(b"two").unwrap());
        assert_eq!(st.get_meta().unwrap().unwrap(), b"one".to_vec());
    }

    #[test]
    fn blobs_are_immutable() {
        let st = s();
        assert!(st.put_blob("x", b"n", b"c").unwrap());
        assert!(!st.put_blob("x", b"n2", b"c2").unwrap());
        assert_eq!(st.get_blob("x").unwrap().unwrap(), (b"n".to_vec(), b"c".to_vec()));
        assert!(st.get_blob("nope").unwrap().is_none());
    }
}
