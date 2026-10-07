// Browser notifications for "your turn" and nudges. Everything here is
// best-effort: unsupported or denied simply means no system notification.

export function alertsSupported(): boolean {
  return typeof Notification !== 'undefined';
}

export function alertsEnabled(): boolean {
  return alertsSupported() && Notification.permission === 'granted';
}

export async function enableAlerts(): Promise<boolean> {
  if (!alertsSupported()) return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

// Only pops a system notification when the tab isn't in front.
export function notify(title: string, body: string) {
  if (!alertsEnabled() || document.visibilityState === 'visible') return;
  try {
    new Notification(title, { body, tag: 'friendslop-turn' });
  } catch {
    // Some mobile browsers only allow notifications from a service worker.
  }
}
