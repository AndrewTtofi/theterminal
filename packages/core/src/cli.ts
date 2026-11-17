#!/usr/bin/env node
import { createServer, type RunningServer } from "./server/server.js";
import { releaseDataDirLock } from "./server/data-dir-lock.js";
import { defaultDataDir, defaultUiDir } from "./paths.js";
import { createShutdown, failAndExit, parseStartArgs, startErrorLine, writeStartLog } from "./cli-support.js";
import { BOOTSTRAP_LINE } from "./server/bootstrap-invite.js";
import { createFolderPicker } from "./server/folder-picker.js";
import { createPreviewHost } from "./server/preview-host.js";
import type { ChildMessage, HostMessage, ReadyMessage } from "./host.js";

async function main(): Promise<void> {
  const parsed = parseStartArgs(process.argv.slice(2), { dataDir: defaultDataDir, uiDir: defaultUiDir });
  if (!parsed.ok) return failAndExit(parsed.message);
  const options = parsed.options;
  const dataDir = options.dataDir;

  // Under a host (the desktop app) the folder picker is its native dialog and the preview views are its own views,
  // both asked for over the IPC channel. Each ignores the other's answers.
  const send = process.send?.bind(process);
  const hostIo = send
    ? {
        // A closed channel reports through the callback, not as an uncaught error; `disconnect` shuts the server down.
        send: (m: ChildMessage) => void send(m, undefined, undefined, () => {}),
        on: (listener: (message: unknown) => void) => void process.on("message", listener),
      }
    : undefined;
  const pickFolder = hostIo ? createFolderPicker(hostIo) : undefined;
  const previewHost = hostIo ? createPreviewHost(hostIo) : undefined;

  let running: RunningServer;
  try {
    running = await createServer({
      ...options,
      pickFolder,
      previewHost,
      // The invite link is the only secret this process ever prints, once per start, until the Owner claims it.
      bootstrapInvite: (url) => console.log(`${BOOTSTRAP_LINE} ${url}`),
    });
  } catch (err) {
    writeStartLog(dataDir, err);
    return failAndExit(startErrorLine(err));
  }

  const shutdown = createShutdown({
    close: () => running.close(),
    releaseLock: () => releaseDataDirLock(dataDir),
    exit: (code) => process.exit(code),
    fail: failAndExit,
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (!process.send) {
    // With remote access on, whether by the flag or by the recorded state at a restart, stdout is a container or
    // service log others may read: no token there. Locally it is the Owner's own terminal, and the link with the
    // token is how they open the workspace.
    const headless = options.remote || running.remoteUrl !== null;
    console.log(`The Terminal is running at ${headless ? running.loopbackUrl : running.url}`);
    return;
  }
  // Supervised by a host: the bootstrap URL (it carries the token) goes over IPC only, never to the log. The listeners
  // come first, so a host that is already gone, or goes while ready is in flight, still shuts the server down.
  process.on("message", (message: unknown) => {
    if ((message as Partial<HostMessage> | null)?.type === "shutdown") shutdown();
  });
  process.on("disconnect", shutdown);
  console.log(`The Terminal is running at ${running.loopbackUrl}`);
  if (!process.connected) return shutdown();
  const ready: ReadyMessage = { type: "ready", url: running.url, loopbackUrl: running.loopbackUrl, port: running.port };
  process.send(ready, undefined, undefined, (err) => {
    if (err) shutdown();
  });
}

await main();
