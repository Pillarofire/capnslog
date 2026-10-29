// Token index over decrypted text. Postings (token -> block ids) are persisted by the app as encrypted,
// compressed shard records, so the server only ever sees opaque ciphertext. Snippet text stays in memory.
export const SHARDS = 16;
const MAX_TOKS = 2000;

export const tokenize = (text) => {
  const out = new Set();
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}_]{2,}/gu)) {
    out.add(m[0].slice(0, 40));
    if (out.size >= MAX_TOKS) break;
  }
  return out;
};

export const shardOf = (tok) => {
  let h = 0;
  for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
  return h % SHARDS;
};

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class SearchIndex {
  constructor() { this.clear(); }

  clear() {
    this.rows = new Map();
    this.post = new Map();
    this.toks = new Map();
    this.dirty = new Set();
  }

  set(id, text, ts) {
    this.rows.set(id, { text, low: text.toLowerCase(), ts });
    const next = tokenize(text);
    const prev = this.toks.get(id) || new Set();
    for (const t of prev) if (!next.has(t)) this.unlink(id, t);
    for (const t of next) if (!prev.has(t)) this.link(id, t);
    this.toks.set(id, next);
  }

  remove(id) {
    this.rows.delete(id);
    for (const t of this.toks.get(id) || []) this.unlink(id, t);
    this.toks.delete(id);
  }

  link(id, t) {
    let s = this.post.get(t);
    if (!s) this.post.set(t, (s = new Set()));
    s.add(id);
    this.dirty.add(shardOf(t));
  }

  unlink(id, t) {
    const s = this.post.get(t);
    if (!s) return;
    s.delete(id);
    if (!s.size) this.post.delete(t);
    this.dirty.add(shardOf(t));
  }

  // Drop postings for blocks that no longer exist (e.g. deleted on another device).
  prune(valid) {
    for (const id of [...this.toks.keys()]) if (!valid.has(id)) this.remove(id);
  }

  async exportShard(n) {
    const o = {};
    for (const [t, s] of this.post) if (shardOf(t) === n) o[t] = [...s];
    return { z: toB64(await pipe(new TextEncoder().encode(JSON.stringify(o)), new CompressionStream('gzip'))) };
  }

  async importShard(n, d) {
    for (const [t, s] of [...this.post]) {
      if (shardOf(t) !== n) continue;
      for (const id of s) this.toks.get(id)?.delete(t);
      this.post.delete(t);
    }
    const o = JSON.parse(new TextDecoder().decode(await pipe(fromB64(d.z), new DecompressionStream('gzip'))));
    for (const [t, ids] of Object.entries(o)) {
      this.post.set(t, new Set(ids));
      for (const id of ids) {
        let s = this.toks.get(id);
        if (!s) this.toks.set(id, (s = new Set()));
        s.add(t);
      }
    }
    this.dirty.delete(n);
  }

  takeDirty() {
    const d = [...this.dirty];
    this.dirty.clear();
    return d;
  }

  search(query, limit = 50) {
    const qs = [...tokenize(query)];
    const raw = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!qs.length) return [];
    let ids = null;
    for (const q of qs) {
      const hit = new Set();
      for (const [t, s] of this.post) if (t.includes(q)) for (const id of s) hit.add(id);
      ids = ids ? new Set([...ids].filter((x) => hit.has(x))) : hit;
      if (!ids.size) return [];
    }
    const out = [];
    for (const id of ids) {
      const r = this.rows.get(id);
      if (!r) continue;
      const needle = raw.find((w) => r.low.includes(w)) || qs[0];
      const at = Math.max(0, r.low.indexOf(needle));
      const from = Math.max(0, at - 40);
      out.push({ id, ts: r.ts, snippet: r.text.slice(from, at + needle.length + 80).replace(/\s+/g, ' '), at: at - from, len: needle.length });
    }
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, limit);
  }
}
