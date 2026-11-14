/** Where the dock layout lives in localStorage. Bump the version when saved layouts stop being compatible. */
export const LAYOUT_KEY = "tt.layout.v1";

// Storage can be unavailable (private windows, blocked site data); the layout is a convenience, so fail quietly.
export function saveLayout(json: unknown, key = LAYOUT_KEY): void {
  try {
    localStorage.setItem(key, JSON.stringify(json));
  } catch {
    // keep working with the in-memory layout
  }
}

/** The saved layout, or null when there is none or it is not valid JSON. */
export function loadLayout(key = LAYOUT_KEY): unknown | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function resetLayout(key = LAYOUT_KEY): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // nothing saved that we could reach
  }
}
