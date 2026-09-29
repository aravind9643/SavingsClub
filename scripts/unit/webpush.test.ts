import { encryptPayload, vapidHeader, vapidPublicKey, b64u, unb64u } from '../../supabase/functions/_shared/webpush.ts';

let fail = 0;
const eq = (n: string, g: unknown, w: unknown) => { if (g !== w) { fail++; console.log(`FAIL ${n}\n  got  ${g}\n  want ${w}`); } else console.log(`ok   ${n}`); };
const enc = new TextEncoder(); const dec = new TextDecoder();

async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const hkdf = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, l: number) => (await hmac(await hmac(s, ikm), cat(info, new Uint8Array([1])))).slice(0, l);
const jwkFromRaw = (pub: Uint8Array, d?: string): JsonWebKey => ({ kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ...(d ? { d } : {}) });

// The receiving side, written independently from the RFC, to decrypt.
async function decrypt(body: Uint8Array, uaPublic: Uint8Array, uaPrivD: string, auth: Uint8Array) {
  const salt = body.slice(0, 16); const idlen = body[20]; const asPublic = body.slice(21, 21 + idlen); const ct = body.slice(21 + idlen);
  const ua = await crypto.subtle.importKey('jwk', jwkFromRaw(uaPublic, uaPrivD), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua, 256));
  const ikm = await hkdf(auth, shared, cat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, k, ct));
  if (pt[pt.length - 1] !== 2) throw new Error('missing last-record delimiter');
  return dec.decode(pt.slice(0, -1));
}

// 1. RFC 8291 Appendix A, exactly.
const A = {
  plaintext: 'When I grow up, I want to be a watermelon',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const asPub = unb64u(A.asPublic);
const ephemeral = {
  publicKey: await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
  privateKey: await crypto.subtle.importKey('jwk', jwkFromRaw(asPub, A.asPrivate), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
} as CryptoKeyPair;
const body = await encryptPayload({ endpoint: 'https://x', p256dh: A.uaPublic, auth: A.auth }, enc.encode(A.plaintext), { salt: unb64u(A.salt), ephemeral });
eq('RFC 8291 Appendix A body, byte for byte', b64u(body), A.body);
eq('and it decrypts to the plaintext', await decrypt(body, unb64u(A.uaPublic), A.uaPrivate, unb64u(A.auth)), A.plaintext);

// 2. Random keys, random salt: round trip.
const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
const uaRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
const uaJwk = await crypto.subtle.exportKey('jwk', ua.privateKey);
const auth = crypto.getRandomValues(new Uint8Array(16));
const msg = JSON.stringify({ title: 'Sangam', body: 'మీ ₹500 జమ గడువు దాటింది · 1 loan needs your vote' });
const b2 = await encryptPayload({ endpoint: 'https://x', p256dh: b64u(uaRaw), auth: b64u(auth) }, enc.encode(msg));
eq('random-key round trip (Telugu + ₹ intact)', await decrypt(b2, uaRaw, uaJwk.d!, auth), msg);

// 3. VAPID: the JWT verifies under the public key sent as k=, with the right claims.
const vk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
const privateJwk = await crypto.subtle.exportKey('jwk', vk.privateKey);
const h = await vapidHeader('https://fcm.googleapis.com/fcm/send/abc', { privateJwk, subject: 'mailto:ops@example.org' }, 1_800_000_000);
const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
const [hh, cc, ss] = jwt.split('.');
const pub = await crypto.subtle.importKey('raw', unb64u(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
eq('VAPID signature verifies', await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64u(ss), enc.encode(`${hh}.${cc}`)), true);
const claims = JSON.parse(dec.decode(unb64u(cc)));
eq('aud is the push service origin', claims.aud, 'https://fcm.googleapis.com');
eq('exp is 12h out', claims.exp, 1_800_000_000 + 43200);
eq('k= is the public half of the signing key', k, b64u(vapidPublicKey(privateJwk)));

console.log(fail ? `${fail} FAILED` : 'ALL PASSED');
process.exit(fail ? 1 : 0);
