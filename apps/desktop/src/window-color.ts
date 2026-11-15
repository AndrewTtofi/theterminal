import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** Ice's background: the window colour before any theme has been seen. */
export const DEFAULT_WINDOW_COLOR = "#0d1016";

/** A plain `#rgb` or `#rrggbb` (trimmed, lowercased), or null. Nothing else ever reaches the window. */
export function parseWindowColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(t) ? t : null;
}

/** The saved window colour, or Ice's background on a missing file, corrupt JSON or an invalid colour. */
export function loadWindowColor(file: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const c = typeof parsed === "object" && parsed !== null ? parseWindowColor((parsed as Record<string, unknown>).backgroundColor) : null;
    return c ?? DEFAULT_WINDOW_COLOR;
  } catch {
    return DEFAULT_WINDOW_COLOR;
  }
}

/** Saves the colour atomically (temp file, then rename). An invalid colour is ignored. */
export function saveWindowColor(file: string, c: string): void {
  const color = parseWindowColor(c);
  if (!color) return;
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify({ backgroundColor: color }), { flag: "wx", mode: 0o600 });
  renameSync(tmp, file);
}
