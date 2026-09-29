// Web Push without a library: RFC 8291 (message encryption, aes128gcm) and
// RFC 8292 (VAPID). Only WebCrypto and fetch, so the same file runs in the
// Edge Function (Deno) and in the Node test beside it.
//
// Push services are free and need no account: the browser vendor's service
// (FCM for Chrome, Mozilla's, Apple's) accepts any request signed with the
// VAPID key whose public half the browser was given at subscribe time.

export interface PushTarget {
  endpoint: string;
  /** Browser's P-256 public key, base64url, 65 bytes uncompressed. */
  p256dh: string;
  /** Browser's auth secret, base64url, 16 bytes. */
  auth: string;
}

export interface Vapid {
  /** Private key as a JWK (kty EC, crv P-256, with d). */
  privateJwk: JsonWebKey;
  /** Contact for the push service operator: mailto: or https: URL. */
  subject: string;
}

const enc = new TextEncoder();

export function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(p);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** HKDF with one output block (every length here is <= 32). */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len);
}

/** The VAPID public key (raw, 65 bytes) that goes to the browser. */
export function vapidPublicKey(jwk: JsonWebKey): Uint8Array {
  return concat(new Uint8Array([4]), unb64u(jwk.x!), unb64u(jwk.y!));
}

/** RFC 8292: `Authorization: vapid t=<JWT>, k=<public key>`. */
export async function vapidHeader(endpoint: string, v: Vapid, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: nowSec + 12 * 3600,
    sub: v.subject,
  })));
  const { kty, crv, x, y, d } = v.privateJwk;
  const key = await crypto.subtle.importKey('jwk', { kty, crv, x, y, d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto's ECDSA output is already r||s, the form JWS wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${b64u(vapidPublicKey(v.privateJwk))}`;
}

/**
 * RFC 8291 / RFC 8188 aes128gcm body for one recipient, in a single record.
 * `salt` and `ephemeral` are parameters only so a test can fix them.
 */
export async function encryptPayload(
  target: PushTarget,
  plaintext: Uint8Array,
  opts: { salt?: Uint8Array; ephemeral?: CryptoKeyPair } = {},
): Promise<Uint8Array> {
  const uaPublic = unb64u(target.p256dh);
  const authSecret = unb64u(target.auth);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const as = opts.ephemeral ?? await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  // Key combination (RFC 8291 section 3.3), then content keys (RFC 8188).
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // One record: the plaintext, then the 0x02 "last record" delimiter.
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));

  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096, big-endian
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

export interface SendResult { status: number; gone: boolean; body?: string }

export async function sendPush(target: PushTarget, payload: unknown, v: Vapid, ttlSec = 12 * 3600): Promise<SendResult> {
  const body = await encryptPayload(target, enc.encode(JSON.stringify(payload)));
  const res = await fetch(target.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(target.endpoint, v),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttlSec),
      Urgency: 'normal',
    },
    body,
  });
  // 404 / 410: the browser dropped this subscription. Delete it, or every
  // day's run spends a request on a device that will never answer.
  return { status: res.status, gone: res.status === 404 || res.status === 410, body: res.ok ? undefined : await res.text() };
}
