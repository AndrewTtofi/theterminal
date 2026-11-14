import { homedir } from "node:os";
import { join, win32 } from "node:path";

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
