import { renameSync, rmSync, writeFileSync } from "node:fs";
import type { ReadyMessage } from "@theterminal/core/dist/host.js";

/**
 * The headless ready file: `{"loopbackUrl", "port"}`, never the token. Written to a fresh temp file (`wx`, 0600,
 * after removing a stale one) and renamed into place, so a reader never sees half a file.
 */
export function writeReadyFile(file: string, ready: ReadyMessage, pid: number = process.pid): void {
  const tmp = `${file}.${pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify({ loopbackUrl: ready.loopbackUrl, port: ready.port }), { flag: "wx", mode: 0o600 });
  renameSync(tmp, file);
}
