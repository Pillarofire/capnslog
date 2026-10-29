import { newId } from './crypto.js';

export const UNFILED = 'unfiled';

const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

// Link ids derive from (block, section, generation), so adding the same link twice is idempotent, even across devices.
// Deleted records are tombstoned for good on the server, so a re-added link moves on to the next generation.
export async function linkId(blockId, sectionId, gen = 0) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${blockId}:${sectionId}:${gen}`));
  return 'lk-' + hex(h).slice(0, 32);
}

/**
 * Sections ($section records, nested via `parent`) and block<->section links ($link records).
 * Everything lives in encrypted records; a block may belong to many sections.
 */
export class Sections {
  constructor(nb) {
    this.nb = nb;
    this.stale = true;
    this.sec = new Map();
    this.byBlock = new Map();
    this.pair = new Map();
  }

  invalidate() { this.stale = true; }

  build() {
    if (!this.stale) return;
    this.stale = false;
    this.sec = new Map();
    for (const e of this.nb.sys('$section')) this.sec.set(e.id, { id: e.id, name: e.d.name || 'Untitled', parent: e.d.parent || null, order: e.d.order || 0 });
    this.byBlock = new Map();
    this.pair = new Map();
    for (const e of this.nb.sys('$link')) {
      const { b, s } = e.d;
      if (!this.sec.has(s)) continue;
      if (!this.byBlock.has(b)) this.byBlock.set(b, new Set());
      this.byBlock.get(b).add(s);
      this.pair.set(`${b}|${s}`, e.id);
    }
  }

  all() { this.build(); return [...this.sec.values()]; }
  get(id) { this.build(); return this.sec.get(id); }

  children(parent = null) {
    return this.all().filter((s) => (s.parent || null) === parent)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }

  roots() { return this.all().filter((s) => !s.parent || !this.sec.has(s.parent)).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)); }

  descendants(id) {
    const out = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const s of this.sec.values()) if (s.parent && out.has(s.parent) && !out.has(s.id)) { out.add(s.id); grew = true; }
    }
    return out;
  }

  path(id) {
    const out = [];
    for (let s = this.get(id), n = 0; s && n < 50; s = s.parent && this.sec.get(s.parent), n++) out.unshift(s.name);
    return out;
  }

  direct(blockId) { this.build(); return this.byBlock.get(blockId) || new Set(); }

  // Does a block belong to section `id` or any of its subsections? UNFILED means "in no section".
  inSection(blockId, id) {
    this.build();
    const mine = this.direct(blockId);
    if (id === UNFILED) return mine.size === 0;
    for (const d of this.descendants(id)) if (mine.has(d)) return true;
    return false;
  }

  add(name, parent = null) {
    const id = 'sec-' + newId();
    this.nb.putSys(id, '$section', { name, parent, order: Date.now() });
    this.invalidate();
    return id;
  }

  rename(id, name) {
    const e = this.nb.model.get(id);
    if (e) { this.nb.putSys(id, '$section', { ...e.d, name }); this.invalidate(); }
  }

  move(id, parent) {
    if (parent && this.descendants(id).has(parent)) return false;
    const e = this.nb.model.get(id);
    if (!e) return false;
    this.nb.putSys(id, '$section', { ...e.d, parent });
    this.invalidate();
    return true;
  }

  // Deleting a section keeps its blocks (they may become Unfiled) and re-parents child sections.
  remove(id) {
    this.build();
    const s = this.sec.get(id);
    if (!s) return;
    for (const c of this.sec.values()) if (c.parent === id) this.move(c.id, s.parent || null);
    for (const e of this.nb.sys('$link')) if (e.d.s === id) this.nb.remove(e.id);
    this.nb.remove(id);
    this.invalidate();
  }

  async link(blockId, sectionId) {
    this.build();
    if (this.pair.has(`${blockId}|${sectionId}`)) return;
    let id;
    for (let gen = 0; ; gen++) {
      id = await linkId(blockId, sectionId, gen);
      if (!this.nb.revs.get(id)) break;
    }
    this.build();
    if (this.pair.has(`${blockId}|${sectionId}`)) return;
    this.nb.putSys(id, '$link', { b: blockId, s: sectionId });
    this.invalidate();
  }

  unlink(blockId, sectionId) {
    this.build();
    const id = this.pair.get(`${blockId}|${sectionId}`);
    if (id) { this.nb.remove(id); this.invalidate(); }
  }

  unlinkAll(blockId) {
    for (const s of [...this.direct(blockId)]) this.unlink(blockId, s);
  }
}
