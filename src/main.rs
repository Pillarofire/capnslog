use capnslog::{router, AppState, Store};
use clap::Parser;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Parser)]
#[command(version, about = "Capnslog: encrypted notebook server (stores ciphertext only)")]
struct Args {
    /// Address to listen on. Keep this on loopback and put Tailscale in front.
    // #[arg(long, env = "CAPNSLOG_BIND", default_value = "127.0.0.1:8080")]
    #[arg(long, env = "CAPNSLOG_BIND", default_value = "127.0.0.1:8080")]
    bind: SocketAddr,
    /// Directory for the SQLite database. Defaults to the per-user data directory.
    #[arg(long, env = "CAPNSLOG_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// Optional bearer token required for all writes.
    #[arg(long, env = "CAPNSLOG_TOKEN", hide_env_values = true)]
    token: Option<String>,
}

fn default_data_dir() -> PathBuf {
    directories::ProjectDirs::from("", "", "capnslog")
        .map(|d| d.data_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from("data"))
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let dir = args.data_dir.unwrap_or_else(default_data_dir);
    std::fs::create_dir_all(&dir)?;
    let db = dir.join("capnslog.db");
    let store = Store::open(&db)?;

    if !args.bind.ip().is_loopback() {
        eprintln!("warning: listening on non-loopback address {}; put TLS and a token in front", args.bind);
    }
    let state = AppState::new(store, args.token);
    let listener = tokio::net::TcpListener::bind(args.bind).await?;
    println!("capnslog listening on http://{}  (db: {})", args.bind, db.display());
    axum::serve(listener, router(state)).with_graceful_shutdown(shutdown()).await?;
    Ok(())
}
