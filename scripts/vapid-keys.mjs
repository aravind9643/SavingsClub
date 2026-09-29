// Generates the VAPID key pair for phone notifications. Run once:
//
//   node scripts/vapid-keys.mjs
//
// It prints two things and writes nothing:
//   VITE_VAPID_PUBLIC_KEY  public -- goes in .env.local and Vercel; browsers
//                          need it to subscribe. Safe in the bundle.
//   VAPID_PRIVATE_JWK      secret -- goes ONLY into `npx supabase secrets set`.
//
// Generating a new pair invalidates every existing subscription: members
// would have to switch notifications on again.

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
const b64u = (b) => Buffer.from(b).toString('base64url');

const privateJwk = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d });
console.log(`VITE_VAPID_PUBLIC_KEY=${b64u(raw)}`);
console.log('');
console.log('Now store the private key (PowerShell):');
console.log(`npx supabase secrets set 'VAPID_PRIVATE_JWK=${privateJwk}'`);
