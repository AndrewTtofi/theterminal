import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

/** Where The Terminal keeps its ledger and token unless told otherwise. */
export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    const appData = env.APPDATA ?? win32.join(env.USERPROFILE ?? homedir(), "AppData", "Roaming");
    return win32.join(appData, "TheTerminal");
  }
  const home = env.HOME ?? homedir();
  if (platform === "darwin") return `${home}/Library/Application Support/TheTerminal`;
  return `${home}/.local/share/theterminal`;
}

/** The built UI (apps/ui/dist) next to this package, or undefined if it has not been built. */
export function defaultUiDir(moduleUrl: string = import.meta.url): string | undefined {
  // <root>/packages/core/{src|dist}/<file> -> <root>/apps/ui/dist
  const dir = join(dirname(fileURLToPath(moduleUrl)), "..", "..", "..", "apps", "ui", "dist");
  return existsSync(join(dir, "index.html")) ? dir : undefined;
}
