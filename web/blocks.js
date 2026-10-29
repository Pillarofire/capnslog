// Block kinds. Each kind renders into `body` and mutates `e.d`; call ctx.change() after any edit.
import { sanitizeHtml, safeHref, escapeHtml, textToHtml } from './sanitize.js';
import { paint, LANGS } from './highlight.js';
export const kinds = {};
const mk = (tag, props = {}) => Object.assign(document.createElement(tag), props);

/* ---------- note ---------- */
// Notes hold sanitized HTML in d.html (legacy plain notes have only d.text) and a plain-text copy in d.text for search.
const FMT = [
  ['B', 'Bold (Ctrl+B)', 'bold'], ['I', 'Italic (Ctrl+I)', 'italic'], ['U', 'Underline (Ctrl+U)', 'underline'],
  ['S', 'Strikethrough', 'strikeThrough'], ['H1', 'Heading 1', 'block', 'h1'], ['H2', 'Heading 2', 'block', 'h2'],
  ['•', 'Bullet list', 'insertUnorderedList'], ['1.', 'Numbered list', 'insertOrderedList'],
  ['⇥', 'Increase indent (Tab in a list)', 'indent'], ['⇤', 'Decrease indent (Shift+Tab in a list)', 'outdent'],
  ['❝', 'Quote', 'block', 'blockquote'], ['‹›', 'Inline code', 'code'], ['{ }', 'Code block (toggle)', 'codeblock'],
  ['🔗', 'Link (Ctrl+K)', 'link'],
  ['―', 'Divider', 'insertHorizontalRule'], ['⌫', 'Clear formatting', 'removeFormat'],
];
const noteHtml = (e) => (e.d.html != null ? sanitizeHtml(e.d.html) : textToHtml(e.d.text || ''));

kinds.note = {
  label: 'Note',
  blank: () => ({ text: '', html: '' }),
  text: (e) => e.d.text ?? '',
  render(body, e, ctx) {
    const c = mk('div', { className: 'c', contentEditable: 'true', spellcheck: true });
    c.dataset.ph = 'Write something…';
    c.innerHTML = noteHtml(e);
    const src = mk('textarea', { className: 'src', spellcheck: false, hidden: true });
    const inPre = () => {
      const n = getSelection().anchorNode;
      const el = n?.nodeType === 1 ? n : n?.parentElement;
      const pre = el?.closest('pre');
      return pre && c.contains(pre) ? pre : null;
    };
    const sync = () => {
      e.d.html = sanitizeHtml(c.innerHTML);
      e.d.text = c.innerText.replace(/\n$/, '');
      paint(c);
      ctx.change();
    };
    c.addEventListener('input', sync);
    c.addEventListener('paste', (ev) => {
      ev.preventDefault();
      const h = ev.clipboardData.getData('text/html');
      const t = ev.clipboardData.getData('text/plain');
      if (inPre()) document.execCommand('insertText', false, t);
      else document.execCommand('insertHTML', false, h ? sanitizeHtml(h) : textToHtml(t));
    });
    c.addEventListener('click', (ev) => {
      const a = ev.target.closest?.('a[href]');
      if (a && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); window.open(a.href, '_blank', 'noopener,noreferrer'); }
    });

    const link = () => {
      const sel = getSelection();
      const url = prompt('Link URL (empty to remove):', 'https://');
      if (url === null) return;
      const ok = url.trim() && safeHref(url.trim());
      if (!ok) { document.execCommand('unlink'); return; }
      if (sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${escapeHtml(ok)}">${escapeHtml(ok)}</a>`);
      else document.execCommand('createLink', false, ok);
    };
    const codeBlock = () => {
      c.focus();
      const pre = inPre();
      if (pre) { // unwrap back to plain lines
        const div = mk('div');
        const lines = pre.textContent.replace(/\n$/, '').split('\n');
        lines.forEach((l, i) => { if (i) div.append(mk('br')); div.append(document.createTextNode(l)); });
        pre.replaceWith(div);
        getSelection().collapse(div, div.childNodes.length);
      } else {
        const t = getSelection().toString().replace(/\n$/, '');
        document.execCommand('insertHTML', false, `<pre data-lang="auto" id="__newcode"><code>${t ? escapeHtml(t) : '<br>'}</code></pre><p><br></p>`);
        const np = c.querySelector('#__newcode');
        if (np) {
          np.removeAttribute('id');
          const r = document.createRange();
          r.selectNodeContents(np.firstChild);
          r.collapse(!t ? true : false);
          getSelection().removeAllRanges();
          getSelection().addRange(r);
        }
      }
      sync();
      refreshLang();
    };
    const run = ([, , cmd, arg]) => {
      c.focus();
      if (cmd === 'block') {
        const cur = String(document.queryCommandValue('formatBlock')).toLowerCase();
        document.execCommand('formatBlock', false, cur === arg ? 'div' : arg);
      } else if (cmd === 'code') {
        const t = getSelection().toString();
        if (t) document.execCommand('insertHTML', false, `<code>${escapeHtml(t)}</code>`);
      } else if (cmd === 'codeblock') { codeBlock(); return; }
      else if (cmd === 'link') link();
      else document.execCommand(cmd, false, null);
      sync();
    };
    c.addEventListener('keydown', (ev) => {
      if (ev.key === 'Tab' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        if (inPre()) {
          ev.preventDefault();
          if (!ev.shiftKey) document.execCommand('insertText', false, '  ');
          else {
            const s = getSelection();
            const before = s.isCollapsed && s.anchorNode?.nodeType === 3 ? s.anchorNode.data.slice(Math.max(0, s.anchorOffset - 2), s.anchorOffset) : '';
            if (before === '  ') { document.execCommand('delete'); document.execCommand('delete'); }
          }
          sync();
          return;
        }
        const n = getSelection().anchorNode;
        if ((n?.nodeType === 1 ? n : n?.parentElement)?.closest('li')) {
          ev.preventDefault();
          document.execCommand(ev.shiftKey ? 'outdent' : 'indent', false, null);
          sync();
        }
        return;
      }
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
      const k = ev.key.toLowerCase();
      const cmd = { b: 'bold', i: 'italic', u: 'underline' }[k];
      if (cmd) { ev.preventDefault(); document.execCommand(cmd, false, null); sync(); }
      else if (k === 'k') { ev.preventDefault(); link(); sync(); }
    });

    const bar = mk('div', { className: 'fmt' });
    for (const f of FMT) {
      const b = mk('button', { type: 'button', textContent: f[0], title: f[1] });
      b.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep the text selection
      b.addEventListener('click', () => run(f));
      bar.append(b);
    }
    const lang = mk('select', { className: 'lang', title: 'Code block language', disabled: true });
    for (const l of LANGS) lang.append(mk('option', { value: l, textContent: l }));
    let curPre = null;
    function refreshLang() {
      curPre = inPre();
      lang.disabled = !curPre;
      lang.value = curPre ? (LANGS.includes(curPre.dataset.lang) ? curPre.dataset.lang : 'auto') : 'auto';
    }
    lang.addEventListener('change', () => {
      if (!curPre?.isConnected) return;
      curPre.dataset.lang = lang.value;
      sync();
    });
    for (const ev of ['keyup', 'mouseup', 'focus']) c.addEventListener(ev, refreshLang);
    bar.append(lang);
    const tog = mk('button', { type: 'button', textContent: '</>', title: 'Edit HTML source' });
    tog.addEventListener('click', () => {
      if (src.hidden) {
        src.value = sanitizeHtml(c.innerHTML).replace(/<\/(p|div|li|ul|ol|h\d|blockquote|tr|pre)>/g, '</$1>\n');
        src.hidden = false; c.hidden = true; tog.classList.add('on'); src.focus();
      } else {
        c.innerHTML = e.d.html ?? '';
        paint(c);
        src.hidden = true; c.hidden = false; tog.classList.remove('on'); c.focus();
      }
    });
    src.addEventListener('input', () => {
      e.d.html = sanitizeHtml(src.value);
      const tmp = mk('div'); tmp.innerHTML = e.d.html;
      e.d.text = tmp.innerText.replace(/\n$/, '');
      ctx.change();
    });
    bar.append(tog);
    body.append(bar, c, src);
    // Paint once attached: ranges need connected nodes.
    queueMicrotask(() => paint(c));
    return () => (src.hidden ? c : src).focus();
  },
};

/* ---------- calculator ---------- */
let calcAns = 0;
function evalExpr(src) {
  const s = src.replace(/\^/g, '**');
  if (!/^[\w\s+\-*/%().,<>=!&|?:]*$/.test(s)) throw new Error('invalid characters');
  const names = Object.getOwnPropertyNames(Math);
  const allowed = new Set(names);
  for (const n of s.match(/[A-Za-z_]\w*/g) || []) if (!allowed.has(n) && n !== 'ans') throw new Error('unknown: ' + n);
  return new Function('ans', ...names, '"use strict";return (' + s + ')')(calcAns, ...names.map((k) => Math[k]));
}
kinds.calc = {
  label: 'Calc',
  blank: () => ({ expr: '' }),
  text: (e) => e.d.expr || '',
  render(body, e, ctx) {
    const inp = mk('input', { placeholder: 'e.g. (3+4)*sin(PI/2)^2', value: e.d.expr || '' });
    const res = mk('div', { className: 'res' });
    const run = () => {
      res.classList.remove('bad');
      if (!ctx.settings().code) { res.textContent = 'Code cells are disabled in settings'; res.classList.add('bad'); return; }
      if (!inp.value.trim()) { res.textContent = ''; return; }
      try { const v = evalExpr(inp.value); res.textContent = '= ' + v; if (typeof v === 'number') calcAns = v; }
      catch (err) { res.textContent = err.message; res.classList.add('bad'); }
    };
    inp.addEventListener('input', () => { e.d.expr = inp.value; run(); ctx.change(); });
    body.append(inp, res);
    run();
    return () => inp.focus();
  },
};

/* ---------- JS REPL (inert until Run) ---------- */
kinds.repl = {
  label: 'JS',
  blank: () => ({ code: '', out: '' }),
  text: (e) => e.d.code || '',
  render(body, e, ctx) {
    const out = mk('pre', { textContent: e.d.out || '' });
    const ta = mk('textarea', { value: e.d.code || '', spellcheck: false, placeholder: 'JavaScript… press Run or Ctrl+Enter (globals persist)' });
    const log = (t) => { out.textContent += t + '\n'; out.scrollTop = out.scrollHeight; };
    const fmt = (v) => { if (typeof v === 'string') return v; try { return typeof v === 'function' || v === undefined ? String(v) : JSON.stringify(v); } catch { return String(v); } };
    const run = () => {
      if (!ctx.settings().code) { log('Code cells are disabled in settings'); return; }
      const orig = {};
      for (const m of ['log', 'warn', 'error', 'info']) {
        orig[m] = console[m];
        console[m] = (...a) => { orig[m].apply(console, a); log((m === 'log' ? '' : m + ': ') + a.map(fmt).join(' ')); };
      }
      log('> ' + ta.value.split('\n').join('\n  '));
      try { const r = (0, eval)(ta.value); if (r !== undefined) log('← ' + fmt(r)); } catch (err) { log('✗ ' + err); }
      Object.assign(console, orig);
      e.d.out = out.textContent.slice(-4000);
      ctx.change();
    };
    ta.addEventListener('input', () => { e.d.code = ta.value; ctx.change(); });
    ta.addEventListener('keydown', (ev) => { if (ev.ctrlKey && ev.key === 'Enter') { ev.preventDefault(); run(); } });
    const row = mk('div', { className: 'row' });
    row.append(
      mk('button', { textContent: '▶ Run', onclick: run }),
      mk('button', { textContent: 'Clear', onclick: () => { out.textContent = ''; e.d.out = ''; ctx.change(); } }),
    );
    body.append(ta, row, out);
    return () => ta.focus();
  },
};

/* ---------- media ---------- */
export function guessKind(url) {
  if (/\.(mp4|webm|ogv|mov)(\?|$)/i.test(url)) return 'video';
  if (/\.(mp3|wav|ogg|m4a|flac)(\?|$)/i.test(url)) return 'audio';
  if (/\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(url)) return 'image';
  return 'embed';
}
export function safeUrl(u) {
  try {
    const x = new URL(u);
    const web = x.protocol === 'http:' || x.protocol === 'https:';
    return web && x.origin !== location.origin ? x.href : null;
  } catch { return null; }
}
kinds.media = {
  label: 'Media',
  blank: () => ({}),
  text: (e) => [e.d.name, e.d.src].filter(Boolean).join(' '),
  render(body, e, ctx) {
    const d = e.d;
    const wrap = mk('div', { className: 'mwrap' });
    if (d.w) wrap.style.width = d.w + 'px';
    if (d.h) wrap.style.height = d.h + 'px';
    body.append(wrap);
    const kind = d.kind || (d.mime || '').split('/')[0] || 'image';
    const make = (url) => {
      let n;
      if (kind === 'embed') { n = mk('iframe', { allowFullscreen: true, referrerPolicy: 'no-referrer', sandbox: 'allow-scripts allow-same-origin allow-presentation allow-popups' }); n.src = url; }
      else if (kind === 'video') n = mk('video', { controls: true, src: url });
      else if (kind === 'audio') { n = mk('audio', { controls: true, src: url }); wrap.classList.add('audio'); }
      else n = mk('img', { src: url, alt: d.name || '' });
      wrap.append(n);
    };
    if (d.blob) {
      wrap.textContent = 'Decrypting…';
      ctx.blobUrl(d.blob, d.mime).then((u) => { wrap.textContent = ''; make(u); }, () => { wrap.textContent = 'Could not load media'; });
    } else {
      const u = safeUrl(d.src || '');
      if (u) make(u); else wrap.textContent = 'Blocked: only external http(s) URLs are allowed';
    }
    let t = null;
    new ResizeObserver(() => {
      const w = Math.round(wrap.offsetWidth), h = Math.round(wrap.offsetHeight);
      if (!w || !h || (Math.abs(w - (d.w || w)) < 2 && Math.abs(h - (d.h || h)) < 2)) return;
      clearTimeout(t);
      t = setTimeout(() => { d.w = w; d.h = h; ctx.change(); }, 400);
    }).observe(wrap);
  },
};

/* ---------- ink: pixel-perfect, no antialiasing, one transparent PNG per block ---------- */
kinds.draw = {
  label: 'Ink',
  blank: () => ({
    png: '', cw: Math.max(240, Math.min(720, innerWidth - 40)), ch: 300,
    color: document.documentElement.dataset.theme === 'dark' ? '#e6e6e6' : '#111111', size: 3,
  }),
  text: () => '',
  render(body, e, ctx) {
    const d = e.d;
    const cv = mk('canvas');
    cv.width = d.cw; cv.height = d.ch;
    const ctx2 = cv.getContext('2d');
    ctx2.imageSmoothingEnabled = false;
    if (d.png) { const im = new Image(); im.onload = () => ctx2.drawImage(im, 0, 0); im.src = d.png; }
    let erasing = false, on = true;
    cv.classList.add('on');
    e.beforeSave = () => { d.png = cv.toDataURL('image/png'); };

    const pen = mk('button', { title: 'Pen / eraser' });
    const colorIn = mk('input', { type: 'color', value: d.color, oninput: (ev) => { d.color = ev.target.value; erasing = false; sync(); } });
    const sizeIn = mk('input', { type: 'range', min: 1, max: 32, value: d.size, title: 'Brush size', oninput: (ev) => { d.size = +ev.target.value; } });
    const toggle = mk('button', { textContent: 'Draw: on', title: 'When off, touch scrolls the page' });
    const clr = mk('button', { textContent: 'Clear', onclick: () => { ctx2.clearRect(0, 0, cv.width, cv.height); ctx.change(); } });
    const taller = mk('button', {
      textContent: '↕ Taller',
      onclick: () => {
        const tmp = mk('canvas'); tmp.width = cv.width; tmp.height = cv.height; tmp.getContext('2d').drawImage(cv, 0, 0);
        cv.height = d.ch = cv.height + 200;
        ctx2.imageSmoothingEnabled = false;
        ctx2.drawImage(tmp, 0, 0);
        ctx.change();
      },
    });
    const sync = () => { pen.textContent = erasing ? '🧽 Erase' : '✏️ Pen'; };
    pen.onclick = () => { erasing = !erasing; sync(); };
    toggle.onclick = () => { on = !on; cv.classList.toggle('on', on); toggle.textContent = 'Draw: ' + (on ? 'on' : 'off'); };
    sync();
    const tools = mk('div', { className: 'tools' });
    tools.append(pen, colorIn, sizeIn, toggle, taller, clr);

    // Integer-aligned filled disc: only whole pixels are touched, so edges stay crisp.
    function stamp(x, y, s, erase) {
      const r = s / 2;
      for (let dy = 0; dy < s; dy++) {
        const yy = dy + 0.5 - r;
        const hw = Math.sqrt(Math.max(0, r * r - yy * yy));
        const x0 = Math.round(x - hw), w = Math.max(1, Math.round(x + hw) - x0);
        const py = y - Math.floor(r) + dy;
        if (erase) ctx2.clearRect(x0, py, w, 1); else ctx2.fillRect(x0, py, w, 1);
      }
    }
    function line(a, b, erase) { // Bresenham with size interpolation
      let x0 = a.x, y0 = a.y;
      const x1 = b.x, y1 = b.y;
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      const n = Math.max(dx, -dy) || 1;
      let i = 0;
      for (;;) {
        stamp(x0, y0, Math.max(1, Math.round(a.s + (b.s - a.s) * (i / n))), erase);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
        i++;
      }
    }
    const pt = (ev, ers) => {
      const r = cv.getBoundingClientRect();
      const pen3 = ev.pointerType === 'pen';
      const p = pen3 ? (ev.pressure || 0.01) : 0.5;
      const tilt = pen3 ? Math.hypot(ev.tiltX || 0, ev.tiltY || 0) / 90 : 0;
      let s = d.size * (0.25 + 1.5 * p) * (1 + 0.8 * tilt);
      if (ers) s = d.size * 1.5;
      return { x: Math.floor((ev.clientX - r.left) * cv.width / r.width), y: Math.floor((ev.clientY - r.top) * cv.height / r.height), s: Math.max(1, Math.round(s)) };
    };
    let last = null, ers = false;
    cv.addEventListener('pointerdown', (ev) => {
      if (!on || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
      ev.preventDefault();
      cv.setPointerCapture(ev.pointerId);
      ers = erasing || (ev.buttons & 32) !== 0;
      ctx2.fillStyle = d.color;
      last = pt(ev, ers);
      line(last, last, ers);
    });
    cv.addEventListener('pointermove', (ev) => {
      if (!last) return;
      const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
      for (const x of evs.length ? evs : [ev]) { const p = pt(x, ers); line(last, p, ers); last = p; }
    });
    const end = () => { if (last) { last = null; ctx.change(); } };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    const wrap = mk('div', { className: 'inkwrap' });
    wrap.append(cv);
    body.append(tools, wrap);
  },
};
