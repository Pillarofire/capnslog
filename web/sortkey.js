// Fractional ordering keys over [0-9a-z]. between(a, b) returns a key strictly between a and b.
const AL = '0123456789abcdefghijklmnopqrstuvwxyz';

export function between(a = '', b = null) {
  let out = '';
  let bounded = b !== null;
  for (let i = 0; ; i++) {
    const ca = i < a.length ? AL.indexOf(a[i]) : 0;
    const cb = bounded ? (i < b.length ? AL.indexOf(b[i]) : 0) : 36;
    if (ca === cb) { out += AL[ca]; continue; }
    if (cb - ca > 1) return out + AL[(ca + cb) >> 1];
    out += AL[ca];
    bounded = false;
  }
}

export function cmpKey(ka, ia, kb, ib) {
  if (ka !== kb) return ka < kb ? -1 : 1;
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}
