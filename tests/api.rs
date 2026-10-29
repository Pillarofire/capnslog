use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use capnslog::{router, AppState, Store};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

fn app(token: Option<&str>) -> Router {
    router(AppState::new(Store::open_memory().unwrap(), token.map(String::from)))
}

async fn call(app: &Router, method: Method, uri: &str, headers: &[(&str, &str)], body: Vec<u8>) -> (StatusCode, Vec<u8>, axum::http::HeaderMap) {
    let mut b = Request::builder().method(method).uri(uri);
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    let res = app.clone().oneshot(b.body(Body::from(body)).unwrap()).await.unwrap();
    let status = res.status();
    let hdrs = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, bytes, hdrs)
}

fn block_body(sort_key: &str, ct_len: usize) -> Vec<u8> {
    json!({ "sort_key": sort_key, "nonce": B64.encode([1u8; 12]), "ct": B64.encode(vec![7u8; ct_len]) })
        .to_string()
        .into_bytes()
}

const JSON: (&str, &str) = ("content-type", "application/json");

#[tokio::test]
async fn happy_path() {
    let a = app(None);
    let (s, b, h) = call(&a, Method::GET, "/api/status", &[], vec![]).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(serde_json::from_slice::<Value>(&b).unwrap()["initialized"], false);
    assert_eq!(h.get("cache-control").unwrap(), "no-store");
    assert!(h.get("content-security-policy").is_some());
    assert_eq!(h.get("x-content-type-options").unwrap(), "nosniff");
    assert_eq!(h.get("referrer-policy").unwrap(), "no-referrer");

    assert_eq!(call(&a, Method::GET, "/api/meta", &[], vec![]).await.0, StatusCode::NOT_FOUND);
    let meta = br#"{"kdf":"argon2id"}"#.to_vec();
    assert_eq!(call(&a, Method::PUT, "/api/meta", &[JSON], meta.clone()).await.0, StatusCode::CREATED);
    assert_eq!(call(&a, Method::PUT, "/api/meta", &[JSON], meta.clone()).await.0, StatusCode::CONFLICT);
    assert_eq!(call(&a, Method::GET, "/api/meta", &[], vec![]).await.1, meta);

    let (s, b, _) = call(&a, Method::PUT, "/api/blocks/block-0001", &[JSON, ("if-match", "0")], block_body("i", 40)).await;
    assert_eq!(s, StatusCode::OK);
    let v: Value = serde_json::from_slice(&b).unwrap();
    assert_eq!((v["seq"].as_i64(), v["rev"].as_i64()), (Some(1), Some(1)));

    let (_, b, _) = call(&a, Method::GET, "/api/blocks?since=0", &[], vec![]).await;
    let v: Value = serde_json::from_slice(&b).unwrap();
    assert_eq!(v["blocks"].as_array().unwrap().len(), 1);
    assert_eq!(v["blocks"][0]["sort_key"], "i");

    let (s, _, _) = call(&a, Method::DELETE, "/api/blocks/block-0001", &[("if-match", "1")], vec![]).await;
    assert_eq!(s, StatusCode::OK);
    let (_, b, _) = call(&a, Method::GET, "/api/blocks?since=1", &[], vec![]).await;
    assert_eq!(serde_json::from_slice::<Value>(&b).unwrap()["blocks"][0]["deleted"], true);

    let blob = vec![9u8; 60];
    assert_eq!(call(&a, Method::PUT, "/api/blobs/blob-00001", &[], blob.clone()).await.0, StatusCode::CREATED);
    assert_eq!(call(&a, Method::GET, "/api/blobs/blob-00001", &[], vec![]).await.1, blob);
    let (s, b, _) = call(&a, Method::GET, "/api/export", &[], vec![]).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(serde_json::from_slice::<Value>(&b).unwrap()["blobs"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn stale_rev_returns_409() {
    let a = app(None);
    call(&a, Method::PUT, "/api/blocks/block-0001", &[JSON, ("if-match", "0")], block_body("i", 40)).await;
    let (s, b, _) = call(&a, Method::PUT, "/api/blocks/block-0001", &[JSON, ("if-match", "0")], block_body("i", 40)).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(serde_json::from_slice::<Value>(&b).unwrap()["rev"], 1);
    let (s, _, _) = call(&a, Method::PUT, "/api/blocks/block-0001", &[JSON], block_body("i", 40)).await;
    assert_eq!(s, StatusCode::PRECONDITION_REQUIRED);
}

#[tokio::test]
async fn rejects_malformed_requests() {
    let a = app(None);
    let put = |id: &'static str, body: Vec<u8>| {
        let a = a.clone();
        async move { call(&a, Method::PUT, &format!("/api/blocks/{id}"), &[JSON, ("if-match", "0")], body).await.0 }
    };
    assert_eq!(put("short", block_body("i", 40)).await, StatusCode::BAD_REQUEST);
    assert_eq!(put("..%2f..%2fetc", block_body("i", 40)).await, StatusCode::BAD_REQUEST);
    assert_eq!(put("block-0001", block_body("BAD KEY", 40)).await, StatusCode::BAD_REQUEST);
    assert_eq!(put("block-0001", block_body("i", 4)).await, StatusCode::BAD_REQUEST);
    assert_eq!(put("block-0001", b"not json".to_vec()).await, StatusCode::BAD_REQUEST);
    let bad_nonce = json!({ "sort_key": "i", "nonce": B64.encode([1u8; 3]), "ct": B64.encode([7u8; 40]) });
    assert_eq!(put("block-0001", bad_nonce.to_string().into_bytes()).await, StatusCode::BAD_REQUEST);
    assert_eq!(call(&a, Method::PUT, "/api/meta", &[JSON], b"[1]".to_vec()).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(call(&a, Method::PUT, "/api/blobs/blob-00001", &[], vec![0; 5]).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn rejects_oversized_bodies() {
    let a = app(None);
    let big = vec![0u8; 9 * 1024];
    assert_eq!(call(&a, Method::PUT, "/api/meta", &[JSON], big).await.0, StatusCode::PAYLOAD_TOO_LARGE);
    let huge = block_body("i", 9 * 1024 * 1024);
    let (s, _, _) = call(&a, Method::PUT, "/api/blocks/block-0001", &[JSON, ("if-match", "0")], huge).await;
    assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn token_protects_writes_only() {
    let a = app(Some("sekret"));
    assert_eq!(call(&a, Method::GET, "/api/blocks", &[], vec![]).await.0, StatusCode::OK);
    let h = [JSON, ("if-match", "0")];
    assert_eq!(call(&a, Method::PUT, "/api/blocks/block-0001", &h, block_body("i", 40)).await.0, StatusCode::UNAUTHORIZED);
    let bad = [JSON, ("if-match", "0"), ("authorization", "Bearer nope")];
    assert_eq!(call(&a, Method::PUT, "/api/blocks/block-0001", &bad, block_body("i", 40)).await.0, StatusCode::UNAUTHORIZED);
    let ok = [JSON, ("if-match", "0"), ("authorization", "Bearer sekret")];
    assert_eq!(call(&a, Method::PUT, "/api/blocks/block-0001", &ok, block_body("i", 40)).await.0, StatusCode::OK);
}

#[tokio::test]
async fn cross_origin_writes_are_refused() {
    let a = app(None);
    let h = [JSON, ("if-match", "0"), ("host", "notes.ts.net"), ("origin", "https://evil.example")];
    assert_eq!(call(&a, Method::PUT, "/api/blocks/block-0001", &h, block_body("i", 40)).await.0, StatusCode::FORBIDDEN);
    let h = [JSON, ("if-match", "0"), ("host", "notes.ts.net"), ("origin", "https://notes.ts.net")];
    assert_eq!(call(&a, Method::PUT, "/api/blocks/block-0001", &h, block_body("i", 40)).await.0, StatusCode::OK);
}

#[tokio::test]
async fn write_rate_limit_kicks_in() {
    let a = app(None);
    let mut limited = false;
    for i in 0..200 {
        let (s, _, _) = call(&a, Method::PUT, &format!("/api/blocks/block-{i:04}"), &[JSON, ("if-match", "0")], block_body("i", 40)).await;
        if s == StatusCode::TOO_MANY_REQUESTS {
            limited = true;
            break;
        }
    }
    assert!(limited);
}

#[tokio::test]
async fn serves_embedded_front_end() {
    let a = app(None);
    let (s, b, h) = call(&a, Method::GET, "/", &[], vec![]).await;
    assert_eq!(s, StatusCode::OK);
    assert!(String::from_utf8_lossy(&b).contains("<html"));
    assert!(h.get(header::CONTENT_TYPE).unwrap().to_str().unwrap().starts_with("text/html"));
    assert_eq!(call(&a, Method::GET, "/nope.txt", &[], vec![]).await.0, StatusCode::NOT_FOUND);
}
