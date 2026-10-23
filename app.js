'use strict';
const SAVE_INTERVAL_MS = 2000;
const KEY_PLAIN = 'notebook.state', KEY_ENC = 'notebook.enc';
const $ = (s) => document.querySelector(s);
const page = $('#page'), statusEl = $('#status');
let tool = null, zTop = 1, locked = false, lastSaved = null;

/* ---------- item chrome ---------- */
const kinds = {};

function createItem(spec) {
  const k = kinds[spec.type];
  const el = document.createElement('section');
  el.className = 'item ' + spec.type;
  el.style.left = (spec.x || 0) + 'px';
  el.style.top = (spec.y || 0) + 'px';
  el.style.zIndex = spec.z || ++zTop;
  zTop = Math.max(zTop, spec.z || 0);
  const head = document.createElement('header');
  const label = document.createElement('span');
  label.textContent = '⠿ ' + k.label;
  const grow = Object.assign(document.createElement('span'), { className: 'grow' });
  head.append(label, grow);
  const body = document.createElement('div');
  body.className = 'body';
  const del = document.createElement('button');
  del.textContent = '✕';
  del.title = 'Delete';
  del.onclick = () => el.remove();
  el.append(head, body);
  el._get = k.init(body, head, spec.data || {}, spec);
  head.append(del);
  el._body = body;
  if (spec.w) body.style.width = spec.w + 'px';
  if (spec.h) body.style.height = spec.h + 'px';
  page.append(el);
  enableDrag(el, head);
  el.addEventListener('pointerdown', () => { el.style.zIndex = ++zTop; }, true);
  fitPage();
  return el;
}

function enableDrag(el, head) {
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button,input,select')) return;
    head.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY, ox = el.offsetLeft, oy = el.offsetTop;
    const move = (m) => {
      el.style.left = Math.max(0, ox + m.clientX - sx) + 'px';
      el.style.top = Math.max(0, oy + m.clientY - sy) + 'px';
    };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); fitPage(); };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
}

function fitPage() {
  let h = 0;
  for (const el of page.children) h = Math.max(h, el.offsetTop + el.offsetHeight + 80);
  page.style.minHeight = Math.max(h, innerHeight - 100) + 'px';
}

/* ---------- note ---------- */
kinds.note = {
  label: 'Note',
  init(body, head, d) {
    body.contentEditable = 'true';
    body.textContent = d.text || '';
    if (!d.text) setTimeout(() => body.focus(), 0);
    return () => ({ text: body.innerText });
  }
};

/* ---------- calculator ---------- */
function evalExpr(src) {
  const s = src.replace(/\^/g, '**');
  if (!/^[\w\s+\-*/%().,<>=!&|?:]*$/.test(s)) throw new Error('invalid characters');
  const names = (s.match(/[A-Za-z_]\w*/g) || []);
  const allowed = new Set(Object.getOwnPropertyNames(Math));
  for (const n of names) if (!allowed.has(n) && n !== 'ans') throw new Error('unknown: ' + n);
  const fn = new Function('ans', ...Object.getOwnPropertyNames(Math), '"use strict";return (' + s + ')');
  return fn(calcAns, ...Object.getOwnPropertyNames(Math).map((k) => Math[k]));
}
let calcAns = 0;
kinds.calc = {
  label: 'Calc',
  init(body, head, d) {
    const inp = document.createElement('input');
    inp.placeholder = 'e.g. (3+4)*sin(PI/2)^2';
    inp.value = d.expr || '';
    const res = document.createElement('div');
    res.className = 'res';
    const run = () => {
      res.classList.remove('bad');
      if (!inp.value.trim()) { res.textContent = ''; return; }
      try { const v = evalExpr(inp.value); res.textContent = '= ' + v; calcAns = typeof v === 'number' ? v : calcAns; }
      catch (e) { res.textContent = e.message; res.classList.add('bad'); }
    };
    inp.addEventListener('input', run);
    body.append(inp, res);
    run();
    return () => ({ expr: inp.value });
  }
};

/* ---------- JS REPL ---------- */
kinds.repl = {
  label: 'JS REPL',
  init(body, head, d) {
    const out = document.createElement('pre');
    out.textContent = d.out || '';
    const ta = document.createElement('textarea');
    ta.value = d.code || '';
    ta.placeholder = 'JavaScript… (Ctrl+Enter to run; globals persist)';
    ta.spellcheck = false;
    const log = (t) => { out.textContent += t + '\n'; out.scrollTop = out.scrollHeight; };
    const fmt = (v) => { if (typeof v === 'string') return v; try { return typeof v === 'function' || v === undefined ? String(v) : JSON.stringify(v); } catch { return String(v); } };
    const run = () => {
      const orig = {};
      for (const m of ['log', 'warn', 'error', 'info']) {
        orig[m] = console[m];
        console[m] = (...a) => { orig[m].apply(console, a); log((m === 'log' ? '' : m + ': ') + a.map(fmt).join(' ')); };
      }
      log('> ' + ta.value.split('\n').join('\n  '));
      try { const r = (0, eval)(ta.value); if (r !== undefined) log('← ' + fmt(r)); }
      catch (e) { log('✗ ' + e); }
      Object.assign(console, orig);
    };
    const runBtn = Object.assign(document.createElement('button'), { textContent: '▶ Run', onclick: run });
    const clr = Object.assign(document.createElement('button'), { textContent: 'Clear', onclick: () => { out.textContent = ''; } });
    ta.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); run(); } });
    head.querySelector('.grow').after(runBtn, clr);
    body.append(ta, out);
    return () => ({ code: ta.value, out: out.textContent.slice(-4000) });
  }
};

/* ---------- media ---------- */
kinds.media = {
  label: 'Media',
  init(body, head, d) {
    let node;
    const mime = d.mime || '';
    if (d.kind === 'embed') { node = document.createElement('iframe'); node.src = d.src; node.allowFullscreen = true; }
    else if (mime.startsWith('video/') || d.kind === 'video') { node = document.createElement('video'); node.controls = true; node.src = d.src; }
    else if (mime.startsWith('audio/') || d.kind === 'audio') { node = document.createElement('audio'); node.controls = true; node.src = d.src; body.style.height = 'auto'; body.style.resize = 'horizontal'; }
    else { node = document.createElement('img'); node.src = d.src; node.alt = ''; }
    body.append(node);
    return () => ({ src: d.src, mime: d.mime, kind: d.kind });
  }
};

function guessKind(url) {
  if (/\.(mp4|webm|ogv|mov)(\?|$)/i.test(url)) return 'video';
  if (/\.(mp3|wav|ogg|m4a|flac)(\?|$)/i.test(url)) return 'audio';
  if (/\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(url)) return 'image';
  return 'embed';
}

/* ---------- drawing (pixel-perfect, no antialiasing) ---------- */
kinds.draw = {
  label: 'Drawing',
  init(body, head, d) {
    const cv = document.createElement('canvas');
    cv.width = d.cw || 480; cv.height = d.ch || 320;
    const ctx = cv.getContext('2d', { willReadFrequently: false });
    ctx.imageSmoothingEnabled = false;
    if (d.png) { const im = new Image(); im.onload = () => { ctx.drawImage(im, 0, 0); }; im.src = d.png; }
    let erasing = false, color = d.color || '#111111', size = d.size || 3, on = true;
    cv.classList.add('on');

    const mk = (tag, props) => Object.assign(document.createElement(tag), props);
    const pen = mk('button', { textContent: '✏️', title: 'Pen / eraser toggle' });
    const colorIn = mk('input', { type: 'color', value: color, oninput: (e) => { color = e.target.value; erasing = false; sync(); } });
    const sizeIn = mk('input', { type: 'range', min: 1, max: 32, value: size, title: 'Brush size', oninput: (e) => { size = +e.target.value; } });
    const toggle = mk('button', { textContent: 'Draw: on', title: 'When off, touch scrolls the page' });
    const clr = mk('button', { textContent: 'Clear', onclick: () => ctx.clearRect(0, 0, cv.width, cv.height) });
    const sync = () => { pen.textContent = erasing ? '🧽 Erase' : '✏️ Pen'; };
    pen.onclick = () => { erasing = !erasing; sync(); };
    toggle.onclick = () => { on = !on; cv.classList.toggle('on', on); toggle.textContent = 'Draw: ' + (on ? 'on' : 'off'); };
    sync();
    head.querySelector('.grow').after(pen, colorIn, sizeIn, toggle, clr);

    // Integer-aligned filled disc: only whole pixels are touched, so edges stay crisp.
    function stamp(x, y, s, erase) {
      const r = s / 2;
      for (let dy = 0; dy < s; dy++) {
        const yy = dy + 0.5 - r;
        const hw = Math.sqrt(Math.max(0, r * r - yy * yy));
        const x0 = Math.round(x - hw), w = Math.max(1, Math.round(x + hw) - x0);
        const py = y - Math.floor(r) + dy;
        if (erase) ctx.clearRect(x0, py, w, 1); else ctx.fillRect(x0, py, w, 1);
      }
    }
    function line(a, b, erase) { // Bresenham with size interpolation
      let x0 = a.x, y0 = a.y; const x1 = b.x, y1 = b.y;
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy; const n = Math.max(dx, -dy) || 1; let i = 0;
      for (;;) {
        stamp(x0, y0, Math.max(1, Math.round(a.s + (b.s - a.s) * (i / n))), erase);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
        i++;
      }
    }
    const pt = (e, ers) => {
      const r = cv.getBoundingClientRect();
      const p = e.pointerType === 'pen' ? (e.pressure || 0.01) : 0.5;
      const tilt = e.pointerType === 'pen' ? Math.hypot(e.tiltX || 0, e.tiltY || 0) / 90 : 0; // 0..~1.4
      let s = size * (0.25 + 1.5 * p) * (1 + 0.8 * tilt);
      if (ers) s = size * 1.5;
      return { x: Math.floor((e.clientX - r.left) * cv.width / r.width), y: Math.floor((e.clientY - r.top) * cv.height / r.height), s: Math.max(1, Math.round(s)) };
    };
    let last = null, ers = false;
    cv.addEventListener('pointerdown', (e) => {
      if (!on || e.button > 0 && e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      cv.setPointerCapture(e.pointerId);
      ers = erasing || (e.buttons & 32) !== 0; // pen eraser end
      ctx.fillStyle = color;
      last = pt(e, ers);
      line(last, last, ers);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!last) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) { const p = pt(ev, ers); line(last, p, ers); last = p; }
    });
    const end = () => { last = null; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    body.append(cv);
    return () => ({ png: cv.toDataURL('image/png'), cw: cv.width, ch: cv.height, color, size });
  }
};

/* ---------- placement ---------- */
function setTool(t) {
  tool = t;
  document.querySelectorAll('#tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  document.body.classList.toggle('placing', !!t);
}
$('#tools').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && !locked) setTool(tool === b.dataset.tool ? null : b.dataset.tool);
});
const fileIn = $('#file');
let pendingPos = null;

function place(t, x, y) {
  if (['note', 'calc', 'draw', 'repl'].includes(t)) { createItem({ type: t, x, y }); setTool(null); return; }
  pendingPos = { x, y };
  if (t === 'media') fileIn.click();
  else if (t === 'url') {
    const u = prompt('Image / video / audio / embeddable page URL:');
    if (u) createItem({ type: 'media', x, y, data: { src: u, kind: guessKind(u) } });
    setTool(null);
  }
}
page.addEventListener('click', (e) => {
  if (e.target !== page || !tool) return;
  const r = page.getBoundingClientRect();
  place(tool, Math.max(0, e.clientX - r.left), Math.max(0, e.clientY - r.top));
});
page.addEventListener('dblclick', (e) => {
  if (e.target !== page || locked) return;
  const r = page.getBoundingClientRect();
  createItem({ type: 'note', x: e.clientX - r.left, y: e.clientY - r.top });
});
fileIn.addEventListener('change', () => {
  const f = fileIn.files[0];
  fileIn.value = '';
  setTool(null);
  if (!f || !pendingPos) return;
  const fr = new FileReader();
  fr.onload = () => createItem({ type: 'media', x: pendingPos.x, y: pendingPos.y, data: { src: fr.result, mime: f.type } });
  fr.readAsDataURL(f);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setTool(null); });
// Drop files anywhere to insert at that position
page.addEventListener('dragover', (e) => e.preventDefault());
page.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (!f) return;
  const r = page.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const fr = new FileReader();
  fr.onload = () => createItem({ type: 'media', x, y, data: { src: fr.result, mime: f.type } });
  fr.readAsDataURL(f);
});

/* ---------- state ---------- */
function serialize() {
  return JSON.stringify([...page.children].map((el) => {
    const t = [...el.classList].find((c) => kinds[c]);
    const b = el._body;
    return { type: t, x: el.offsetLeft, y: el.offsetTop, z: +el.style.zIndex || 1,
      w: ['media', 'note'].includes(t) ? b.offsetWidth : undefined, h: t === 'media' ? b.offsetHeight : undefined, data: el._get() };
  }));
}
function restore(json) {
  page.replaceChildren();
  for (const s of JSON.parse(json)) if (kinds[s.type]) createItem(s);
  fitPage();
}
function setStatus(t) { statusEl.textContent = t; }

function autosave() {
  if (locked) return;
  const s = serialize();
  if (s === lastSaved) return;
  try { localStorage.setItem(KEY_PLAIN, s); lastSaved = s; setStatus('saved ' + new Date().toLocaleTimeString()); }
  catch { setStatus('⚠ save failed (storage full?)'); }
}
setInterval(autosave, SAVE_INTERVAL_MS);
$('#clear').onclick = () => { if (!locked && confirm('Delete everything?')) { page.replaceChildren(); autosave(); } };

/* ---------- encryption (PBKDF2 -> AES-GCM) ---------- */
const b64 = (buf) => { let s = ''; new Uint8Array(buf).forEach((c) => (s += String.fromCharCode(c))); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encrypt(text, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(pass, salt), new TextEncoder().encode(text));
  return { salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}
async function decrypt(o, pass) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, await deriveKey(pass, unb64(o.salt)), unb64(o.ct));
  return new TextDecoder().decode(pt);
}

const dlg = $('#pass');
function askPass(title, confirmToo) {
  return new Promise((resolve) => {
    $('#passTitle').textContent = title;
    $('#passInput').value = $('#passInput2').value = '';
    $('#passInput2').hidden = !confirmToo;
    $('#passErr').textContent = '';
    const done = () => {
      dlg.removeEventListener('close', done);
      const a = $('#passInput').value;
      if (dlg.returnValue !== 'ok') return resolve(null);
      if (confirmToo && a !== $('#passInput2').value) return resolve(askPass(title, confirmToo));
      resolve(a);
    };
    dlg.addEventListener('close', done);
    dlg.showModal();
  });
}

function showVault(enc) {
  locked = true;
  page.hidden = true; $('#hint').hidden = true;
  $('#vault').hidden = false;
  $('#cipher').textContent = enc.ct.repeat(Math.ceil(4000 / enc.ct.length)).slice(0, Math.max(enc.ct.length, 4000));
  $('#lock').hidden = true;
  setTool(null);
  setStatus('encrypted');
}
$('#lock').onclick = async () => {
  if (!crypto.subtle) return alert('WebCrypto requires https or localhost.');
  const pass = await askPass('Choose a passkey', true);
  if (!pass) return;
  setStatus('encrypting…');
  const enc = await encrypt(serialize(), pass);
  localStorage.setItem(KEY_ENC, JSON.stringify(enc));
  localStorage.removeItem(KEY_PLAIN);
  showVault(enc);
  page.replaceChildren();
};
$('#unlock').onclick = async () => {
  const enc = JSON.parse(localStorage.getItem(KEY_ENC));
  for (;;) {
    const pass = await askPass('Enter passkey', false);
    if (pass == null) return;
    try {
      const json = await decrypt(enc, pass);
      restore(json);
      localStorage.removeItem(KEY_ENC);
      locked = false; lastSaved = null;
      page.hidden = false; $('#hint').hidden = false; $('#vault').hidden = true; $('#lock').hidden = false;
      autosave();
      return;
    } catch { alert('Wrong passkey.'); }
  }
};

/* ---------- theme ---------- */
const themeBtn = $('#theme'), root = document.documentElement;
const syncTheme = () => { themeBtn.textContent = root.dataset.theme === 'dark' ? '☀️' : '🌙'; };
themeBtn.onclick = () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('notebook.theme', root.dataset.theme);
  syncTheme();
};
syncTheme();

/* ---------- boot ---------- */
(function boot() {
  const enc = localStorage.getItem(KEY_ENC);
  if (enc) return showVault(JSON.parse(enc));
  const s = localStorage.getItem(KEY_PLAIN);
  if (s) { try { restore(s); lastSaved = s; } catch (e) { console.error(e); } }
})();
addEventListener('resize', fitPage);
