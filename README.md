# Capnslog

An endless, OneNote-style notebook. A single Rust binary serves a plain HTML/JS client and stores **only ciphertext** in SQLite. Encryption happens in the browser (Argon2id → AES-GCM); the server never sees your passkey, text, timestamps or ink.

## Run

```
cargo run --release -- --bind 127.0.0.1:8080
```

Options (also `CAPNSLOG_*` env vars): `--bind`, `--data-dir` (default: per-OS app data dir), `--token` (optional bearer token for writes).

Open the page, choose a passkey (first run), and start writing. **A forgotten passkey is unrecoverable.**

## Raspberry Pi 5 + Tailscale

```
cargo install cargo-zigbuild
cargo zigbuild --release --target aarch64-unknown-linux-musl
```

Copy the binary to `/usr/local/bin/capnslog`, install `deploy/capnslog.service` (create a `capnslog` user), then `sudo systemctl enable --now capnslog`. Expose it privately with `tailscale serve --bg 8080` (gives HTTPS, required for service worker/PWA install on phones). Do not use Funnel.

## Backup

`deploy/backup.sh` makes a consistent copy of `capnslog.db` (ciphertext only). Restore by placing it in the data dir while the server is stopped. `GET /api/export` also returns the encrypted data.

## Tests

```
cargo test
cargo build
node --test tests/client/sync.test.mjs
```

## Notes

- Layout is a continuous flow of blocks (notes, calc, JS, media, pixel-perfect PNG ink) ordered by a fractional sort key; chrome appears only on hover/focus.
- JS/calc cells run only when you press Run and the "code cells" setting is on; the CSP therefore allows `unsafe-eval`.
- Rich-text notes with syntax-highlighted code blocks; each block keeps its edited time and up to 8 restorable snapshots (⚙ in the block's grip).
- Sections are nested and a block can belong to several. The sidebar (☰) lists sections and heading/★-pinned notes; routes are `#/s/<section>` and `#/b/<block>`. Settings choose whether a section click scrolls or filters. Reordering with ↑/↓ works while a section is open.
- Search uses a token index stored as encrypted, compressed shards (`$ix` records); section names, links and the index are all ciphertext on the server.
- Settings > Import OneNote (.docx) converts exported pages in the browser (one section per file).
- Deleting a block does not remove its media blobs (orphans remain).
- Argon2 defaults: 64 MiB, t=3, p=1; tune for your phone in `web/crypto.js`.
- Vendored: hash-wasm (MIT), checksum in `web/vendor/CHECKSUMS.txt`.
