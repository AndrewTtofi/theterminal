/**
 * Terminal escape sequences: CSI (`ESC [`, parameter and intermediate bytes, one final byte) and OSC (`ESC ]` up to
 * BEL or the string terminator `ESC \`). Written with escapes so the source holds no raw control characters.
 */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Removes CSI and OSC escape sequences, so terminal output reads as plain text. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** The last segment of a `/`-separated path, ignoring a trailing slash. */
export function basename(path: string): string {
  const parts = path.split("/").filter((p) => p !== "");
  return parts[parts.length - 1] ?? path;
}

/** `s` cut to `max` characters with `…` when longer; by code point, so a character of two UTF-16 units is never split. */
export function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : s;
}

/** `v` with `stripAnsi` applied to every string inside it, at any depth; other values are kept. */
export function stripAnsiDeep(v: unknown): unknown {
  if (typeof v === "string") return stripAnsi(v);
  if (Array.isArray(v)) return v.map(stripAnsiDeep);
  if (typeof v !== "object" || v === null) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripAnsiDeep(x)]));
}
