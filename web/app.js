import * as api from './api.js';
import { createNotebook, unlockNotebook, WrongPassError, encryptBytes, decryptBytes, blobAad, newId } from './crypto.js';
import { idb } from './store.js';
import { Notebook } from './sync.js';
import { SearchIndex } from './search.js';
import { Sections, UNFILED } from './sections.js';
import { kinds, guessKind, safeUrl } from './blocks.js';
import { cmpKey } from './sortkey.js';

const $ = (s) => document.querySelector(s);
const page = $('#page');
let nb = null, key = null, sections = null;
const els = new Map();
const index = new SearchIndex();

/* ---------- settings ---------- */
const SKEY = 'capnslog.settings';
const settings = (() => {
  let s = { code: true, autolock: 30, sectionClick: 'scroll' };
  try { s = { ...s, ...JSON.parse(localStorage.getItem(SKEY) || '{}') }; } catch { /* defaults */ }
  return s;
})();
const saveSettings = () => localStorage.setItem(SKEY, JSON.stringify(settings));

/* ---------- theme ---------- */
const root = document.documentElement;
const syncTheme = () => { $('#theme').textContent = root.dataset.theme === 'dark' ? '☀️' : '🌙'; };
$('#theme').onclick = () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('notebook.theme', root.dataset.theme);
  syncTheme();
};
syncTheme();

/* ---------- gate (setup / unlock) ---------- */
const gate = { form: $('#gateForm'), msg: $('#gateMsg'), err: $('#gateErr'), pass: $('#gatePass'), pass2: $('#gatePass2'), token: $('#gateToken'), go: $('#gateGo'), warn: $('#gateWarn') };
const setBusy = (b, t) => { gate.go.disabled = b; if (t) gate.go.textContent = t; };

api.setAuthHandler(async () => {
  const t = prompt('The server requires an access token:');
  if (!t) return false;
  api.setToken(t.trim());
  return true;
});

async function boot() {
  if (!globalThis.crypto?.subtle) {
    gate.msg.textContent = 'This page needs a secure context (HTTPS or localhost) for encryption.';
    return;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  let status = null, meta = null;
  const cached = await idb.get('kv', 'meta');
  try {
    status = await (await api.req('GET', '/api/status')).json();
    if (status.initialized) meta = await (await api.req('GET', '/api/meta')).json();
  } catch {
    meta = cached || null;
    if (!meta) { gate.msg.textContent = 'Cannot reach the server, and nothing is cached on this device yet.'; return; }
    gate.msg.textContent = 'Offline: unlocking from this device’s cache.';
  }
  const setup = !meta;
  if (status?.auth_required && !api.getToken()) gate.token.hidden = false;
  gate.pass.hidden = false;
  gate.pass.autocomplete = setup ? 'new-password' : 'current-password';
  gate.pass2.hidden = !setup;
  gate.warn.hidden = !setup;
  gate.go.hidden = false;
  gate.go.textContent = setup ? 'Create encrypted notebook' : 'Unlock';
  if (!gate.msg.textContent.startsWith('Offline')) gate.msg.textContent = setup ? 'Choose a passkey for your new notebook.' : 'Enter your passkey.';
  gate.pass.focus();

  gate.form.onsubmit = async (ev) => {
    ev.preventDefault();
    gate.err.textContent = '';
    const pass = gate.pass.value;
    if (!gate.token.hidden && gate.token.value.trim()) api.setToken(gate.token.value.trim());
    try {
      if (setup) {
        if (pass.length < 8) { gate.err.textContent = 'Use at least 8 characters.'; return; }
        if (pass !== gate.pass2.value) { gate.err.textContent = 'Passkeys do not match.'; return; }
        setBusy(true, 'Deriving key…');
        const made = await createNotebook(pass);
        const r = await api.req('PUT', '/api/meta', { json: made.meta });
        if (r.status === 409) { gate.err.textContent = 'Already initialised elsewhere. Reload.'; return; }
        if (!r.ok) { gate.err.textContent = `Server error (${r.status}).`; return; }
        await idb.wipe();
        await idb.put('kv', made.meta, 'meta');
        await start(made.key);
      } else {
        setBusy(true, 'Deriving key…');
        const k = await unlockNotebook(meta, pass);
        if (JSON.stringify(cached) !== JSON.stringify(meta)) { await idb.wipe(); await idb.put('kv', meta, 'meta'); }
        await start(k);
      }
    } catch (e) {
      gate.err.textContent = e instanceof WrongPassError ? 'Wrong passkey.' : (e.message || 'Failed.');
    } finally {
      setBusy(false, setup ? 'Create encrypted notebook' : 'Unlock');
      gate.pass.value = gate.pass2.value = '';
    }
  };
}

/* ---------- page rendering ---------- */
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const blocks = () => page.querySelectorAll(':scope > .blk:not([hidden])');

/* ---------- persisted search index ---------- */
let ixTimer = null;
function persistIndex() {
  clearTimeout(ixTimer);
  ixTimer = setTimeout(async () => {
    for (const n of index.takeDirty()) nb?.putSys(`ixshard-${n}`, '$ix', await index.exportShard(n));
  }, 2500);
}
function reindexAll() {
  for (const e of nb.blocks()) index.set(e.id, kinds[e.t].text(e), e.ts.c);
  index.prune(new Set(nb.blocks().map((e) => e.id)));
  persistIndex();
}
let reindexTimer = null;
const scheduleReindex = () => { clearTimeout(reindexTimer); reindexTimer = setTimeout(reindexAll, 1000); };

const io = new IntersectionObserver((entries) => {
  for (const en of entries) if (en.isIntersecting) { mount(en.target); io.unobserve(en.target); }
}, { rootMargin: '1500px 0px' });

const stampFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function setStamp(el, e) {
  const s = el.querySelector('.stamp');
  if (s) s.textContent = 'edited ' + stampFmt.format(e.ts.e);
}

const ctxFor = (e) => ({
  change() { index.set(e.id, kinds[e.t].text(e), e.ts.c); persistIndex(); nb.touch(e.id); const el = els.get(e.id); if (el) setStamp(el, e); },
  settings: () => settings,
  blobUrl,
});

function mount(el) {
  if (el._mounted) return;
  el._mounted = true;
  const e = nb.model.get(el.dataset.id);
  if (!e) return;
  const body = el.querySelector('.content');
  body.replaceChildren();
  el.style.minHeight = '';
  el._focus = kinds[e.t].render(body, e, ctxFor(e));
}

function makeBlock(e) {
  const el = document.createElement('div');
  el.className = 'blk ' + e.t;
  el.dataset.id = e.id;
  el.dataset.key = e.sortKey;
  const grip = document.createElement('div');
  grip.className = 'grip';
  const btn = (txt, title, fn) => { const b = document.createElement('button'); b.textContent = txt; b.title = title; b.onclick = (ev) => { ev.stopPropagation(); fn(); }; return b; };
  const up = btn('↑', 'Move up (within the open section)', () => move(e.id, -1));
  const dn = btn('↓', 'Move down (within the open section)', () => move(e.id, 1));
  up.classList.add('mv'); dn.classList.add('mv');
  grip.draggable = true;
  grip.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/x-capnslog-block', e.id); ev.dataTransfer.effectAllowed = 'copyMove'; document.body.classList.add('dragging'); });
  grip.addEventListener('dragend', () => document.body.classList.remove('dragging'));
  grip.append(btn('⚙', 'Block settings, sections and history', () => openBlockSettings(e.id)), up, dn, btn('✕', 'Delete', () => del(e.id)));
  const content = document.createElement('div');
  content.className = 'content';
  const chips = document.createElement('div');
  chips.className = 'chips';
  const stamp = document.createElement('div');
  stamp.className = 'stamp';
  el.append(grip, content, chips, stamp);
  setStamp(el, e);
  renderChips(el, e.id);
  el.addEventListener('pointerdown', () => select(el), true);
  el.style.minHeight = (e.t === 'draw' ? (e.d.ch || 200) : e.t === 'media' ? (e.d.h || 120) : 32) + 'px';
  return el;
}

function select(el) {
  page.querySelector('.blk.sel')?.classList.remove('sel');
  el.classList.add('sel');
}

function insertSorted(el, e) {
  let ref = null;
  for (let n = page.lastElementChild; n; n = n.previousElementSibling) {
    if (!n.classList.contains('blk')) continue;
    if (cmpKey(n.dataset.key, n.dataset.id, e.sortKey, e.id) <= 0) break;
    ref = n;
  }
  page.insertBefore(el, ref);
}

let relayoutQueued = false;
function relayout() {
  if (relayoutQueued) return;
  relayoutQueued = true;
  requestAnimationFrame(() => {
    relayoutQueued = false;
    page.querySelectorAll(':scope > .daysep').forEach((n) => n.remove());
    let prev = null;
    for (const el of blocks()) {
      const e = nb.model.get(el.dataset.id);
      if (!e) continue;
      const k = dayKey(e.ts.c);
      if (k !== prev) {
        const sep = document.createElement('div');
        sep.className = 'daysep';
        sep.textContent = dayFmt.format(e.ts.c);
        sep.dataset.day = e.ts.c;
        page.insertBefore(sep, el);
        prev = k;
      }
    }
  });
}

function upsert(e, isNew, immediate = false) {
  index.set(e.id, kinds[e.t].text(e), e.ts.c);
  persistIndex();
  let el = els.get(e.id);
  if (!el) {
    el = makeBlock(e);
    els.set(e.id, el);
    el.hidden = hiddenByFilter(e.id);
    insertSorted(el, e);
    if (immediate) mount(el); else io.observe(el);
  } else {
    if (el.dataset.key !== e.sortKey) { el.dataset.key = e.sortKey; el.remove(); insertSorted(el, e); }
    if (el._mounted) { el._mounted = false; mount(el); } // remote update replaces content
    setStamp(el, e);
  }
  relayout();
}

/* ---------- block settings / history ---------- */
const histFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
function openBlockSettings(id) {
  const e = nb.model.get(id);
  if (!e) return;
  const dlg = document.createElement('dialog');
  dlg.className = 'blocksettings';
  const h = document.createElement('h3');
  h.textContent = kinds[e.t].label + ' block';
  const meta = document.createElement('p');
  meta.className = 'muted';
  meta.textContent = `Created ${histFmt.format(e.ts.c)} · Edited ${histFmt.format(e.ts.e)}`;
  const h2 = document.createElement('h4');
  h2.textContent = `History (${(e.hist || []).length} of 8 versions)`;
  const list = document.createElement('ul');
  list.className = 'hist';
  const fill = () => {
    list.replaceChildren();
    h2.textContent = `History (${(e.hist || []).length} of 8 versions)`;
    if (!e.hist?.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No earlier versions yet. A version is kept when you edit after a pause.';
      list.append(li);
    }
    (e.hist || []).forEach((s, i) => {
      const li = document.createElement('li');
      const when = document.createElement('div');
      when.className = 'when';
      when.textContent = histFmt.format(s.ts);
      const prev = document.createElement('div');
      prev.className = 'prev';
      let txt = '';
      try { txt = kinds[e.t].text({ d: s.d }) || ''; } catch { /* preview only */ }
      prev.textContent = txt.replace(/\s+/g, ' ').trim().slice(0, 120) || `(${e.t})`;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Restore';
      b.onclick = () => {
        if (nb.restore(id, i)) { fill(); meta.textContent = `Created ${histFmt.format(e.ts.c)} · Edited ${histFmt.format(e.ts.e)}`; }
      };
      li.append(when, prev, b);
      list.append(li);
    });
  };
  fill();
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.onclick = () => dlg.close();
  dlg.addEventListener('close', () => dlg.remove());
  const pin = document.createElement('label');
  pin.className = 'chk';
  const pinBox = document.createElement('input');
  pinBox.type = 'checkbox';
  pinBox.checked = !!e.d.pin;
  pinBox.onchange = () => { e.d.pin = pinBox.checked; nb.touch(id); scheduleSide(); };
  pin.append(pinBox, ' ★ Pin to the sidebar');
  const sh = document.createElement('h4');
  sh.textContent = 'Sections';
  dlg.append(h, meta, pin, sh, sectionPicker(id), h2, list, close);
  document.body.append(dlg);
  dlg.showModal();
}

function removeEl(id) {
  const el = els.get(id);
  if (el) { io.unobserve(el); el.remove(); els.delete(id); }
  index.remove(id);
  persistIndex();
  relayout();
  scheduleSide();
}

function isEmpty(e) {
  return e.t !== 'draw' && !e.d.blob && kinds[e.t].text(e).trim() === '';
}

function choose(msg, buttons) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    const p = document.createElement('p');
    p.textContent = msg;
    const m = document.createElement('menu');
    for (const [label, val] of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.onclick = () => { d.close(); resolve(val); };
      m.append(b);
    }
    d.addEventListener('cancel', () => resolve(null));
    d.addEventListener('close', () => d.remove());
    d.append(p, m);
    document.body.append(d);
    d.showModal();
  });
}

function ask(msg, def = '') {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    const f = document.createElement('form');
    f.method = 'dialog';
    const l = document.createElement('label');
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = def;
    inp.maxLength = 200;
    l.append(msg, inp);
    const m = document.createElement('menu');
    const ok = document.createElement('button');
    ok.textContent = 'OK';
    const no = document.createElement('button');
    no.type = 'button';
    no.textContent = 'Cancel';
    no.onclick = () => d.close();
    m.append(no, ok);
    f.append(l, m);
    let val = null;
    f.addEventListener('submit', () => { val = inp.value.trim() || null; });
    d.addEventListener('close', () => { d.remove(); resolve(val); });
    d.append(f);
    document.body.append(d);
    d.showModal();
    inp.select();
  });
}

async function del(id) {
  const e = nb.model.get(id);
  if (!e) return;
  const mine = sections.direct(id);
  if (filter && filter !== UNFILED && mine.size > 1) {
    const pick = await choose(`This block is in ${mine.size} sections. Delete it everywhere, or only remove it from the open section?`,
      [['Delete everywhere', 'all'], ['Remove from this section', 'one'], ['Cancel', null]]);
    if (pick === 'one') {
      for (const s of sections.descendants(filter)) sections.unlink(id, s);
      sectionsChanged();
      return;
    }
    if (pick !== 'all') return;
  } else if (!isEmpty(e) && !confirm('Delete this block? This cannot be undone.')) return;
  sections.unlinkAll(id);
  nb.remove(id);
  sectionsChanged();
}

function move(id, dir) {
  if (!filter) { nb.status('Open a section to reorder its blocks'); return; }
  const el = els.get(id);
  const vis = (n) => n && (!n.classList.contains('blk') || n.hidden);
  let other = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
  while (vis(other)) other = dir < 0 ? other.previousElementSibling : other.nextElementSibling;
  if (!other) return;
  const ok = other.dataset.key;
  const e = nb.model.get(id);
  const nk = dir < 0 ? nb.keyBefore(ok) : nb.keyAfter(ok);
  nb.setSortKey(id, nk);
  e.sortKey = nk;
  el.dataset.key = nk;
  el.remove();
  insertSorted(el, e);
  relayout();
  el.scrollIntoView({ block: 'nearest' });
}

function addBlock(t, data) {
  const e = nb.create(t, data ?? kinds[t].blank());
  const el = els.get(e.id);
  el.hidden = false;
  if (filter && filter !== UNFILED) sections.link(e.id, filter).then(sectionsChanged);
  select(el);
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => el._focus?.(), 50);
  return e;
}

function jumpTo(id) {
  const el = els.get(id);
  if (!el) return;
  if (el.hidden) setFilter(null);
  mount(el);
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1800);
}

/* ---------- sections, sidebar, routing ---------- */
let filter = null;
const hiddenByFilter = (id) => !!filter && !!sections && !sections.inSection(id, filter);

function renderChips(el, id) {
  const box = el.querySelector('.chips');
  if (!box) return;
  box.replaceChildren();
  if (!sections) return;
  const mine = [...sections.direct(id)].map((s) => sections.get(s)).filter(Boolean);
  if (!mine.length) return;
  if (mine.length > 1) {
    const b = document.createElement('span');
    b.className = 'shared';
    b.title = `Shared by ${mine.length} sections`;
    b.textContent = `⇄ ${mine.length}`;
    box.append(b);
  }
  for (const s of mine) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const a = document.createElement('a');
    a.href = `#/s/${s.id}`;
    a.textContent = s.name;
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = `Remove from “${s.name}”`;
    x.onclick = (ev) => { ev.stopPropagation(); sections.unlink(id, s.id); sectionsChanged(); };
    chip.append(a, x);
    box.append(chip);
  }
  const add = document.createElement('button');
  add.className = 'chipadd';
  add.textContent = '＋';
  add.title = 'Add to another section';
  add.onclick = () => openBlockSettings(id);
  box.append(add);
}

function sectionsChanged() {
  sections.invalidate();
  for (const [id, el] of els) renderChips(el, id);
  applyFilter();
  scheduleSide();
}

function applyFilter() {
  for (const [id, el] of els) el.hidden = hiddenByFilter(id);
  page.classList.toggle('filtered', !!filter);
  const bar = $('#filterbar');
  bar.hidden = !filter;
  if (filter) {
    const name = filter === UNFILED ? 'Unfiled' : sections.path(filter).join(' › ');
    $('#filterName').textContent = `Showing only: ${name}`;
  }
  relayout();
  for (const r of sideTree.querySelectorAll('.srow')) r.classList.toggle('on', r.dataset.sec === filter);
}

function setFilter(id) {
  filter = id;
  applyFilter();
}
$('#filterClear').onclick = () => { history.pushState(null, '', '#/all'); setFilter(null); };

function sectionPicker(blockId) {
  const box = document.createElement('div');
  box.className = 'secpick';
  const draw = () => {
    box.replaceChildren();
    const mine = sections.direct(blockId);
    const walk = (list, depth) => {
      for (const s of list) {
        const l = document.createElement('label');
        l.className = 'chk';
        l.style.marginLeft = depth * 1.1 + 'rem';
        const c = document.createElement('input');
        c.type = 'checkbox';
        c.checked = mine.has(s.id);
        c.onchange = async () => {
          if (c.checked) await sections.link(blockId, s.id); else sections.unlink(blockId, s.id);
          sectionsChanged();
        };
        l.append(c, ' ' + s.name);
        box.append(l);
        walk(sections.children(s.id), depth + 1);
      }
    };
    walk(sections.roots(), 0);
    if (!sections.all().length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No sections yet.';
      box.append(p);
    } else if (!mine.size) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Not in any section (shown under Unfiled).';
      box.append(p);
    }
    const nw = document.createElement('button');
    nw.type = 'button';
    nw.textContent = '＋ New section';
    nw.onclick = async () => {
      const name = await ask('Section name:');
      if (!name) return;
      const sid = sections.add(name);
      await sections.link(blockId, sid);
      sectionsChanged();
      draw();
    };
    box.append(nw);
  };
  draw();
  return box;
}

const sideTree = $('#sideTree');
const COLL = 'capnslog.collapsed';
const collapsed = new Set((() => { try { return JSON.parse(localStorage.getItem(COLL) || '[]'); } catch { return []; } })());
const saveColl = () => localStorage.setItem(COLL, JSON.stringify([...collapsed]));
let sideTimer = null;
const scheduleSide = () => { clearTimeout(sideTimer); sideTimer = setTimeout(renderSide, 250); };

function titleOf(e) {
  let t = '';
  if (e.t === 'note' && e.d.html) {
    const m = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(e.d.html);
    if (m) t = (new DOMParser().parseFromString(m[1], 'text/html').body.textContent || '').trim();
  }
  if (!t && e.d.pin) t = (kinds[e.t].text(e) || '').replace(/\s+/g, ' ').trim().slice(0, 40) || kinds[e.t].label;
  return t.slice(0, 80);
}

function renderSide() {
  if (!sections || !nb) return;
  const notes = new Map(), counts = new Map();
  let unfiled = 0;
  const put = (k, e, t) => { if (!notes.has(k)) notes.set(k, []); notes.get(k).push({ id: e.id, t, pin: !!e.d.pin, ts: e.ts.c }); };
  for (const e of nb.blocks()) {
    const mine = sections.direct(e.id);
    const t = titleOf(e);
    if (!mine.size) { unfiled++; if (t) put(UNFILED, e, t); continue; }
    for (const s of mine) { counts.set(s, (counts.get(s) || 0) + 1); if (t) put(s, e, t); }
  }
  const frag = document.createDocumentFragment();
  const row = (id, name, count, kids, depth) => {
    const r = document.createElement('div');
    r.className = 'srow' + (filter === id ? ' on' : '');
    r.dataset.sec = id;
    const tw = document.createElement('button');
    tw.className = 'tw';
    tw.dataset.act = 'toggle';
    tw.textContent = !kids ? '' : collapsed.has(id) ? '▸' : '▾';
    const a = document.createElement('a');
    a.className = 'sname';
    a.href = `#/s/${id}`;
    a.textContent = name;
    const c = document.createElement('span');
    c.className = 'cnt';
    c.textContent = count || '';
    r.append(tw, a, c);
    if (id !== UNFILED) {
      const act = document.createElement('span');
      act.className = 'sact';
      for (const [sym, name2, title] of [['＋', 'child', 'New subsection'], ['✎', 'rename', 'Rename'], ['✕', 'delete', 'Delete section (blocks are kept)']]) {
        const b = document.createElement('button');
        b.textContent = sym;
        b.title = title;
        b.dataset.act = name2;
        act.append(b);
      }
      r.append(act);
    }
    return r;
  };
  const node = (id, name, count, kidsFn, depth) => {
    const list = (notes.get(id) || []).sort((a, b) => a.ts - b.ts);
    const kids = kidsFn ? kidsFn() : [];
    const wrap = document.createElement('div');
    wrap.append(row(id, name, count, list.length > 0 || kids.length > 0, depth));
    if (!collapsed.has(id)) {
      const inner = document.createElement('div');
      inner.className = 'skids';
      for (const n of list) {
        const a = document.createElement('a');
        a.className = 'snote';
        a.href = `#/b/${n.id}`;
        a.textContent = (n.pin ? '★ ' : '') + n.t;
        inner.append(a);
      }
      for (const k of kids) inner.append(k);
      wrap.append(inner);
    }
    return wrap;
  };
  const build = (s, depth) => node(s.id, s.name, counts.get(s.id), () => sections.children(s.id).map((c) => build(c, depth + 1)), depth);
  const all = document.createElement('a');
  all.className = 'sall' + (filter ? '' : ' on');
  all.href = '#/all';
  all.textContent = 'All notes';
  frag.append(all);
  for (const s of sections.roots()) frag.append(build(s, 0));
  if (unfiled || sections.all().length) frag.append(node(UNFILED, 'Unfiled', unfiled, null, 0));
  sideTree.replaceChildren(frag);
}

const sideEl = $('#side');
const setSide = (open) => { sideEl.classList.toggle('open', open); document.body.classList.toggle('sideopen', open); localStorage.setItem('capnslog.side', open ? '1' : '0'); };
$('#sideBtn').onclick = () => setSide(!sideEl.classList.contains('open'));
$('#sideHide').onclick = () => setSide(false);
$('#sideAdd').onclick = async () => {
  const name = await ask('New section name:');
  if (name) { sections.add(name); sectionsChanged(); }
};

sideTree.addEventListener('click', async (ev) => {
  const act = ev.target.closest('button[data-act]');
  const rowEl = ev.target.closest('.srow');
  if (act && rowEl) {
    const id = rowEl.dataset.sec;
    if (act.dataset.act === 'toggle') { collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); saveColl(); renderSide(); }
    else if (act.dataset.act === 'child') {
      const name = await ask('New subsection name:');
      if (name) { collapsed.delete(id); sections.add(name, id); sectionsChanged(); }
    } else if (act.dataset.act === 'rename') {
      const name = await ask('Rename section:', sections.get(id)?.name);
      if (name) { sections.rename(id, name); sectionsChanged(); }
    } else if (act.dataset.act === 'delete') {
      if (confirm(`Delete section “${sections.get(id)?.name}”? Its blocks are kept; subsections move up a level.`)) {
        if (filter === id) setFilter(null);
        sections.remove(id);
        sectionsChanged();
      }
    }
    return;
  }
  const a = ev.target.closest('a[href^="#/"]');
  if (!a) return;
  ev.preventDefault();
  const h = a.getAttribute('href');
  if (location.hash !== h) history.pushState(null, '', h);
  route();
  if (matchMedia('(max-width: 800px)').matches) setSide(false);
});

const DT = 'text/x-capnslog-block';
sideTree.addEventListener('dragover', (ev) => {
  const r = ev.target.closest('.srow');
  if (!r || !ev.dataTransfer.types.includes(DT)) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = ev.shiftKey ? 'move' : 'copy';
  for (const x of sideTree.querySelectorAll('.drop')) if (x !== r) x.classList.remove('drop');
  r.classList.add('drop');
});
sideTree.addEventListener('dragleave', (ev) => { if (!sideTree.contains(ev.relatedTarget)) for (const x of sideTree.querySelectorAll('.drop')) x.classList.remove('drop'); });
sideTree.addEventListener('drop', async (ev) => {
  const r = ev.target.closest('.srow');
  const id = ev.dataTransfer.getData(DT);
  for (const x of sideTree.querySelectorAll('.drop')) x.classList.remove('drop');
  if (!r || !id || !nb.model.has(id)) return;
  ev.preventDefault();
  const sec = r.dataset.sec;
  if (sec === UNFILED) sections.unlinkAll(id);
  else {
    if (ev.shiftKey) for (const s of [...sections.direct(id)]) if (s !== sec) sections.unlink(id, s);
    await sections.link(id, sec);
  }
  sectionsChanged();
  nb.status(sec === UNFILED ? 'Removed from all sections' : ev.shiftKey ? 'Moved to section' : 'Added to section (Shift+drop moves instead)');
});

function openSection(id) {
  if (id !== UNFILED && !sections.get(id)) { nb.status('That section no longer exists'); return; }
  if (settings.sectionClick === 'filter') {
    setFilter(id);
    window.scrollTo(0, 0);
    return;
  }
  if (filter) setFilter(null);
  const first = [...blocks()].find((el) => sections.inSection(el.dataset.id, id));
  if (first) jumpTo(first.dataset.id); else nb.status('That section has no blocks yet');
}

function route() {
  if (!nb || !sections) return;
  const h = location.hash;
  let m;
  if ((m = h.match(/^#\/s\/([\w-]+)$/))) openSection(m[1]);
  else if ((m = h.match(/^#\/b\/([\w-]+)$/))) { if (els.has(m[1])) jumpTo(m[1]); else nb.status('That note is not available'); }
  else if (filter) setFilter(null);
  renderSide();
}
addEventListener('hashchange', route);
addEventListener('popstate', route);

/* ---------- media ---------- */
const blobCache = new Map();
async function blobUrl(id, mime) {
  if (blobCache.has(id)) return blobCache.get(id);
  const r = await api.req('GET', `/api/blobs/${id}`);
  if (!r.ok) throw new Error('blob fetch failed');
  const buf = new Uint8Array(await r.arrayBuffer());
  const bytes = await decryptBytes(key, buf.slice(0, 12), buf.slice(12), blobAad(id));
  const safe = /^(image|video|audio)\/[\w.+-]+$/.test(mime || '') ? mime : 'application/octet-stream';
  const url = URL.createObjectURL(new Blob([bytes], { type: safe }));
  blobCache.set(id, url);
  return url;
}

async function prepareImage(file) {
  if (!file.type.startsWith('image/') || /gif|svg/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const MAX = 2048, scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const out = await new Promise((r) => c.toBlob(r, type, 0.85));
    return out && out.size < file.size ? out : file;
  } catch { return file; }
}

async function storeBlob(file) {
  const blob = await prepareImage(file);
  const id = newId();
  const { nonce, ct } = await encryptBytes(key, new Uint8Array(await blob.arrayBuffer()), blobAad(id));
  const body = new Uint8Array(nonce.length + ct.length);
  body.set(nonce); body.set(ct, nonce.length);
  const r = await api.req('PUT', `/api/blobs/${id}`, { body, headers: { 'Content-Type': 'application/octet-stream' } });
  if (!r.ok) throw new Error('upload failed (' + r.status + ')');
  return { id, mime: blob.type || file.type };
}

async function uploadFile(file) {
  if (file.size > 60 * 1024 * 1024) { alert('File too large (limit 60 MB).'); return; }
  nb.status('uploading…');
  try {
    const { id, mime } = await storeBlob(file);
    addBlock('media', { blob: id, mime, name: file.name });
    nb.status('uploaded');
  } catch (e) {
    nb.status('⚠ upload failed: ' + (e.message || e));
  }
}

/* ---------- OneNote (.docx) import: runs entirely in the browser; only ciphertext is uploaded ---------- */
async function importDocx(files) {
  if (filter) setFilter(null);
  const { readZip, docxToBlocks } = await import('./importer.js');
  let total = 0;
  for (const f of files) {
    try {
      nb.status(`importing ${f.name}…`);
      const parts = await docxToBlocks(readZip(await f.arrayBuffer()));
      const sid = sections.add(f.name.replace(/\.docx$/i, '') || 'Imported');
      let n = 0;
      for (const p of parts) {
        let e;
        if (p.t === 'note') e = nb.create('note', p.d);
        else {
          const { id, mime } = await storeBlob(new File([p.bytes], p.name, { type: p.mime }));
          e = nb.create('media', { blob: id, mime, name: p.name });
        }
        await sections.link(e.id, sid);
        nb.status(`importing ${f.name}… ${++n}/${parts.length}`);
      }
      total += n;
    } catch (err) {
      nb.status(`⚠ could not import ${f.name}: ${err.message || err}`);
      console.error(err);
      return;
    }
  }
  sectionsChanged();
  nb.status(`Imported ${total} blocks from ${files.length} file(s)`);
}
$('#importBtn').onclick = () => $('#docx').click();
$('#docx').addEventListener('change', () => { const fs = [...$('#docx').files]; $('#docx').value = ''; dlg.close(); if (fs.length && nb) importDocx(fs); });

const fileIn = $('#file');
fileIn.addEventListener('change', () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) uploadFile(f); });
page.addEventListener('dragover', (e) => e.preventDefault());
page.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && nb) uploadFile(f); });

/* ---------- toolbar ---------- */
$('#tools').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b || !nb) return;
  const t = b.dataset.tool;
  if (t === 'media') fileIn.click();
  else if (t === 'url') {
    const u = prompt('Image / video / audio / embeddable page URL (http or https):');
    if (!u) return;
    const safe = safeUrl(u.trim());
    if (!safe) { alert('Only external http(s) URLs are allowed.'); return; }
    addBlock('media', { src: safe, kind: guessKind(safe) });
  } else addBlock(t);
});
$('#fab').onclick = () => addBlock('note');
$('#tail').addEventListener('click', () => {
  const last = [...blocks()].pop();
  const e = last && nb.model.get(last.dataset.id);
  if (e && e.t === 'note' && !e.d.text) { mount(last); last._focus?.(); } else addBlock('note');
});

/* ---------- search & jump ---------- */
const results = $('#results'), searchIn = $('#search');
let searchTimer = null;
function showResults() {
  const q = searchIn.value.trim();
  results.replaceChildren();
  if (!q) { results.hidden = true; return; }
  const found = index.search(q);
  results.hidden = false;
  if (!found.length) { results.textContent = 'No matches.'; return; }
  for (const r of found) {
    const row = document.createElement('button');
    row.className = 'hit';
    const d = document.createElement('span');
    d.className = 'muted';
    d.textContent = dayFmt.format(r.ts) + '  ';
    const s = document.createElement('span');
    s.append(r.snippet.slice(0, r.at));
    const m = document.createElement('mark');
    m.textContent = r.snippet.slice(r.at, r.at + r.len);
    s.append(m, r.snippet.slice(r.at + r.len));
    row.append(d, s);
    row.onclick = () => { results.hidden = true; jumpTo(r.id); };
    results.append(row);
  }
}
searchIn.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(showResults, 150); });
searchIn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchIn.value = ''; showResults(); } });
$('#jump').addEventListener('change', (ev) => {
  const v = ev.target.value;
  if (!v) return;
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(y, m - 1, d).getTime();
  const e = nb.blocks().filter((x) => x.ts.c >= t).sort((a, b) => cmpKey(a.sortKey, a.id, b.sortKey, b.id))[0];
  if (e) jumpTo(e.id); else window.scrollTo(0, document.body.scrollHeight);
});

/* ---------- settings dialog ---------- */
const dlg = $('#settings');
$('#settingsBtn').onclick = () => {
  $('#setCode').checked = settings.code;
  $('#setLock').value = settings.autolock;
  $('#setClick').value = settings.sectionClick;
  $('#setToken').value = api.getToken();
  dlg.showModal();
};
dlg.addEventListener('close', () => {
  settings.code = $('#setCode').checked;
  settings.autolock = Math.max(0, +$('#setLock').value || 0);
  settings.sectionClick = $('#setClick').value === 'filter' ? 'filter' : 'scroll';
  api.setToken($('#setToken').value.trim());
  saveSettings();
  armIdle();
  for (const el of els.values()) if (el._mounted && /calc|repl/.test(el.className)) { el._mounted = false; mount(el); }
});
$('#resetCache').onclick = async () => {
  if (confirm('Clear the local cache? Unsynced edits on this device will be lost.')) { await idb.wipe(); location.reload(); }
};

/* ---------- lock & idle ---------- */
$('#lock').onclick = () => lock();
function lock() {
  nb?.stop();
  location.reload(); // drops the key, decrypted DOM and REPL globals from memory
}
let idleTimer = null;
function armIdle() {
  clearTimeout(idleTimer);
  if (nb && settings.autolock > 0) idleTimer = setTimeout(lock, settings.autolock * 60000);
}
for (const t of ['pointerdown', 'keydown', 'scroll', 'touchstart']) addEventListener(t, () => { if (nb) armIdle(); }, { passive: true });
addEventListener('pagehide', () => nb?.flush());

/* ---------- start ---------- */
async function start(k) {
  key = k;
  let firstScroll = true;
  nb = new Notebook(k, {
    onStatus: (t) => { $('#status').textContent = t; },
    onUpsert: (e, isNew) => { upsert(e, isNew, isNew && nb.dirty.has(e.id)); scheduleSide(); },
    onRemove: (id) => { removeEl(id); sections.invalidate(); },
    onSys: async (e, initial) => {
      if (e.t === '$ix') {
        await index.importShard(+e.id.slice('ixshard-'.length), e.d);
        if (!initial) scheduleReindex();
      } else if (e.t === '$section' || e.t === '$link') {
        sections.invalidate();
        if (!initial) sectionsChanged();
      }
    },
    onSysRemove: (e) => { if (e.t === '$section' || e.t === '$link') sectionsChanged(); },
    onSysConflict: (plain) => { if (plain.t === '$ix') scheduleReindex(); },
    onLoad: (entries) => {
      entries.sort((a, b) => cmpKey(a.sortKey, a.id, b.sortKey, b.id));
      const frag = document.createDocumentFragment();
      for (const e of entries) {
        index.set(e.id, kinds[e.t].text(e), e.ts.c);
        const el = makeBlock(e);
        els.set(e.id, el);
        frag.append(el);
        io.observe(el);
      }
      index.prune(new Set(entries.map((e) => e.id)));
      page.append(frag);
      relayout();
      persistIndex();
      renderSide();
    },
  });
  sections = new Sections(nb);
  $('#gate').hidden = true;
  for (const s of ['#bar', '#page', '#tail', '#fab', '#side']) $(s).hidden = false;
  setSide(localStorage.getItem('capnslog.side') !== '0' && matchMedia('(min-width: 801px)').matches);
  await nb.load();
  armIdle();
  await nb.syncNow();
  nb.startPolling();
  if (/^#\/[sb]\//.test(location.hash)) route();
  else if (firstScroll) { firstScroll = false; requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight)); }
}

boot();
