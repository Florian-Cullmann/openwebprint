// Appearance preferences are optional; React state remains usable without storage.
export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Keep the current tab's in-memory choice when persistence is unavailable.
  }
}
