import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../packages/core/dist/index.js";

// Starts the core server (serving the built UI) for the whole run and exposes its url to the tests.
export default async function globalSetup() {
  const dataDir = mkdtempSync(join(tmpdir(), "tt-e2e-"));
  const uiDir = join(import.meta.dirname, "..", "apps", "ui", "dist");
  const server = await createServer({ dataDir, port: 47000, uiDir });
  process.env.TT_E2E_URL = server.url;
  return async () => {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
}
