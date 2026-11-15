#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { createServer } from "./server/server.js";
import { defaultDataDir, defaultUiDir } from "./paths.js";
import type { HostMessage, ReadyMessage } from "./host.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" },
    "data-dir": { type: "string" },
    "ui-dir": { type: "string" },
    "core-dir": { type: "string" },
  },
});

if (positionals[0] !== "start") {
  console.error("Usage: theterminal start [--port N] [--data-dir PATH] [--ui-dir PATH] [--core-dir ABSOLUTE_PATH]");
  process.exit(1);
}

let port: number | undefined;
if (values.port !== undefined) {
  port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid --port: ${values.port}`);
    process.exit(1);
  }
}

const coreDir = values["core-dir"];
if (coreDir !== undefined && !isAbsolute(coreDir)) {
  console.error("Invalid --core-dir: must be an absolute path");
  process.exit(1);
}

let running: Awaited<ReturnType<typeof createServer>>;
try {
  running = await createServer({
    dataDir: values["data-dir"] ?? defaultDataDir(),
    port,
    uiDir: values["ui-dir"] ?? defaultUiDir(),
    coreDir,
  });
} catch (err) {
  console.error(`The Terminal could not start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  running.close().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (process.send) {
  // Supervised by a host: the bootstrap URL (it carries the token) goes over IPC only, never to the log.
  console.log(`The Terminal is running at ${running.loopbackUrl}`);
  const ready: ReadyMessage = { type: "ready", url: running.url, loopbackUrl: running.loopbackUrl, port: running.port };
  process.send(ready);
  process.on("message", (message: unknown) => {
    if ((message as Partial<HostMessage> | null)?.type === "shutdown") shutdown();
  });
  process.on("disconnect", shutdown);
} else {
  console.log(`The Terminal is running at ${running.url}`);
}
