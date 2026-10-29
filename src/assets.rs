use axum::{
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "web/"]
struct Assets;

pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    match Assets::get(path) {
        Some(f) => (
            [
                (header::CONTENT_TYPE, f.metadata.mimetype().to_string()),
                (header::CACHE_CONTROL, "no-cache".to_string()),
            ],
            f.data.into_owned(),
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
