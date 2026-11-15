#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { createServer, type RunningServer } from "./server/server.js";
import { releaseDataDirLock } from "./server/data-dir-lock.js";
import { defaultDataDir, defaultUiDir } from "./paths.js";
import { USAGE, createShutdown, failAndExit, startErrorLine, writeStartLog } from "./cli-support.js";
import type { HostMessage, ReadyMessage } from "./host.js";

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        port: { type: "string" },
        "data-dir": { type: "string" },
        "ui-dir": { type: "string" },
        "core-dir": { type: "string" },
      },
    });
  } catch {
    return failAndExit(USAGE);
  }
  const { values, positionals } = parsed;

  if (positionals[0] !== "start") return failAndExit(USAGE);

  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return failAndExit(`Invalid --port: ${values.port}`);
  }

  const coreDir = values["core-dir"];
  if (coreDir !== undefined && !isAbsolute(coreDir)) return failAndExit("Invalid --core-dir: must be an absolute path");

  const dataDir = values["data-dir"] ?? defaultDataDir();
  let running: RunningServer;
  try {
    running = await createServer({ dataDir, port, uiDir: values["ui-dir"] ?? defaultUiDir(), coreDir });
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
    console.log(`The Terminal is running at ${running.url}`);
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
