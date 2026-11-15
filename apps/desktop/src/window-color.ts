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

export interface ColorRecorder {
  /** Reads the colour and saves it when valid and different from the last saved one. Never throws. */
  record(): Promise<void>;
}

/** Remembers a colour at most once per change: a failed read, an invalid value or an unchanged colour writes nothing. */
export function createColorRecorder(opts: { read: () => Promise<unknown>; save: (c: string) => void; initial?: string | null }): ColorRecorder {
  let last: string | null = opts.initial ?? null;
  let busy = false;
  return {
    async record() {
      if (busy) return;
      busy = true;
      try {
        const c = parseWindowColor(await opts.read());
        if (c && c !== last) {
          opts.save(c);
          last = c;
        }
      } catch {
        // keep the old colour
      } finally {
        busy = false;
      }
    },
  };
}
