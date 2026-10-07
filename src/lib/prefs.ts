// Remembered display name. Storage can be unavailable (private mode), so fail quietly.
const KEY = 'friendslop:name';

export function savedName(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveName(name: string) {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    // ignore
  }
}
