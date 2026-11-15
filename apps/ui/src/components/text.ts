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
