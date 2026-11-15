import { posix, win32 } from "node:path";

/**
 * The packaged app's resources folder for the executable under test (`TT_DESKTOP_APP`): `Contents/Resources` in a
 * macOS bundle, `resources` beside the executable on Windows. Core, Node and the UI live there.
 */
export function resourcesDir(exe: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return win32.join(win32.dirname(exe), "resources");
  return posix.join(exe, "..", "..", "Resources");
}
