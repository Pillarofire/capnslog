import { sanitizeHtml, escapeHtml } from './sanitize.js';

/* ---- minimal zip reader (central directory + native deflate-raw), no dependencies ---- */
const MAX_ENTRY = 64 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;

async function inflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export function readZip(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip/docx file');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map();
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    total += usize;
    if (usize > MAX_ENTRY || total > MAX_TOTAL) throw new Error('Archive is too large to import');
    entries.set(name, { method, csize, usize, lho });
    p += 46 + nl + el + cl;
  }
  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    async read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const nl = dv.getUint16(e.lho + 26, true), el = dv.getUint16(e.lho + 28, true);
      const start = e.lho + 30 + nl + el;
      const data = u8.subarray(start, start + e.csize);
      if (e.method === 0) return data;
      if (e.method === 8) return inflate(data);
      throw new Error('Unsupported zip compression');
    },
    async text(name) { const b = await this.read(name); return b ? dec.decode(b) : null; },
  };
}

/* ---- docx -> note / media blocks ---- */
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

const kids = (el, name) => [...el.children].filter((c) => c.localName === name);
const kid = (el, name) => kids(el, name)[0] || null;
const attr = (el, name) => el?.getAttributeNS(W, name) ?? el?.getAttribute('w:' + name) ?? null;
const on = (el) => !!el && !['0', 'false', 'none'].includes(attr(el, 'val') ?? '1');

function plain(html, parser) {
  const spaced = html.replace(/<\/(p|h[1-6]|li|tr|pre|blockquote)>|<br\s*\/?>/gi, '\n');
  return (parser.parseFromString(spaced, 'text/html').body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Converts a OneNote-exported .docx into blocks: [{ t:'note', d:{html,text} } | { t:'media', name, mime, bytes }].
 * A new note block starts at every H1/H2 so each page title becomes a sidebar entry.
 */
export async function docxToBlocks(zip, parser = new DOMParser()) {
  const xml = (s) => parser.parseFromString(s, 'application/xml');
  const docXml = await zip.text('word/document.xml');
  if (!docXml) throw new Error('No word/document.xml: this does not look like a .docx');
  const doc = xml(docXml);
  const rels = new Map();
  const relXml = await zip.text('word/_rels/document.xml.rels');
  if (relXml) for (const r of xml(relXml).getElementsByTagName('Relationship')) rels.set(r.getAttribute('Id'), r.getAttribute('Target'));

  const numFmt = new Map();
  const numXml = await zip.text('word/numbering.xml');
  if (numXml) {
    const nd = xml(numXml);
    const abs = new Map();
    for (const a of nd.getElementsByTagNameNS(W, 'abstractNum')) {
      for (const l of kids(a, 'lvl')) abs.set(`${attr(a, 'abstractNumId')}:${attr(l, 'ilvl')}`, attr(kid(l, 'numFmt'), 'val'));
    }
    for (const nm of nd.getElementsByTagNameNS(W, 'num')) {
      const a = attr(kid(nm, 'abstractNumId'), 'val');
      for (let lv = 0; lv < 9; lv++) numFmt.set(`${attr(nm, 'numId')}:${lv}`, abs.get(`${a}:${lv}`));
    }
  }

  const out = [];
  let html = [];
  let stack = [];
  const closeLists = () => { while (stack.length) { const l = stack.pop(); html.push((l.li ? '</li>' : '') + `</${l.tag}>`); } };
  const flush = () => {
    closeLists();
    const clean = sanitizeHtml(html.join(''));
    html = [];
    const text = plain(clean, parser);
    if (text) out.push({ t: 'note', d: { html: clean, text } });
  };

  const runs = (p, images) => {
    let s = '';
    const walk = (node, href) => {
      for (const c of node.children) {
        if (c.localName === 'hyperlink') {
          const rid = c.getAttributeNS(R, 'id');
          const h = rid ? rels.get(rid) : null;
          s += h ? `<a href="${escapeHtml(h)}">` : '';
          walk(c, h);
          s += h ? '</a>' : '';
        } else if (c.localName === 'r') {
          const pr = kid(c, 'rPr');
          const f = pr ? kid(pr, 'rFonts') : null;
          const mono = /consolas|courier|mono/i.test(attr(f, 'ascii') || '');
          const tags = [];
          if (pr && on(kid(pr, 'b'))) tags.push('b');
          if (pr && on(kid(pr, 'i'))) tags.push('i');
          if (pr && on(kid(pr, 'u'))) tags.push('u');
          if (pr && on(kid(pr, 'strike'))) tags.push('s');
          if (mono) tags.push('code');
          let t = '';
          for (const x of c.children) {
            if (x.localName === 't') t += escapeHtml(x.textContent);
            else if (x.localName === 'tab') t += '    ';
            else if (x.localName === 'br') t += '<br>';
            else if (x.localName === 'drawing' || x.localName === 'pict') {
              for (const b of x.getElementsByTagName('*')) {
                const id = (b.localName === 'blip' || b.localName === 'imagedata') && (b.getAttributeNS(R, 'embed') || b.getAttributeNS(R, 'id'));
                if (id) images.push(id);
              }
            }
          }
          if (t) s += tags.map((g) => `<${g}>`).join('') + t + tags.reverse().map((g) => `</${g}>`).join('');
        } else if (['ins', 'smartTag', 'sdt', 'sdtContent', 'fldSimple'].includes(c.localName)) walk(c, href);
      }
    };
    walk(p, null);
    return s;
  };

  const emitImages = async (images) => {
    for (const rid of images) {
      const target = rels.get(rid);
      if (!target) continue;
      const path = target.startsWith('/') ? target.slice(1) : 'word/' + target.replace(/^\.\//, '');
      const ext = path.split('.').pop().toLowerCase();
      if (!MIME[ext] || !zip.has(path)) continue;
      flush();
      out.push({ t: 'media', name: path.split('/').pop(), mime: MIME[ext], bytes: await zip.read(path) });
    }
  };

  const para = async (p) => {
    const images = [];
    const inner = runs(p, images);
    const ppr = kid(p, 'pPr');
    const style = attr(ppr && kid(ppr, 'pStyle'), 'val') || '';
    const num = ppr && kid(ppr, 'numPr');
    const hx = /^heading\s*(\d)$/i.exec(style);
    const hm = hx ? +hx[1] : /^title$/i.test(style) ? 1 : 0;
    if (hm) {
      closeLists();
      if (hm <= 2) flush();
      if (inner.trim()) html.push(`<h${Math.min(hm, 3)}>${inner}</h${Math.min(hm, 3)}>`);
    } else if (num && inner.trim()) {
      const lvl = +(attr(kid(num, 'ilvl'), 'val') || 0), id = attr(kid(num, 'numId'), 'val');
      const tag = (numFmt.get(`${id}:${lvl}`) || 'bullet') === 'bullet' ? 'ul' : 'ol';
      while (stack.length > lvl + 1) { const l = stack.pop(); html.push((l.li ? '</li>' : '') + `</${l.tag}>`); }
      while (stack.length < lvl + 1) { stack.push({ tag, li: false }); html.push(`<${tag}>`); }
      if (stack[lvl].tag !== tag) {
        while (stack.length > lvl) { const l = stack.pop(); html.push((l.li ? '</li>' : '') + `</${l.tag}>`); }
        stack.push({ tag, li: false });
        html.push(`<${tag}>`);
      }
      const top = stack[stack.length - 1];
      if (top.li) html.push('</li>');
      html.push(`<li>${inner}`);
      top.li = true;
    } else if (inner.trim()) {
      closeLists();
      html.push(`<p>${inner}</p>`);
    }
    await emitImages(images);
  };

  const table = async (tbl) => {
    closeLists();
    const images = [];
    let s = '<table>';
    for (const tr of kids(tbl, 'tr')) {
      s += '<tr>';
      for (const tc of kids(tr, 'tc')) {
        const span = +(attr(kid(kid(tc, 'tcPr') || tc, 'gridSpan'), 'val') || 1);
        s += `<td${span > 1 ? ` colspan="${span}"` : ''}>${kids(tc, 'p').map((p) => runs(p, images)).filter(Boolean).join('<br>')}</td>`;
      }
      s += '</tr>';
    }
    html.push(s + '</table>');
    await emitImages(images);
  };

  const body = doc.getElementsByTagNameNS(W, 'body')[0];
  if (!body) throw new Error('Empty document');
  for (const c of body.children) {
    if (c.localName === 'p') await para(c);
    else if (c.localName === 'tbl') await table(c);
  }
  flush();
  return out;
}
