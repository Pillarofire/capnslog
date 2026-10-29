# Capnslog: encrypted endless notebook, agent task plan

Execute the steps in order. Each step has a "Done when" condition; verify it before moving on.

## Decisions

| Topic | Decision |
|---|---|
| Client | Plain HTML, CSS and JS, no build step (`index.html`, `app.js`, `style.css`) |
| Server | One Rust binary (`axum`) that embeds the front-end and exposes a small API |
| Host | Cross-platform server (Windows, macOS, Linux; x86_64 and arm64). Primary deployment target: Raspberry Pi 5, arm64 Linux. |
| KDF | Argon2id (memory-hard), parameters stored in `meta` so they can be upgraded |
| Timestamps | Hidden from the server. Stored only inside the encrypted payload. The server provides an ordering sequence number only. |
| Ink | Pixel-perfect, no antialiasing, stored as one transparent PNG per block. Vector strokes are deferred until performance demands them. |
| Access | Tailscale only (`tailscale serve` for HTTPS, app bound to `127.0.0.1`) |
| Structure | One endless master page that grows over time |
| Encryption | Fully client-side. The server only ever sees ciphertext. |
| Storage | SQLite. Everything sensitive is ciphertext on disk. |
| Search | Done on the client over decrypted text, using a text table with timestamps |
| UX | OneNote-style: borderless notes and ink that flow with the page, chrome only on hover or focus |

## Key design points

1. **The server cannot search ciphertext.** Indexing and search happen in the browser. After unlock, the client decrypts entries, builds an in-memory index (`{blockId, text, timestamp}`), and searches that. Any persisted index is encrypted. Never store plaintext on the server or disk.
2. **Don't store the endless page as one blob.** Each item (note, drawing, media, calc or REPL cell) is its own encrypted block row. Autosave uploads only changed blocks.
3. **Plaintext server-side metadata is limited to:** block id, ordering key, revision, server-assigned change sequence (`seq`), size and a deleted flag. The server stores **no timestamps**. Creation and edit times live only inside the encrypted payload (`ts`), and the client derives date separators and search timestamps from them. Order and sync use `seq`. Do not add `created_at` or `updated_at` columns, and do not log request times alongside block ids in a way that reconstructs them.
4. **Key handling.**
   - Derive the key from the passkey with **Argon2id** (memory-hard). WebCrypto has no Argon2, so vendor a small audited WASM implementation (for example `hash-wasm` or `argon2-browser`) as a static file in `web/vendor/`, with its license and a pinned checksum. This keeps the no-build-step rule. Use the derived 256-bit output as the AES-GCM key.
   - Starting parameters: memory 64 MiB, 3 iterations, parallelism 1. Make them tunable, and benchmark on the phone so unlock takes roughly 1 second or less.
   - Store the salt, KDF id (`argon2id`), version and parameters in `meta` (not secret), so parameters can be raised later by re-encrypting.
   - Store an encrypted "check" value so a wrong passkey is detected without decrypting real data.
   - The passkey and key never leave the browser.
   - Use a fresh random 12-byte IV per encryption. Bind block id and revision as AES-GCM additional data so the server cannot swap blocks.
5. **WebCrypto needs a secure context.** Tailscale HTTPS (`tailscale serve`) provides this on the phone.

## Steps

### Step 1: Rust project scaffold
- Create `Cargo.toml` and `src/` at the repo root.
- Keep the server cross-platform: no Linux-only APIs, use `std::path` for all paths, use pure-Rust or bundled-C dependencies only (no system OpenSSL or system SQLite), and handle shutdown signals portably (`tokio::signal::ctrl_c`, plus SIGTERM under `cfg(unix)`).
- Move the client files to `web/` and embed them with `rust-embed`.
- Use `axum`, `tokio`, `serde`, `serde_json`, `tower-http`, `tracing` and `rusqlite` (feature `bundled`).
- Read `--bind` (default `127.0.0.1:8080`) and `--data-dir` (default `./data`) from the command line or environment.
- **Done when:** `cargo run` serves the current page at `http://127.0.0.1:8080` on Windows and on Linux.

### Step 2: SQLite schema and store layer
Use WAL mode and run SQLite calls inside `spawn_blocking`.

```sql
meta(key TEXT PRIMARY KEY, value BLOB)           -- kdf id/version/params, salt, key-check ciphertext, schema_version
blocks(
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,        -- monotonic change counter, assigned by the server; the only ordering/time signal
  rev INTEGER NOT NULL,
  sort_key TEXT NOT NULL,      -- fractional index for ordering on the endless page
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
)
-- No timestamp columns anywhere. Timestamps are inside the ciphertext.
blobs(id TEXT PRIMARY KEY, nonce BLOB, ciphertext BLOB, size INTEGER)  -- encrypted media
```

- Add an index on `seq`.
- Deletes are tombstones so other devices learn about them.
- **Done when:** unit tests cover insert, update with the correct rev, update with a stale rev (rejected), tombstone, and `seq` ordering.

### Step 3: API

| Route | Purpose |
|---|---|
| `GET /api/meta` | Salt, KDF params and key-check blob. 404 if not initialised. |
| `PUT /api/meta` | One-time initialisation only |
| `GET /api/blocks?since=<seq>` | Changed blocks since a sequence, including tombstones |
| `PUT /api/blocks/:id` | Upsert with `If-Match: <rev>`. 409 on mismatch. |
| `DELETE /api/blocks/:id` | Tombstone |
| `POST /api/blobs`, `GET /api/blobs/:id` | Encrypted media |
| `GET /api/export` | Encrypted backup (JSON) of all rows |

- Cap request body size, validate id format, and never build filesystem paths from user input.
- Set security headers: CSP, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` on API routes.
- Add an optional bearer token (`--token` or environment variable). Mutating routes require it.
- **Done when:** integration tests cover the happy path, 409 handling, and rejection of oversized or malformed requests.

### Step 4: Client crypto and sync layer
New modules: `web/crypto.js` and `web/sync.js`.
- Vendor the Argon2id WASM module into `web/vendor/` (see key design point 4) and wrap it in `crypto.js`. Show a progress indicator while deriving the key, and run it in a Web Worker so the UI doesn't freeze on phones.
- First run: choose a passkey, generate the salt, record the Argon2id parameters, write the key-check blob, call `PUT /api/meta`.
- Later runs: fetch meta, prompt for the passkey, verify with the key-check blob, keep the key in memory only. Offer optional auto-lock after idle.
- Encrypt and decrypt block payloads (JSON with `type`, `x`, `y`, `data`, `ts`, where `ts` holds the created and edited times). Bind block id and rev as AES-GCM additional data.
- Sync: on load, `GET /api/blocks?since=0`, decrypt, render. Afterwards poll or refetch on focus. Autosave sends only dirty blocks, debounced.
- Keep an encrypted IndexedDB cache and an offline write queue that flushes on reconnect.
- On a 409, keep the server copy and the local copy as two blocks and tell the user.
- **Done when:** two browser profiles see each other's edits, and a wrong passkey is rejected cleanly.

### Step 5: Endless master page UI
Rework `app.js` around blocks and a vertical canvas.
- Replace `localStorage` autosave (`autosave`, `serialize`, `restore`, `KEY_PLAIN`, `KEY_ENC`) with the sync layer. Remove the old whole-page lock and unlock flow, since encryption is now always on.
- The page grows downward without limit. Render lazily, only blocks near the viewport.
- "Add a note" appends at the bottom, with a prominent button for the phone.
- Order items by `sort_key`, and show date separators computed client-side from the decrypted `ts`. Optionally add a jump-to-date control.
- **Done when:** the user can add, edit, move and delete items on the endless page, and reloads restore them.

### Step 6: OneNote-style presentation
- In `style.css`, remove border, background and header from notes so text looks typed directly on the page.
- Show the outline and drag grip only on `:hover` or `:focus-within`, with long-press or tap on touch devices.
- Notes auto-size and have no manual resize handle.
- Drawings become transparent ink over the page with no frame. Keep the existing pixel-perfect, no-antialiasing stroke code (`stamp`, `line`).
- Store each ink block as one lossless transparent PNG (`canvas.toDataURL('image/png')` or `toBlob`) inside the encrypted payload. Keep `imageSmoothingEnabled = false` and render at integer scale so edges stay crisp. Do not build vector storage now. Revisit only if performance suffers, and note measurements if so.
- Calc and REPL cells keep subtle styling because they are interactive.
- **Done when:** notes and ink read as one continuous sheet, and controls appear only when needed.

### Step 7: Client-side search
- After unlock and sync, extract text from note blocks (and calc expressions and REPL code) into an in-memory table of `{blockId, text, timestamp}`.
- Build a simple inverted or substring index with no dependencies.
- Add a search box with results that jump to and highlight the block.
- Optionally persist the index to IndexedDB encrypted with the same key. Never persist plaintext.
- Update the index incrementally when blocks change.
- **Done when:** search returns matches within a second on a few thousand blocks, and no plaintext is stored on disk or on the server.

### Step 8: Media
- Encrypt images, video and audio in the browser and upload via `/api/blobs`. The block stores only the blob id and a reference.
- Downscale large photos before upload.
- Remove the base64-in-JSON path in `kinds.media` and the file-drop handlers.
- Validate embed URL schemes (`http`, `https` only).
- **Done when:** a photo taken on the phone appears on the laptop, and the stored blob is unreadable on the server.

### Step 9: Hardening
- Calc and REPL use `eval` and `new Function`, so the CSP needs `unsafe-eval`. Make code cells inert until the user presses Run, and add a setting to disable them.
- Verify no plaintext appears in server logs, the database, the export, or service worker caches.
- Add rate limiting on write routes.

### Step 10: PWA and offline
- Add `manifest.json` and a service worker that caches the static shell only, never API responses.
- **Done when:** the app is installable on the phone and the shell opens offline.

### Step 11: Build, cross-platform support and deploy
- The server must build and run on Windows, macOS and Linux (x86_64 and arm64). Add CI (for example GitHub Actions) that builds and tests on all three operating systems.
- Document native builds (`cargo build --release`) and cross-compiles for the Pi 5: `aarch64-unknown-linux-musl` with `cargo zigbuild` (bundled SQLite needs a C compiler), or `aarch64-unknown-linux-gnu` with `cross`. Include the exact commands.
- Use sensible per-OS default data directories (for example via the `directories` crate), overridable with `--data-dir`.
- Create `deploy/capnslog.service`: systemd unit, unprivileged `capnslog` user, `Restart=always`, `ProtectSystem=strict`, `ReadWritePaths` set to the data directory. Briefly document running as a Windows service or scheduled task, and a launchd plist for macOS.
- Prefer a USB SSD for the data directory, and make sure NTP is enabled.
- Add a nightly backup (`sqlite3 .backup` or `/api/export`) to a separate location.
- Document Tailscale: `tailscale serve --bg 8080`, then open the HTTPS URL on the phone.
- Write `README.md` covering build, deploy, backup and restore, and the warning that **a forgotten passkey means unrecoverable data**.
- **Done when:** CI is green on all three operating systems, the Pi serves the app over Tailscale HTTPS, and the phone can read, edit and add notes.

## Acceptance checklist
- [ ] Phone and laptop edits sync through the Pi.
- [ ] Opening the SQLite file shows only ciphertext and non-sensitive metadata, with no timestamps.
- [ ] Key derivation uses Argon2id with parameters stored in `meta`.
- [ ] Ink is stored as lossless per-block PNGs and stays pixel-perfect.
- [ ] The server builds and runs on Windows, macOS and Linux.
- [ ] The server never receives the passkey or plaintext.
- [ ] Search works over decrypted text with no plaintext persisted anywhere.
- [ ] The page is continuous, with no visually discrete cards.
- [ ] The app runs unattended on the Pi, restarts automatically, and has a tested backup and restore.

## Resolved decisions
- Timestamps are hidden from the server. Only a server `seq` is used for ordering and sync.
- KDF is Argon2id, via a vendored WASM module.
- Ink is stored as per-block lossless PNGs. Vector strokes are deferred.
- The server is cross-platform, with the Pi 5 as the primary deployment target.

## Implementation notes (deviations)
- Blobs use `PUT /api/blobs/{id}` (client-chosen id), not POST.
- Default data dir is the per-OS app data dir.
- The page is a vertical flow of blocks ordered by `sort_key`, not absolutely positioned items.
- Library chosen: `hash-wasm` 4.12.0 (MIT), checksum in `web/vendor/CHECKSUMS.txt`.
- Verified: cargo tests, Node two-device sync test, and a browser run (setup, add, reload, unlock, search). Not yet verified: Pi cross-compile, phone Argon2 timing, CI runs.

## Open items
- Exact Argon2id parameters, to be benchmarked on the actual phone (defaults 64 MiB, t=3, p=1).

## Phase 2: history, sections, import

### Decisions
- Per-note history: 8 snapshots, hidden behind a per-block settings dialog, restorable.
- Search stays client-side. The index is persisted as an encrypted, compressed record (a blind server-side index is a possible later add-on).
- Nested sections, as organisation only. The timeline stays one endless, chronological scroll.
- OneNote import from exported .docx files, parsed in the browser.

### Step 12: Edited time and snapshots
- Show `ts.e` ("edited …") on each block.
- Add `hist: [{ts, d}]` (max 8, newest first) inside the encrypted payload. Snapshot after ~30 s of idle edits.
- Add a gear button in `.grip` before Move Up. It opens a dialog with created/edited times and the snapshot list (time, preview, Restore).
- Restore copies the snapshot into `d` and pushes the prior state onto `hist`. It is saved as a normal change, so it syncs like any edit.
- **Done when:** two devices see the same history, restore works on notes/calc/code, and payload size stays bounded.
- **Status: implemented** (`sync.js` `pushSnap`/`touch`/`restore`, gear dialog in `app.js`, covered by the "history" test in `tests/client/sync.test.mjs`).

### Step 13: Persisted encrypted search index
- Build an inverted index `token -> [blockId]`, compress it, encrypt it with the notebook key, and store it as a synced record (sharded, so edits re-upload only the changed shard).
- On unlock, load and decrypt the index instead of decrypting every block. Update it incrementally on edits and remote changes.
- **Done when:** search works on a new device without decrypting all blocks, and the server only sees an opaque record.
- **Status: implemented, with one deviation.** `web/search.js` keeps a token index in 16 gzip-compressed, encrypted `$ix` shard records (`ixshard-<n>`); only shards whose tokens changed are re-uploaded, and a new device imports them (tested). Blocks are still decrypted on unlock, because the page and snippets need their text, so the shards speed up and sync the index but do not avoid block decryption. System records (`$ix`, `$section`, `$link`) share the block sync path via `Notebook.putSys`.

### Step 14: Nested sections
- Add a `section` record kind (name, parentId, sort key), encrypted like other blocks.
- Membership is stored as encrypted `link` records (blockId, sectionId), one per pair, with an id derived from both so adds are idempotent. A block can belong to several sections; a block with no links shows under "Unfiled". Migration gives every existing block one link to "Unfiled".
- A shared block is one record: editing it changes it in every section. It appears once in the chronological timeline (at its created time) and in every member section when filtering.
- Order: the timeline is chronological by `ts.c`. Manual move up/down only applies inside a section.
- Sidebar: collapsible, hierarchical tree (Section > notes), "All notes" and "Unfiled" entries, counts, `⇄ n` badge on shared blocks, overlay drawer on phones. Notes listed are those starting with a heading plus pinned (★) blocks. Collapse state is stored in the encrypted settings.
- Navigation uses hash routes: `#/s/<sectionId>` and `#/b/<blockId>` (the latter calls `jumpTo`). Clicking a section scrolls to the oldest block in it by default; a setting "Section click: Scroll to first block / Filter timeline" switches it to filtering. In scroll mode, blocks of the active section get a thin edge bar.
- Adding a block to a section: gear dialog "Sections" checkbox tree, chip row under shared blocks (`＋` picker, ✕ to remove), and drag the grip onto a sidebar section (drop = add, Shift+drop = move).
- Deleting a shared block asks: delete everywhere, or remove from this section only.
- **Done when:** sections nest, both click modes work, a block can be added to and removed from several sections by all three methods, and existing notes are unaffected.
- **Status: implemented** (`web/sections.js`, sidebar and routing in `app.js`; tested in "sections" and in the browser). Deviations: collapse state and the click-mode setting live in `localStorage` (they hold no note data); the chip-row `＋` opens the gear dialog's Sections tree; the thin edge bar in scroll mode was not built; link ids add a generation number because the server keeps tombstones forever; there is no migration since Unfiled is simply "no links". ↑/↓ show only while a section is open (filter mode), and new blocks created in an open section are linked to it. Drag-to-section uses HTML5 drag and drop, so it is mouse-only (use the gear dialog on touch).

### Step 15: OneNote import (.docx)
- A file picker accepts .docx exports. Parse in the browser with a vendored unzip library (checksum and license recorded in `web/vendor/CHECKSUMS.txt`).
- Convert document.xml to sanitized HTML note blocks. Images become encrypted media blobs. Ink arrives as images.
- Create a section per imported file. Dates are not available in .docx, so imported blocks use the import time.
- **Done when:** a sample OneNote export imports with text, lists, tables and images preserved, and no plaintext reaches the server.
- **Status: implemented** (`web/importer.js`, Settings > Import). Deviation: instead of vendoring an unzip library it uses a small zip reader on the browser's native `DecompressionStream`, so there is nothing to checksum. Verified in the browser with a synthetic .docx (headings, bold, link, nested and numbered lists, table, image); a real OneNote export has not been tried. Each H1/H2 starts a new note block.

### Acceptance additions
- [x] 8 snapshots per note, restorable from the gear dialog.
- [x] Search works from the persisted encrypted index.
- [x] Nested sections filter the chronological timeline.
- [x] A OneNote .docx export imports correctly (synthetic sample only).
