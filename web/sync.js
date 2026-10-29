import * as api from './api.js';
import { b64, unb64, encryptJSON, decryptJSON, blockAad, newId } from './crypto.js';
import { idb } from './store.js';
import { between } from './sortkey.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNetErr = (e) => e instanceof TypeError;
export const HIST_MAX = 8;
export const SNAP_IDLE = 30000;

class Rejected extends Error {}

// System records ($index shards, $section, $link, ...) sync like blocks but are never rendered as blocks.
export const isSys = (e) => typeof e.t === 'string' && e.t[0] === '$';

/**
 * Model of the endless page: id -> { id, sortKey, t, d, ts:{c,e} }.
 * Revisions live in `revs`. Edits are staged as encrypted records in IndexedDB, then pushed;
 * all network work is serialised through `run` so a push never races a pull.
 */
export class Notebook {
  constructor(key, hooks) {
    this.key = key;
    this.hooks = hooks;
    this.model = new Map();
    this.revs = new Map();
    this.dirty = new Set();
    this.pending = new Map();
    this.tomb = new Set();
    this.undecryptable = new Set();
    this.lastSeq = 0;
    this.chain = Promise.resolve();
    this.timer = null;
    this.poller = null;
    this.online = true;
  }

  run(fn) {
    const p = this.chain.then(() => fn());
    this.chain = p.catch(() => {});
    return p;
  }

  status(t) { this.hooks.onStatus?.(t); }

  async load() {
    this.lastSeq = (await idb.get('kv', 'lastSeq')) || 0;
    for (const rec of await idb.all('blocks')) {
      this.revs.set(rec.id, rec.rev);
      await this.apply(rec, true, true);
    }
    for (const p of await idb.all('pending')) {
      if (p.del) { this.tomb.add(p.id); this.revs.set(p.id, p.baseRev); this.model.delete(p.id); continue; }
      try {
        const plain = await decryptJSON(this.key, unb64(p.nonce), unb64(p.ct), blockAad(p.id, p.baseRev + 1));
        this.revs.set(p.id, p.baseRev);
        this.model.set(p.id, { id: p.id, sortKey: p.sort_key, t: plain.t, d: plain.d, ts: plain.ts, hist: plain.hist || [], _prev: JSON.stringify(plain.d) });
        this.dirty.add(p.id);
      } catch {
        await idb.del('pending', p.id);
      }
    }
    const all = [...this.model.values()];
    for (const e of all) if (isSys(e)) await this.hooks.onSys?.(e, true);
    this.hooks.onLoad?.(all.filter((e) => !isSys(e)));
    if (this.dirty.size || this.tomb.size) this.schedule(0);
  }

  async apply(rec, force = false, silent = false) {
    const cur = this.model.get(rec.id);
    if (rec.deleted) {
      this.revs.set(rec.id, rec.rev);
      if (cur) {
        this.model.delete(rec.id);
        this.dirty.delete(rec.id);
        if (isSys(cur)) { if (!silent) await this.hooks.onSysRemove?.(cur); } else if (!silent) this.hooks.onRemove?.(rec.id);
      }
      return;
    }
    if (!force && (this.dirty.has(rec.id) || this.pending.has(rec.id))) return;
    if (!force && cur && (this.revs.get(rec.id) || 0) >= rec.rev) return;
    let p;
    try {
      p = await decryptJSON(this.key, unb64(rec.nonce), unb64(rec.ct), blockAad(rec.id, rec.rev));
    } catch {
      this.undecryptable.add(rec.id);
      this.status('⚠ a block could not be decrypted');
      return;
    }
    this.undecryptable.delete(rec.id);
    this.revs.set(rec.id, rec.rev);
    const e = cur || { id: rec.id };
    Object.assign(e, { sortKey: rec.sort_key, t: p.t, d: p.d, ts: p.ts || { c: Date.now(), e: Date.now() }, hist: Array.isArray(p.hist) ? p.hist.slice(0, HIST_MAX) : [] });
    e._prev = JSON.stringify(e.d);
    this.model.set(rec.id, e);
    if (isSys(e)) { if (!silent) await this.hooks.onSys?.(e, !cur); } else if (!silent) this.hooks.onUpsert?.(e, !cur);
  }

  blocks() { return [...this.model.values()].filter((e) => !isSys(e)); }
  sys(t) { return [...this.model.values()].filter((e) => e.t === t); }

  // Create or replace a system record. No history; syncs on the next flush.
  putSys(id, t, d) {
    if (this.tomb.has(id) && !this.revs.get(id)) this.tomb.delete(id); // never reached the server: just cancel the delete
    let e = this.model.get(id);
    const now = Date.now();
    if (!e) e = { id, sortKey: '0', t, d, ts: { c: now, e: now }, hist: [] };
    e.d = d;
    e.ts.e = now;
    this.model.set(id, e);
    this.dirty.add(id);
    this.schedule();
    return e;
  }

  appendKey() {
    let max = '';
    for (const e of this.blocks()) if (e.sortKey > max) max = e.sortKey;
    return between(max, null);
  }

  keyAfter(key) {
    let next = null;
    for (const e of this.blocks()) if (e.sortKey > key && (next === null || e.sortKey < next)) next = e.sortKey;
    return between(key, next);
  }

  keyBefore(key) {
    let prev = '';
    for (const e of this.blocks()) if (e.sortKey < key && e.sortKey > prev) prev = e.sortKey;
    return between(prev, key);
  }

  create(t, d, sortKey = this.appendKey()) {
    const now = Date.now();
    const e = { id: newId(), sortKey, t, d, ts: { c: now, e: now }, hist: [], _prev: JSON.stringify(d) };
    this.model.set(e.id, e);
    this.dirty.add(e.id);
    this.hooks.onUpsert?.(e, true);
    this.schedule();
    return e;
  }

  // History: when an edit starts after >= SNAP_IDLE ms of quiet, the state from before the edit is kept (max HIST_MAX).
  pushSnap(e, ts, d) {
    if (!e.hist) e.hist = [];
    if (e.hist[0] && JSON.stringify(e.hist[0].d) === JSON.stringify(d)) return;
    e.hist.unshift({ ts, d });
    if (e.hist.length > HIST_MAX) e.hist.length = HIST_MAX;
  }

  touch(id) {
    const e = this.model.get(id);
    if (!e) return;
    const now = Date.now();
    const cur = JSON.stringify(e.d);
    if (e._prev !== undefined && e._prev !== cur && now - e.ts.e >= SNAP_IDLE) this.pushSnap(e, e.ts.e, JSON.parse(e._prev));
    e._prev = cur;
    e.ts.e = now;
    this.dirty.add(id);
    this.schedule();
  }

  // Restore snapshot i: the current state is kept in history first, so nothing is lost and the restore syncs as a normal edit.
  restore(id, i) {
    const e = this.model.get(id);
    const s = e?.hist?.[i];
    if (!s) return false;
    const target = JSON.parse(JSON.stringify(s.d));
    this.pushSnap(e, e.ts.e, JSON.parse(JSON.stringify(e.d)));
    e.d = target;
    e._prev = JSON.stringify(e.d);
    e.ts.e = Date.now();
    this.dirty.add(id);
    this.hooks.onUpsert?.(e, false);
    this.schedule(0);
    return true;
  }

  setSortKey(id, key) {
    const e = this.model.get(id);
    if (!e) return;
    e.sortKey = key;
    this.touch(id);
  }

  remove(id) {
    const sysFlag = this.model.has(id) && isSys(this.model.get(id));
    if (!this.model.delete(id)) return;
    this.dirty.delete(id);
    this.tomb.add(id);
    if (!sysFlag) this.hooks.onRemove?.(id);
    this.schedule(0);
  }

  schedule(delay = 1500) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  async stage() {
    for (const id of [...this.dirty]) {
      this.dirty.delete(id);
      const e = this.model.get(id);
      if (!e || this.tomb.has(id)) continue;
      e.beforeSave?.();
      const baseRev = this.revs.get(id) || 0;
      const { nonce, ct } = await encryptJSON(this.key, { t: e.t, d: e.d, ts: e.ts, hist: e.hist || [] }, blockAad(id, baseRev + 1));
      const rec = { id, baseRev, sort_key: e.sortKey, nonce: b64(nonce), ct: b64(ct) };
      this.pending.set(id, rec);
      await idb.put('pending', rec);
    }
  }

  async request(method, path, opts) {
    for (let i = 0; ; i++) {
      const r = await api.req(method, path, opts);
      if (r.status === 429 && i < 5) { await sleep(1100); continue; }
      return r;
    }
  }

  async fetchRec(id) {
    const r = await this.request('GET', `/api/blocks/${id}`);
    return r.ok ? r.json() : null;
  }

  async send() {
    for (const rec of [...this.pending.values()]) {
      const r = await this.request('PUT', `/api/blocks/${rec.id}`, {
        headers: { 'If-Match': String(rec.baseRev) },
        json: { sort_key: rec.sort_key, nonce: rec.nonce, ct: rec.ct },
      });
      if (r.ok) {
        const j = await r.json();
        this.pending.delete(rec.id);
        await idb.del('pending', rec.id);
        this.revs.set(rec.id, j.rev);
        await idb.put('blocks', { id: rec.id, seq: j.seq, rev: j.rev, sort_key: rec.sort_key, nonce: rec.nonce, ct: rec.ct, deleted: false });
      } else if (r.status === 409) {
        await this.resolveConflict(rec);
      } else if (r.status === 401) {
        throw new Rejected('Access token required');
      } else {
        this.pending.delete(rec.id);
        await idb.del('pending', rec.id);
        this.status(`⚠ server rejected a block (${r.status})`);
      }
    }
    for (const id of [...this.tomb]) {
      const baseRev = this.revs.get(id) || 0;
      if (!baseRev) { this.tomb.delete(id); await idb.del('pending', id); continue; }
      const r = await this.request('DELETE', `/api/blocks/${id}`, { headers: { 'If-Match': String(baseRev) } });
      if (r.ok) {
        const j = await r.json();
        this.tomb.delete(id);
        await idb.del('pending', id);
        this.revs.set(id, j.rev);
        await idb.put('blocks', { id, seq: j.seq, rev: j.rev, sort_key: '', nonce: '', ct: '', deleted: true });
      } else if (r.status === 409) {
        this.tomb.delete(id);
        await idb.del('pending', id);
        const srv = await this.fetchRec(id);
        if (srv) { await idb.put('blocks', srv); await this.apply(srv, true); this.status('A block you deleted was edited elsewhere; it was kept'); }
      } else if (r.status === 404) {
        this.tomb.delete(id);
        await idb.del('pending', id);
      } else if (r.status === 401) {
        throw new Rejected('Access token required');
      } else {
        throw new Rejected(`delete failed (${r.status})`);
      }
    }
  }

  // Keep both versions: the server copy replaces the local block, and the local edit becomes a new block.
  async resolveConflict(rec) {
    let plain = null;
    try { plain = await decryptJSON(this.key, unb64(rec.nonce), unb64(rec.ct), blockAad(rec.id, rec.baseRev + 1)); } catch { /* unreadable */ }
    this.pending.delete(rec.id);
    await idb.del('pending', rec.id);
    this.dirty.delete(rec.id);
    const srv = await this.fetchRec(rec.id);
    if (srv) {
      await idb.put('blocks', srv);
      await this.apply(srv, true);
    }
    if (plain && String(plain.t)[0] === '$') {
      await this.hooks.onSysConflict?.(plain);
    } else if (plain) {
      const e = { id: newId(), sortKey: this.keyAfter(rec.sort_key), t: plain.t, d: plain.d, ts: { c: plain.ts?.c || Date.now(), e: Date.now() }, hist: plain.hist || [], _prev: JSON.stringify(plain.d) };
      this.model.set(e.id, e);
      this.dirty.add(e.id);
      this.hooks.onUpsert?.(e, true);
    }
    this.status('Conflict: your edit was kept as a copy below the original');
  }

  async pullAll() {
    for (;;) {
      const r = await this.request('GET', `/api/blocks?since=${this.lastSeq}`);
      if (!r.ok) throw new Rejected(`pull failed (${r.status})`);
      const { blocks, more } = await r.json();
      for (const rec of blocks) {
        await idb.put('blocks', rec);
        await this.apply(rec);
        this.lastSeq = Math.max(this.lastSeq, rec.seq);
      }
      await idb.put('kv', this.lastSeq, 'lastSeq');
      if (!more) break;
    }
  }

  guard(fn) {
    return this.run(async () => {
      try {
        await fn();
        this.online = true;
        if (this.undecryptable.size) this.status(`⚠ ${this.undecryptable.size} block(s) could not be decrypted`);
        else if (!this.pending.size && !this.tomb.size && !this.dirty.size) this.status('saved ' + new Date().toLocaleTimeString());
      } catch (e) {
        if (isNetErr(e)) {
          this.online = false;
          this.status('offline: changes are kept on this device');
          this.schedule(15000);
        } else {
          this.status('⚠ ' + (e.message || 'sync error'));
          console.error(e);
        }
      }
    });
  }

  flush() { return this.guard(async () => { await this.stage(); await this.send(); }); }
  syncNow() { return this.guard(async () => { await this.stage(); await this.send(); await this.pullAll(); }); }

  startPolling(ms = 8000) {
    this.poller = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) this.syncNow(); }, ms);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => { document.hidden ? this.flush() : this.syncNow(); });
    }
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.poller);
  }
}
