import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const PORT = 18080 + Math.floor(Math.random() * 500);
globalThis.CAPNSLOG_BASE = `http://127.0.0.1:${PORT}`;

const require = createRequire(import.meta.url);
const hashwasm = require('../../web/vendor/argon2.umd.min.js');

const { between, cmpKey } = await import('../../web/sortkey.js');
const C = await import('../../web/crypto.js');
const { Notebook, HIST_MAX, SNAP_IDLE } = await import('../../web/sync.js');
const api = await import('../../web/api.js');

C.setKdfRunner(async (pass, salt, k) =>
  hashwasm.argon2id({ password: pass, salt, parallelism: k.p, iterations: k.t, memorySize: k.m, hashLength: 32, outputType: 'binary' }));
const FAST = { alg: 'argon2id', m: 8192, t: 1, p: 1 };

let server, dir;
const bin = join('target', 'debug', process.platform === 'win32' ? 'capnslog.exe' : 'capnslog');

before(async () => {
  assert.ok(existsSync(bin), 'run `cargo build` first');
  dir = mkdtempSync(join(tmpdir(), 'capnslog-'));
  server = spawn(bin, ['--bind', `127.0.0.1:${PORT}`, '--data-dir', dir], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${globalThis.CAPNSLOG_BASE}/api/status`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => {
  server?.kill();
  setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* db still locked */ } }, 500).unref();
});

test('sort keys stay strictly ordered', () => {
  const keys = [between('', null)];
  for (let i = 0; i < 200; i++) keys.push(between(keys[keys.length - 1], null));
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1] < keys[i]);
  const a = 'i';
  let b = 'j';
  for (let i = 0; i < 60; i++) { const m = between(a, b); assert.ok(a < m && m < b, `${a} < ${m} < ${b}`); b = m; }
  assert.ok(between('', 'i') < 'i');
  assert.ok(between('i', 'ii') > 'i' && between('i', 'ii') < 'ii');
  assert.equal(cmpKey('a', 'x', 'a', 'y'), -1);
});

let key, meta;
const hooks = () => ({ events: [], last: '', onStatus(t) { this.last = t; }, onUpsert(e, n) { this.events.push(['up', e.id, n]); }, onRemove(id) { this.events.push(['rm', id]); } });

test('crypto: wrong passkey is rejected, right passkey unlocks', async () => {
  const made = await C.createNotebook('correct horse battery', FAST);
  meta = made.meta;
  await assert.rejects(C.unlockNotebook(meta, 'wrong passkey!!'), C.WrongPassError);
  key = await C.unlockNotebook(meta, 'correct horse battery');
  await assert.rejects(C.unlockNotebook({ ...meta, kdf: { ...meta.kdf, m: 1 << 30 } }, 'x'), /out-of-range/);
  const r = await api.req('PUT', '/api/meta', { json: meta });
  assert.equal(r.status, 201);
});

test('two devices sync, conflicts keep both versions, server sees only ciphertext', async () => {
  const ha = hooks(), hb = hooks();
  const A = new Notebook(key, ha), B = new Notebook(key, hb);
  const SECRET = 'my very secret note text';

  const n = A.create('note', { text: SECRET });
  await A.syncNow();
  await B.syncNow();
  assert.equal(B.model.get(n.id)?.d.text, SECRET, "B receives A's note");
  assert.ok(B.model.get(n.id).ts.c > 0);

  A.model.get(n.id).d.text = 'edited on A';
  A.touch(n.id);
  await A.flush();
  await B.syncNow();
  assert.equal(B.model.get(n.id).d.text, 'edited on A');

  // Both edit from the same base: B pushes first, then A's stale push must become a copy.
  B.model.get(n.id).d.text = 'B wins';
  B.touch(n.id);
  await B.flush();
  A.model.get(n.id).d.text = 'A loses';
  A.touch(n.id);
  await A.flush();
  assert.match(ha.last, /Conflict/);
  assert.equal(A.model.get(n.id).d.text, 'B wins');
  const copies = [...A.model.values()].filter((e) => e.d.text === 'A loses');
  assert.equal(copies.length, 1, 'local edit survives as a copy');
  await A.flush();
  await B.syncNow();
  assert.equal([...B.model.values()].filter((e) => e.d.text === 'A loses').length, 1, 'copy reaches B');

  const dump = await (await api.req('GET', '/api/export')).text();
  for (const s of [SECRET, 'edited on A', 'B wins', 'A loses', '"ts"', '"text"']) assert.ok(!dump.includes(s), `plaintext leaked: ${s}`);
  assert.ok(!/created_at|updated_at/.test(dump));

  // AAD binds id and revision, so a block cannot be moved to another id.
  const recs = (await (await api.req('GET', '/api/blocks?since=0')).json()).blocks;
  const [r1, r2] = recs;
  await assert.rejects(C.decryptJSON(key, C.unb64(r1.nonce), C.unb64(r1.ct), C.blockAad(r2.id, r1.rev)));

  B.remove(n.id);
  await B.flush();
  await A.syncNow();
  assert.ok(!A.model.has(n.id));
  assert.ok(ha.events.some((e) => e[0] === 'rm' && e[1] === n.id));
});

test('history: idle-gated snapshots, capped at 8, restorable, synced', async () => {
  const A = new Notebook(key, hooks()), B = new Notebook(key, hooks());
  const n = A.create('note', { text: 'v0' });
  const edit = (nb, id, text, idle = true) => {
    const e = nb.model.get(id);
    if (idle) e.ts.e -= SNAP_IDLE + 1000;
    e.d.text = text;
    nb.touch(id);
  };
  edit(A, n.id, 'v1');
  assert.deepEqual(A.model.get(n.id).hist.map((s) => s.d.text), ['v0']);
  edit(A, n.id, 'v1b', false); // same editing session: no new snapshot
  assert.equal(A.model.get(n.id).hist.length, 1);
  for (let i = 2; i <= 12; i++) edit(A, n.id, 'v' + i);
  const hist = A.model.get(n.id).hist;
  assert.equal(hist.length, HIST_MAX, 'capped');
  assert.equal(hist[0].d.text, 'v11');
  await A.flush();
  await B.syncNow();
  assert.deepEqual(B.model.get(n.id).hist.map((s) => s.d.text), hist.map((s) => s.d.text), 'history syncs');

  assert.ok(B.restore(n.id, 2)); // v9
  const be = B.model.get(n.id);
  assert.equal(be.d.text, 'v9');
  assert.equal(be.hist[0].d.text, 'v12', 'pre-restore state is kept');
  assert.equal(be.hist.length, HIST_MAX);
  await B.flush();
  await A.syncNow();
  assert.equal(A.model.get(n.id).d.text, 'v9', 'restore propagates');
  assert.ok(!B.restore(n.id, 99));

  const dump = await (await api.req('GET', '/api/export')).text();
  assert.ok(!dump.includes('"hist"'), 'history is encrypted');
});

test('persisted index: shards sync encrypted and a fresh device finds tokens without block text', async () => {
  const { SearchIndex } = await import('../../web/search.js');
  const A = new Notebook(key, hooks());
  const ixA = new SearchIndex();
  const n = A.create('note', { text: 'the quokkaword lives here' });
  const m = A.create('note', { text: 'unrelated gardening text' });
  for (const e of [n, m]) ixA.set(e.id, e.d.text, e.ts.c);
  for (const s of ixA.takeDirty()) A.putSys(`ixshard-${s}`, '$ix', await ixA.exportShard(s));
  await A.flush();

  const ixB = new SearchIndex();
  const hb = { ...hooks(), onSys: async (e) => { if (e.t === '$ix') await ixB.importShard(+e.id.slice(8), e.d); } };
  const B = new Notebook(key, hb);
  await B.syncNow();
  assert.ok(ixB.post.get('quokkaword')?.has(n.id), 'token found from the synced shard alone');
  assert.ok(!ixB.post.get('quokkaword')?.has(m.id));
  assert.equal(B.blocks().length >= 2, true);

  // incremental: only the shard of the changed token is re-exported
  ixA.set(n.id, 'the platypusword lives here', n.ts.c);
  const dirty = ixA.takeDirty();
  assert.ok(dirty.length >= 1 && dirty.length <= 4, 'few shards touched: ' + dirty.length);
  for (const s of dirty) A.putSys(`ixshard-${s}`, '$ix', await ixA.exportShard(s));
  await A.flush();
  await B.syncNow();
  assert.ok(!ixB.post.get('quokkaword') && ixB.post.get('platypusword')?.has(n.id));

  const dump = await (await api.req('GET', '/api/export')).text();
  assert.ok(!dump.includes('quokkaword') && !dump.includes('platypusword'), 'index is encrypted on the server');
});

test('sections: nesting, shared blocks, relink after unlink, unfiled, synced and encrypted', async () => {
  const { Sections, UNFILED } = await import('../../web/sections.js');
  const A = new Notebook(key, hooks()), B = new Notebook(key, hooks());
  const sa = new Sections(A), sb = new Sections(B);
  const blk = A.create('note', { text: 'shared todo' });
  const work = sa.add('Zq-Work'), proj = sa.add('Zq-Project', work), home = sa.add('Zq-Home');
  assert.ok(sa.inSection(blk.id, UNFILED), 'starts unfiled');
  await sa.link(blk.id, proj);
  await sa.link(blk.id, proj); // idempotent
  await sa.link(blk.id, home);
  assert.equal(sa.direct(blk.id).size, 2);
  assert.ok(sa.inSection(blk.id, work), 'a parent includes its subsections');
  assert.deepEqual(sa.path(proj), ['Zq-Work', 'Zq-Project']);
  await A.flush();
  await B.syncNow();
  assert.equal(sb.direct(blk.id).size, 2, 'links sync');
  assert.deepEqual(sb.path(proj), ['Zq-Work', 'Zq-Project']);

  sa.unlink(blk.id, home);
  await A.flush();
  await sa.link(blk.id, home); // the old link record is tombstoned: a new generation id is used
  await A.flush();
  await B.syncNow();
  sb.invalidate(); // the app does this from its onSys hook
  assert.ok(sb.direct(blk.id).has(home), 'relinked after unlink');

  sa.remove(work); // child re-parents to root, links to the deleted section vanish
  await A.flush();
  await B.syncNow();
  sb.invalidate();
  assert.equal(sb.get(proj).parent, null);
  assert.ok(sb.get(work) === undefined);
  assert.equal(sb.move(proj, proj), false, 'cannot parent a section under itself');
  sa.unlinkAll(blk.id);
  assert.ok(sa.inSection(blk.id, UNFILED), 'unfiled again');
  await A.flush();

  const dump = await (await api.req('GET', '/api/export')).text();
  assert.ok(!dump.includes('Zq-Work') && !dump.includes('Zq-Home'), 'section names are encrypted');
});

test('zip reader handles stored and deflated entries', async () => {
  const { readZip } = await import('../../web/importer.js');
  const zlib = await import('node:zlib');
  const enc = new TextEncoder();
  const files = [['a.txt', enc.encode('hello stored'), 0], ['dir/b.xml', enc.encode('<x>' + 'deflate me '.repeat(50) + '</x>'), 8]];
  const parts = [], cd = [];
  let off = 0;
  for (const [name, raw, method] of files) {
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, Buffer.from(data));
    cd.push(ch, nm);
    off += 30 + nm.length + data.length;
  }
  const cdBuf = Buffer.concat(cd);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(2, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  const zip = readZip(new Uint8Array(Buffer.concat([...parts, cdBuf, end])));
  assert.deepEqual(zip.names(), ['a.txt', 'dir/b.xml']);
  assert.equal(await zip.text('a.txt'), 'hello stored');
  assert.ok((await zip.text('dir/b.xml')).startsWith('<x>deflate me '));
  assert.throws(() => readZip(new Uint8Array(100)), /Not a zip/);
});

test('a wrong-key device cannot read blocks', async () => {
  const { key: other } = await C.createNotebook('another passkey 123', FAST);
  const h = hooks();
  const X = new Notebook(other, h);
  await X.syncNow();
  assert.equal(X.model.size, 0);
  assert.match(h.last, /could not be decrypted/);
});
