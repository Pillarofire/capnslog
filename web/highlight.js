// Syntax highlighting via the CSS Custom Highlight API: tokens are painted as ranges, the DOM is never modified.
const W = (s) => '\\b(?:' + s.trim().split(/\s+/).join('|') + ')\\b';
const DQ = '"(?:\\\\[\\s\\S]|[^"\\\\])*"?';
const SQ = "'(?:\\\\[\\s\\S]|[^'\\\\])*'?";
const BT = '`(?:\\\\[\\s\\S]|[^`\\\\])*`?';
const NUM = '\\b(?:0[xX][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b';
const FN = '\\b[A-Za-z_$][\\w$]*(?=\\()';
const TYPE = '\\b[A-Z][\\w]*\\b';

const C_LIKE = (kw, extra = []) => [
  ['com', '//.*|/\\*[\\s\\S]*?(?:\\*/|$)'], ['str', `${DQ}|${SQ}|${BT}`], ...extra, ['num', NUM], ['kw', W(kw)], ['fn', FN], ['type', TYPE],
];

const DEFS = {
  js: C_LIKE('const let var function return if else for while do switch case break continue class extends import export from default new this await async try catch finally throw typeof instanceof in of null undefined true false yield static super delete void get set'),
  ts: C_LIKE('const let var function return if else for while do switch case break continue class extends implements import export from default new this await async try catch finally throw typeof instanceof in of null undefined true false yield static super delete void interface type enum namespace public private protected readonly abstract as is keyof declare string number boolean any unknown never'),
  java: C_LIKE('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws try void volatile while var null true false'),
  c: C_LIKE('auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected new delete this nullptr true false bool using', [['kw', '#\\s*\\w+']]),
  go: C_LIKE('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false'),
  rust: [
    ['com', '//.*|/\\*[\\s\\S]*?(?:\\*/|$)'], ['str', DQ + "|'(?:\\\\.|[^'\\\\\\s])'"], ['num', NUM],
    ['kw', W('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while')],
    ['fn', '\\b[A-Za-z_]\\w*!?(?=[(<])'], ['type', TYPE], ['attr', "'\\w+\\b|#!?\\[[^\\]]*\\]"],
  ],
  python: [
    ['com', '#.*'], ['str', '[rbfRBF]{0,2}(?:"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$))|[rbfRBF]{0,2}(?:' + DQ + '|' + SQ + ')'],
    ['num', NUM], ['attr', '@[\\w.]+'],
    ['kw', W('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False self')],
    ['fn', '\\b[A-Za-z_]\\w*(?=\\()'], ['type', TYPE],
  ],
  bash: [
    ['com', '#.*'], ['str', DQ + '|' + SQ], ['var', '\\$(?:\\{[^}]*\\}|[\\w@#?*$!-]+)'], ['num', NUM],
    ['kw', W('if then else elif fi for while until do done case esac in function return exit export local source alias unset echo cd ls cat grep sed awk git sudo apt npm cargo docker curl mkdir rm cp mv chmod chown tar ssh')],
  ],
  sql: [
    ['com', '--.*|/\\*[\\s\\S]*?(?:\\*/|$)'], ['str', SQ], ['num', NUM],
    ['kw', '(?i)' + W('select from where and or not in is null insert into values update set delete create table alter drop index view join left right inner outer full cross on as group by order having limit offset union all distinct case when then else end primary key foreign references default unique exists between like asc desc count sum avg min max begin commit rollback')],
    ['fn', FN],
  ],
  json: [
    ['attr', DQ + '(?=\\s*:)'], ['str', DQ], ['num', '-?\\d[\\d.eE+-]*'], ['kw', W('true false null')],
  ],
  css: [
    ['com', '/\\*[\\s\\S]*?(?:\\*/|$)'], ['str', DQ + '|' + SQ], ['kw', '@[\\w-]+'], ['num', '#[\\da-fA-F]{3,8}\\b|-?\\d*\\.?\\d+(?:%|[a-z]{1,4}\\b)?'],
    ['attr', '[a-zA-Z-]+(?=\\s*:(?!:))'], ['type', '[.#][\\w-]+|::?[a-zA-Z-]+'], ['fn', '[\\w-]+(?=\\()'],
  ],
  html: [
    ['com', '<!--[\\s\\S]*?(?:-->|$)'], ['kw', '</?[A-Za-z][\\w:-]*|/?>'], ['str', DQ + '|' + SQ], ['attr', '[A-Za-z_:][\\w:.-]*(?==)'], ['type', '&\\w+;'],
  ],
};
DEFS.xml = DEFS.html;

const compiled = {};
function rulesFor(lang) {
  if (compiled[lang]) return compiled[lang];
  const def = DEFS[lang];
  if (!def) return (compiled[lang] = []);
  return (compiled[lang] = def.map(([name, src]) => {
    const ci = src.startsWith('(?i)');
    return [name, new RegExp(ci ? src.slice(4) : src, ci ? 'iy' : 'y')];
  }));
}

export const LANGS = ['auto', 'plain', 'js', 'ts', 'python', 'rust', 'json', 'html', 'css', 'sql', 'bash', 'c', 'java', 'go'];
const ALIAS = { javascript: 'js', typescript: 'ts', py: 'python', rs: 'rust', sh: 'bash', shell: 'bash', cpp: 'c', 'c++': 'c', 'c#': 'java', xml: 'html' };

export function detect(t) {
  const s = t.trim();
  if (!s) return 'plain';
  if (/^[{[]/.test(s) && /"\s*:|^\[\s*[\d"{[\]]/.test(s)) return 'json';
  if (/^<!doctype|^<\/?[a-z][\w-]*[\s>]/i.test(s)) return 'html';
  if (/^#!.*\b(ba|z)?sh\b|^\s*(\$ |sudo |apt |npm |cargo |git |cd |echo |curl )/m.test(s)) return 'bash';
  if (/\bfn\s+\w+|let\s+mut\b|println!|\bimpl\b|use\s+\w+::/.test(s)) return 'rust';
  if (/^package\s+\w+|\bfunc\s+\w*\(|:=/m.test(s)) return 'go';
  if (/^\s*(def |class \w+.*:|import \w+|from \w+ import|elif )|\bprint\(|:\s*$/m.test(s) && !/[;{}]\s*$/m.test(s)) return 'python';
  if (/\b(select|insert\s+into|create\s+table|update\s+\w+\s+set|delete\s+from)\b/i.test(s)) return 'sql';
  if (/#include\s*[<"]|\bint\s+main\s*\(|\bstd::/.test(s)) return 'c';
  if (/\b(public|private)\s+(static\s+)?(class|void|int|String)\b|System\.out/.test(s)) return 'java';
  if (/(^|\})\s*[.#@]?[\w-][^{;]*\{[^}]*:[^}]*;/.test(s) && !/\b(function|const|let|=>)\b/.test(s)) return 'css';
  if (/:\s*(string|number|boolean)\b|\binterface\s+\w+|\btype\s+\w+\s*=/.test(s)) return 'ts';
  if (/\b(const|let|var|function)\b|=>|console\./.test(s)) return 'js';
  return 'plain';
}

export function resolveLang(pre, text) {
  const l = (pre.dataset.lang || 'auto').toLowerCase();
  return l === 'auto' ? detect(text) : ALIAS[l] || l;
}

export function tokenize(text, lang) {
  const rules = rulesFor(lang);
  const out = [];
  if (!rules.length) return out;
  const word = /\w+/y;
  for (let i = 0; i < text.length;) {
    let hit = null;
    for (const [name, re] of rules) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m && m[0].length) { hit = [name, m[0].length]; break; }
    }
    if (hit) { out.push([hit[0], i, i + hit[1]]); i += hit[1]; continue; }
    word.lastIndex = i;
    const w = word.exec(text);
    i += w ? w[0].length : 1;
  }
  return out;
}

const owners = new Map(); // root element -> { name: Range[] }

function locator(code) {
  const segs = [];
  let pos = 0;
  const walk = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) { segs.push([n, pos]); pos += n.data.length; }
  return { text: segs.map(([n]) => n.data).join(''), at(p, end) {
    for (let k = 0; k < segs.length; k++) {
      const [n, s] = segs[k];
      const last = k === segs.length - 1;
      if (p < s + n.data.length || (end && p === s + n.data.length) || last) return [n, Math.min(p - s, n.data.length)];
    }
    return null;
  } };
}

function rebuild() {
  const merged = {};
  for (const [root, byName] of owners) {
    if (!root.isConnected) { owners.delete(root); continue; }
    for (const [n, rs] of Object.entries(byName)) (merged[n] ||= []).push(...rs);
  }
  for (const k of [...CSS.highlights.keys()]) if (k.startsWith('tok-') && !merged[k.slice(4)]) CSS.highlights.delete(k);
  for (const [n, rs] of Object.entries(merged)) CSS.highlights.set('tok-' + n, new Highlight(...rs));
}

export function paint(root) {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
  const byName = {};
  for (const code of root.querySelectorAll('pre > code, pre:not(:has(> code))')) {
    const pre = code.closest('pre');
    const loc = locator(code);
    for (const [name, a, b] of tokenize(loc.text, resolveLang(pre, loc.text))) {
      const s = loc.at(a, false), e = loc.at(b, true);
      if (!s || !e) continue;
      const r = new Range();
      r.setStart(s[0], s[1]);
      r.setEnd(e[0], e[1]);
      (byName[name] ||= []).push(r);
    }
  }
  owners.set(root, byName);
  rebuild();
}
