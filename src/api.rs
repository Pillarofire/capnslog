use crate::store::{Block, DeleteResult, PutResult, Store};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, put},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const MAX_BLOCK_CT: usize = 8 * 1024 * 1024;
const MAX_BLOB: usize = 64 * 1024 * 1024;
const MAX_META: usize = 8 * 1024;
const NONCE_LEN: usize = 12;
const GCM_TAG_LEN: usize = 16;
const PAGE_LIMIT: i64 = 500;

pub const CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; \
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; \
media-src 'self' data: blob: http: https:; frame-src http: https:; connect-src 'self'; \
worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'none'; \
form-action 'none'; frame-ancestors 'none'";

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub token: Option<Arc<String>>,
    limiter: Arc<Mutex<Bucket>>,
}

struct Bucket {
    tokens: f64,
    last: Instant,
}

impl AppState {
    pub fn new(store: Store, token: Option<String>) -> Self {
        AppState {
            store,
            token: token.filter(|t| !t.is_empty()).map(Arc::new),
            limiter: Arc::new(Mutex::new(Bucket { tokens: 60.0, last: Instant::now() })),
        }
    }

    fn allow_write(&self) -> bool {
        let mut b = self.limiter.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let dt = now.duration_since(b.last).as_secs_f64();
        b.last = now;
        b.tokens = (b.tokens + dt * 30.0).min(60.0);
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

type ApiResult<T> = Result<T, (StatusCode, Json<Value>)>;

fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<Value>) {
    (code, Json(json!({ "error": msg })))
}

fn internal<E>(_: E) -> (StatusCode, Json<Value>) {
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

fn valid_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn valid_sort_key(k: &str) -> bool {
    (1..=64).contains(&k.len()) && k.bytes().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    let mut d = (a.len() ^ b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        d |= a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0);
    }
    d == 0
}

async fn blocking<T: Send + 'static>(
    st: &Store,
    f: impl FnOnce(Store) -> rusqlite::Result<T> + Send + 'static,
) -> ApiResult<T> {
    let st = st.clone();
    tokio::task::spawn_blocking(move || f(st))
        .await
        .map_err(internal)?
        .map_err(internal)
}

fn parse_if_match(h: &HeaderMap) -> ApiResult<i64> {
    h.get("if-match")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().trim_matches('"').parse::<i64>().ok())
        .filter(|v| *v >= 0)
        .ok_or_else(|| err(StatusCode::PRECONDITION_REQUIRED, "If-Match: <rev> required"))
}

#[derive(Serialize)]
struct BlockOut {
    id: String,
    seq: i64,
    rev: i64,
    sort_key: String,
    nonce: String,
    ct: String,
    deleted: bool,
}

fn block_out(b: Block) -> BlockOut {
    BlockOut {
        id: b.id,
        seq: b.seq,
        rev: b.rev,
        sort_key: b.sort_key,
        nonce: B64.encode(b.nonce),
        ct: B64.encode(b.ct),
        deleted: b.deleted,
    }
}

async fn status(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    let init = blocking(&s.store, |st| st.get_meta()).await?.is_some();
    Ok(Json(json!({ "initialized": init, "auth_required": s.token.is_some() })))
}

async fn get_meta(State(s): State<AppState>) -> ApiResult<Response> {
    match blocking(&s.store, |st| st.get_meta()).await? {
        Some(v) => Ok(([(header::CONTENT_TYPE, "application/json")], v).into_response()),
        None => Err(err(StatusCode::NOT_FOUND, "not initialised")),
    }
}

async fn put_meta(State(s): State<AppState>, body: Bytes) -> ApiResult<StatusCode> {
    if body.len() > MAX_META {
        return Err(err(StatusCode::PAYLOAD_TOO_LARGE, "too large"));
    }
    match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Object(_)) => {}
        _ => return Err(err(StatusCode::BAD_REQUEST, "meta must be a JSON object")),
    }
    let created = blocking(&s.store, move |st| st.init_meta(&body)).await?;
    if created {
        Ok(StatusCode::CREATED)
    } else {
        Err(err(StatusCode::CONFLICT, "already initialised"))
    }
}

#[derive(Deserialize)]
struct SinceQ {
    since: Option<i64>,
}

async fn list_blocks(State(s): State<AppState>, Query(q): Query<SinceQ>) -> ApiResult<Json<Value>> {
    let since = q.since.unwrap_or(0).max(0);
    let (rows, more) = blocking(&s.store, move |st| st.blocks_since(since, PAGE_LIMIT)).await?;
    let blocks: Vec<BlockOut> = rows.into_iter().map(block_out).collect();
    Ok(Json(json!({ "blocks": blocks, "more": more })))
}

async fn get_block(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<BlockOut>> {
    if !valid_id(&id) {
        return Err(err(StatusCode::BAD_REQUEST, "bad id"));
    }
    match blocking(&s.store, move |st| st.get_block(&id)).await? {
        Some(b) => Ok(Json(block_out(b))),
        None => Err(err(StatusCode::NOT_FOUND, "not found")),
    }
}

#[derive(Deserialize)]
struct PutBlockBody {
    sort_key: String,
    nonce: String,
    ct: String,
}

async fn put_block(
    State(s): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PutBlockBody>,
) -> ApiResult<Response> {
    if !valid_id(&id) {
        return Err(err(StatusCode::BAD_REQUEST, "bad id"));
    }
    let expected = parse_if_match(&headers)?;
    if !valid_sort_key(&body.sort_key) {
        return Err(err(StatusCode::BAD_REQUEST, "bad sort_key"));
    }
    let nonce = B64.decode(&body.nonce).map_err(|_| err(StatusCode::BAD_REQUEST, "bad nonce"))?;
    let ct = B64.decode(&body.ct).map_err(|_| err(StatusCode::BAD_REQUEST, "bad ct"))?;
    if nonce.len() != NONCE_LEN || ct.len() < GCM_TAG_LEN {
        return Err(err(StatusCode::BAD_REQUEST, "bad nonce or ciphertext length"));
    }
    if ct.len() > MAX_BLOCK_CT {
        return Err(err(StatusCode::PAYLOAD_TOO_LARGE, "block too large"));
    }
    let sk = body.sort_key;
    let res = blocking(&s.store, move |st| st.put_block(&id, expected, &sk, &nonce, &ct)).await?;
    Ok(match res {
        PutResult::Ok { seq, rev } => Json(json!({ "seq": seq, "rev": rev })).into_response(),
        PutResult::Conflict { rev, seq } => {
            (StatusCode::CONFLICT, Json(json!({ "error": "conflict", "rev": rev, "seq": seq }))).into_response()
        }
    })
}

async fn delete_block(State(s): State<AppState>, Path(id): Path<String>, headers: HeaderMap) -> ApiResult<Response> {
    if !valid_id(&id) {
        return Err(err(StatusCode::BAD_REQUEST, "bad id"));
    }
    let expected = parse_if_match(&headers)?;
    let res = blocking(&s.store, move |st| st.delete_block(&id, expected)).await?;
    Ok(match res {
        DeleteResult::Ok { seq, rev } => Json(json!({ "seq": seq, "rev": rev })).into_response(),
        DeleteResult::Conflict { rev, seq } => {
            (StatusCode::CONFLICT, Json(json!({ "error": "conflict", "rev": rev, "seq": seq }))).into_response()
        }
        DeleteResult::NotFound => err(StatusCode::NOT_FOUND, "not found").into_response(),
    })
}

async fn put_blob(State(s): State<AppState>, Path(id): Path<String>, body: Bytes) -> ApiResult<StatusCode> {
    if !valid_id(&id) {
        return Err(err(StatusCode::BAD_REQUEST, "bad id"));
    }
    if body.len() < NONCE_LEN + GCM_TAG_LEN {
        return Err(err(StatusCode::BAD_REQUEST, "blob too short"));
    }
    let created = blocking(&s.store, move |st| st.put_blob(&id, &body[..NONCE_LEN], &body[NONCE_LEN..])).await?;
    Ok(if created { StatusCode::CREATED } else { StatusCode::OK })
}

async fn get_blob(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    if !valid_id(&id) {
        return Err(err(StatusCode::BAD_REQUEST, "bad id"));
    }
    match blocking(&s.store, move |st| st.get_blob(&id)).await? {
        Some((mut n, c)) => {
            n.extend_from_slice(&c);
            Ok((
                [
                    (header::CONTENT_TYPE, "application/octet-stream"),
                    (header::CACHE_CONTROL, "private, max-age=31536000, immutable"),
                ],
                n,
            )
                .into_response())
        }
        None => Err(err(StatusCode::NOT_FOUND, "not found")),
    }
}

async fn export(State(s): State<AppState>) -> ApiResult<Response> {
    let (meta, blocks, blobs) = blocking(&s.store, |st| st.export()).await?;
    let meta: Value = meta.and_then(|m| serde_json::from_slice(&m).ok()).unwrap_or(Value::Null);
    let blocks: Vec<BlockOut> = blocks.into_iter().map(block_out).collect();
    let blobs: Vec<Value> = blobs
        .into_iter()
        .map(|(id, n, c)| json!({ "id": id, "nonce": B64.encode(n), "ct": B64.encode(c) }))
        .collect();
    let body = json!({ "format": "capnslog-export-1", "meta": meta, "blocks": blocks, "blobs": blobs });
    Ok((
        [(header::CONTENT_DISPOSITION, "attachment; filename=\"capnslog-export.json\"")],
        Json(body),
    )
        .into_response())
}

fn is_mutating(m: &Method) -> bool {
    !matches!(*m, Method::GET | Method::HEAD | Method::OPTIONS)
}

async fn guard(State(s): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if path.starts_with("/api/") && is_mutating(req.method()) {
        // Reject cross-site browser writes.
        if let Some(origin) = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
            let host = req.headers().get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
            let oh = origin.split_once("://").map(|(_, h)| h).unwrap_or(origin);
            if oh != host {
                return err(StatusCode::FORBIDDEN, "cross-origin write refused").into_response();
            }
        }
        if let Some(tok) = &s.token {
            let given = req
                .headers()
                .get(header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
                .unwrap_or("");
            if !ct_eq(given.as_bytes(), tok.as_bytes()) {
                return err(StatusCode::UNAUTHORIZED, "token required").into_response();
            }
        }
        if !s.allow_write() {
            let mut r = err(StatusCode::TOO_MANY_REQUESTS, "slow down").into_response();
            r.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
            return r;
        }
    }
    let is_api = path.starts_with("/api/");
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    if is_api && !h.contains_key(header::CACHE_CONTROL) {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    res
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/api/status", get(status))
        .route("/api/meta", get(get_meta).put(put_meta).layer(DefaultBodyLimit::max(MAX_META + 1024)))
        .route("/api/blocks", get(list_blocks))
        .route(
            "/api/blocks/{id}",
            get(get_block)
                .put(put_block)
                .delete(delete_block)
                .layer(DefaultBodyLimit::max(MAX_BLOCK_CT * 4 / 3 + 4096)),
        )
        .route(
            "/api/blobs/{id}",
            put(put_blob).get(get_blob).layer(DefaultBodyLimit::max(MAX_BLOB + 1024)),
        )
        .route("/api/export", get(export));
    api.fallback(crate::assets::serve)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}
