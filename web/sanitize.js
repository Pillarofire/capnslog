// Allowlist HTML sanitizer for note content. Parses into an inert document, rebuilds only permitted nodes.
const TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'mark', 'sub', 'sup', 'code', 'pre', 'kbd',
  'blockquote', 'h1', 'h2', 'h3', 'h4', 'p', 'div', 'span', 'br', 'hr', 'ul', 'ol', 'li', 'a',
  'table', 'thead', 'tbody', 'tr', 'td', 'th']);
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math', 'img', 'video', 'audio', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'title']);
const COLOR = /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d\s,.%]+\))$/i;

export function safeHref(h) {
  try {
    const u = new URL(h, 'http://x.invalid/');
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) && !/^\s*(javascript|data):/i.test(h) ? h : null;
  } catch { return null; }
}

function preText(n, out = []) {
  for (const k of n.childNodes) {
    if (k.nodeType === 3) out.push(k.data);
    else if (k.nodeType === 1 && k.localName === 'br') { if (k.nextSibling || k.parentNode !== n) out.push('\n'); }
    else if (k.nodeType === 1) preText(k, out);
  }
  return out;
}

function clean(src, out, doc) {
  for (const n of src.childNodes) {
    if (n.nodeType === 3) {
      out.append(doc.createTextNode(n.data.replace(/[ \t\r\n]+/g, ' ')));
    } else if (n.nodeType === 1) {
      const tag = n.localName;
      if (DROP.has(tag)) continue;
      if (tag === 'pre') { // code block: keep whitespace verbatim, flatten to <pre data-lang><code>text</code></pre>
        const pre = doc.createElement('pre');
        const lang = (n.getAttribute('data-lang') || '').toLowerCase();
        if (/^[a-z0-9+#-]{1,12}$/.test(lang)) pre.setAttribute('data-lang', lang);
        const code = doc.createElement('code');
        code.textContent = preText(n).join('');
        pre.append(code);
        out.append(pre);
        continue;
      }
      if (!TAGS.has(tag)) { clean(n, out, doc); continue; } // unknown tag: keep its text, drop the wrapper
      const el = doc.createElement(tag);
      if (tag === 'a') {
        const h = safeHref(n.getAttribute('href') || '');
        if (h) { el.setAttribute('href', h); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer nofollow'); }
      }
      if (tag === 'span' || tag === 'mark') {
        const st = [];
        const c = n.style?.color, b = n.style?.backgroundColor;
        if (c && COLOR.test(c)) st.push('color:' + c);
        if (b && COLOR.test(b)) st.push('background-color:' + b);
        if (st.length) el.setAttribute('style', st.join(';'));
      }
      if (tag === 'td' || tag === 'th') {
        for (const a of ['colspan', 'rowspan']) if (/^\d{1,2}$/.test(n.getAttribute(a) || '')) el.setAttribute(a, n.getAttribute(a));
      }
      clean(n, el, doc);
      out.append(el);
    }
  }
}

export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString('<!doctype html><body>' + html, 'text/html');
  const box = doc.createElement('div');
  clean(doc.body, box, doc);
  return box.innerHTML;
}

export const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const textToHtml = (t) => escapeHtml(t).replace(/\n/g, '<br>');
