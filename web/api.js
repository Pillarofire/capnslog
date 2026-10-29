const BASE = globalThis.CAPNSLOG_BASE || '';
let token = globalThis.localStorage?.getItem('capnslog.token') || '';
let authHandler = null;

export const getToken = () => token;
export function setToken(t) {
  token = t || '';
  try { localStorage.setItem('capnslog.token', token); } catch { /* storage unavailable */ }
}
export const setAuthHandler = (fn) => { authHandler = fn; };

// Network failures throw TypeError from fetch; callers treat that as "offline".
export async function req(method, path, { json, body, headers } = {}) {
  for (let attempt = 0; ; attempt++) {
    const h = { ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    let out = body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; out = JSON.stringify(json); }
    const r = await fetch(BASE + path, { method, headers: h, body: out, cache: 'no-store' });
    if (r.status === 401 && attempt === 0 && authHandler && (await authHandler())) continue;
    return r;
  }
}
