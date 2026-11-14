import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../packages/core/dist/index.js";

// A read inside the worktree (auto-allowed), a shell command (asks), an edit outside it (auto-denied).
const FAKE_SCRIPT = JSON.stringify([
  { propose: { tool: "Read", kind: "file_read", summary: "Read README.md", input: { path: "README.md" }, paths: ["README.md"] } },
  { propose: { tool: "Bash", kind: "shell", summary: "Run: nvidia-smi", input: { command: "nvidia-smi" }, paths: [] } },
  { propose: { tool: "Edit", kind: "file_edit", summary: "Edit /etc/hosts", input: { path: "/etc/hosts" }, paths: ["/etc/hosts"] } },
]);

// Starts two core servers (serving the built UI) for the whole run and exposes their urls to the tests:
// TT_E2E_URL for the board flow, TT_E2E_AGENT_URL for the agent flow (its own data, with the fake agent enabled).
export default async function globalSetup() {
  const uiDir = join(import.meta.dirname, "..", "apps", "ui", "dist");
  const dirs = [mkdtempSync(join(tmpdir(), "tt-e2e-")), mkdtempSync(join(tmpdir(), "tt-e2e-agent-"))];

  const board = await createServer({ dataDir: dirs[0]!, port: 47000, uiDir });
  process.env.TT_E2E_URL = board.url;

  // The fake adapter reads these at createServer time, so set them only around that call.
  const previous = { agent: process.env.THETERMINAL_FAKE_AGENT, script: process.env.THETERMINAL_FAKE_SCRIPT };
  process.env.THETERMINAL_FAKE_AGENT = "1";
  process.env.THETERMINAL_FAKE_SCRIPT = FAKE_SCRIPT;
  let agent;
  try {
    agent = await createServer({ dataDir: dirs[1]!, port: 47100, uiDir });
  } finally {
    for (const [k, v] of [["THETERMINAL_FAKE_AGENT", previous.agent], ["THETERMINAL_FAKE_SCRIPT", previous.script]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  process.env.TT_E2E_AGENT_URL = agent.url;

  return async () => {
    await board.close();
    await agent.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  };
}
