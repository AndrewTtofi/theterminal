#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createServer } from "./server/server.js";
import { defaultDataDir, defaultUiDir } from "./paths.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" },
    "data-dir": { type: "string" },
    "ui-dir": { type: "string" },
  },
});

if (positionals[0] !== "start") {
  console.error("Usage: theterminal start [--port N] [--data-dir PATH] [--ui-dir PATH]");
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

const running = await createServer({
  dataDir: values["data-dir"] ?? defaultDataDir(),
  port,
  uiDir: values["ui-dir"] ?? defaultUiDir(),
});
console.log(`The Terminal is running at ${running.url}`);

const shutdown = () => {
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
