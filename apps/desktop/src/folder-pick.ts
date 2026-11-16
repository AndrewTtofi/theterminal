import { isAbsolute } from "node:path";

const MAX_PATH = 4096;

/** A path the server child accepts: a string of 1–4096 characters, absolute by `node:path`. */
export function isPickablePath(p: unknown): p is string {
  return typeof p === "string" && p.length >= 1 && p.length <= MAX_PATH && isAbsolute(p);
}

/** The folder chosen in `dialog.showOpenDialog`, or null when it was canceled or gave no usable absolute path. */
export function pickedPath(result: { canceled: boolean; filePaths: string[] }): string | null {
  if (result.canceled) return null;
  const first = result.filePaths[0];
  return isPickablePath(first) ? first : null;
}
