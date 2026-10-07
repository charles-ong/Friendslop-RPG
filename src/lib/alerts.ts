// Notifications for "your turn" and nudges. With Web Push they arrive even
// when the site is closed; the Gamemaster function sends them. Everything
// here is best-effort: unsupported or denied simply means no notification.

import { savePushSubscription, vapidPublicKey } from './api';

let registration: Promise<ServiceWorkerRegistration | null> = Promise.resolve(null);

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  registration = navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => null);
}

export function alertsSupported(): boolean {
  return typeof Notification !== 'undefined';
}

export function alertsEnabled(): boolean {
  return alertsSupported() && Notification.permission === 'granted';
}

// iPhones only allow notifications once the site is added to the home screen.
export function needsHomeScreen(): boolean {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  return ios && !standalone && !alertsSupported();
}

export async function enableAlerts(): Promise<boolean> {
  if (!alertsSupported()) return false;
  try {
    if ((await Notification.requestPermission()) !== 'granted') return false;
  } catch {
    return false;
  }
  await subscribeToPush();
  return true;
}

// Make sure this browser's push subscription is saved for the signed-in
// player. Safe to call on every visit once notifications are allowed.
// Returns what went wrong, or null when it worked.
export async function subscribeToPush(): Promise<string | null> {
  try {
    const reg = await registration;
    if (!reg || !('PushManager' in window)) return "this browser can't receive push notifications";
    if (!alertsEnabled()) return 'notifications are blocked for this site in the browser settings';
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(await vapidPublicKey()),
      });
    }
    await savePushSubscription(sub.toJSON());
    return null;
  } catch (e) {
    console.warn('Push notifications unavailable', e);
    const message = (e as Error)?.message || String(e);
    return /permission denied/i.test(message)
      ? 'the browser refused to set up push. Check notifications are allowed for this browser in your system settings'
      : message;
  }
}

// For when the page is open but in the background. Uses the same tag as the
// push for this campaign, so the two replace each other instead of stacking.
export async function notify(title: string, body: string, tag: string) {
  if (!alertsEnabled() || document.visibilityState === 'visible') return;
  try {
    const reg = await registration;
    if (reg) await reg.showNotification(title, { body, tag, icon: 'icon-192.png' });
    else new Notification(title, { body, tag });
  } catch {
    // Some browsers refuse; the tab title still says it's your turn.
  }
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
