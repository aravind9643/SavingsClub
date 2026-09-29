import { supabase } from './supabase';
import { getLang } from './i18n';

/**
 * Phone notifications, the browser half. The service worker (public/sw.js)
 * shows them; the `notify` Edge Function sends a daily digest.
 *
 * The public VAPID key is public by design -- the browser needs it to prove a
 * push came from us -- so it is a VITE_ variable. Its private half lives only
 * in the function's secrets.
 */
const PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? '';

export type PushState = 'unsupported' | 'unconfigured' | 'blocked' | 'off' | 'on' | 'needs-install';

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches
  || (navigator as unknown as { standalone?: boolean }).standalone === true;

function keyBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const p = b64u.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64u.length + 3) % 4);
  const bin = atob(p);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  // Registered in main.tsx for production builds; register here too so the
  // switch works in a dev build.
  return (await navigator.serviceWorker.getRegistration()) ?? navigator.serviceWorker.register('/sw.js');
}

export async function pushState(): Promise<PushState> {
  // iPhone Safari offers push only to an app added to the Home Screen.
  if (isIos() && !isStandalone()) return 'needs-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (!PUBLIC_KEY) return 'unconfigured';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

export async function enablePush(): Promise<PushState> {
  if (Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') return p === 'denied' ? 'blocked' : 'off';
  }
  const reg = await registration();
  if (!reg) return 'unsupported';
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(PUBLIC_KEY) });
  const j = sub.toJSON();
  const { error } = await supabase.rpc('save_push_subscription', {
    p_endpoint: j.endpoint, p_p256dh: j.keys?.p256dh, p_auth: j.keys?.auth, p_lang: getLang(),
  });
  if (error) {
    await sub.unsubscribe();
    throw error;
  }
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await supabase.rpc('remove_push_subscription', { p_endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  return 'off';
}

/** Re-send the language after it changes, so tomorrow's digest matches. */
export async function syncPushLanguage(): Promise<void> {
  const reg = await registration().catch(() => null);
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const j = sub.toJSON();
  await supabase.rpc('save_push_subscription', {
    p_endpoint: j.endpoint, p_p256dh: j.keys?.p256dh, p_auth: j.keys?.auth, p_lang: getLang(),
  });
}
