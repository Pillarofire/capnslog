// All cryptography runs in the browser. The server only ever receives ciphertext.
const te = new TextEncoder();
const td = new TextDecoder();

export const b64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');

// Starting Argon2id parameters (memory in KiB). Benchmark on the slowest device and tune.
export const DEFAULT_KDF = { alg: 'argon2id', m: 65536, t: 3, p: 1 };
const CHECK_TEXT = 'capnslog-check-v1';

export class WrongPassError extends Error {
  constructor() { super('Wrong passkey'); this.name = 'WrongPassError'; }
}

function validateKdf(k) {
  const ok = k && k.alg === 'argon2id'
    && Number.isInteger(k.m) && k.m >= 8192 && k.m <= 262144
    && Number.isInteger(k.t) && k.t >= 1 && k.t <= 12
    && Number.isInteger(k.p) && k.p >= 1 && k.p <= 4;
  if (!ok) throw new Error('Unsupported or out-of-range KDF parameters');
}

function workerKdf(pass, salt, kdf) {
  return new Promise((resolve, reject) => {
    const w = new Worker('/kdf-worker.js');
    w.onmessage = (e) => { w.terminate(); e.data.error ? reject(new Error(e.data.error)) : resolve(new Uint8Array(e.data.bits)); };
    w.onerror = () => { w.terminate(); reject(new Error('Key derivation worker failed')); };
    w.postMessage({ pass, salt, m: kdf.m, t: kdf.t, p: kdf.p });
  });
}
let kdfRunner = workerKdf;
export const setKdfRunner = (fn) => { kdfRunner = fn; };

async function deriveKey(pass, salt, kdf) {
  validateKdf(kdf);
  const bits = await kdfRunner(pass.normalize('NFKC'), salt, kdf);
  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptBytes(key, bytes, aad) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: te.encode(aad) }, key, bytes));
  return { nonce, ct };
}
export async function decryptBytes(key, nonce, ct, aad) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: te.encode(aad) }, key, ct));
}
export const encryptJSON = (key, obj, aad) => encryptBytes(key, te.encode(JSON.stringify(obj)), aad);
export async function decryptJSON(key, nonce, ct, aad) {
  return JSON.parse(td.decode(await decryptBytes(key, nonce, ct, aad)));
}

// AAD binds each ciphertext to its block id and revision so the server cannot swap or replay blocks.
export const blockAad = (id, rev) => `block:${id}:${rev}`;
export const blobAad = (id) => `blob:${id}`;

export async function createNotebook(pass, kdf = DEFAULT_KDF) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(pass, salt, kdf);
  const check = await encryptBytes(key, te.encode(CHECK_TEXT), 'meta');
  const meta = { v: 1, kdf: { ...kdf }, salt: b64(salt), check: { nonce: b64(check.nonce), ct: b64(check.ct) } };
  return { meta, key };
}

export async function unlockNotebook(meta, pass) {
  if (!meta || meta.v !== 1) throw new Error('Unknown notebook format');
  const key = await deriveKey(pass, unb64(meta.salt), meta.kdf);
  try {
    const plain = await decryptBytes(key, unb64(meta.check.nonce), unb64(meta.check.ct), 'meta');
    if (td.decode(plain) !== CHECK_TEXT) throw new Error('bad check');
  } catch {
    throw new WrongPassError();
  }
  return key;
}
