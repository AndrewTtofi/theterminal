import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../packages/core/dist/index.js";

const fixture = (name: string) => join(import.meta.dirname, "..", "packages", "core", "test", "fixtures", name);

// A read inside the worktree (auto-allowed), a shell command (asks; once allowed, its output holds the Claude test key
// that connections.spec.ts stores), an edit outside it (auto-denied).
const FAKE_SCRIPT = JSON.stringify([
  { propose: { tool: "Read", kind: "file_read", summary: "Read README.md", input: { path: "README.md" }, paths: ["README.md"] } },
  {
    propose: { tool: "Bash", kind: "shell", summary: "Run: nvidia-smi", input: { command: "nvidia-smi" }, paths: [] },
    result: { ok: true, output: "key=sk-ant-TESTKEY-e2e-00000000000000" },
  },
  { propose: { tool: "Edit", kind: "file_edit", summary: "Edit /etc/hosts", input: { path: "/etc/hosts" }, paths: ["/etc/hosts"] } },
]);

// Codex: one command that asks; then a closing message.
const FAKE_CODEX_SCRIPT = JSON.stringify([
  { approve: "command", command: "npm test", itemId: "cmd-1", output: "(fake) tests passed" },
  { message: "Tests pass." },
]);
// Gemini: a read outside the worktree (auto-denied), then a write that asks first.
const FAKE_GEMINI_SCRIPT = JSON.stringify([
  { type: "read", path: "../outside" },
  { type: "write", path: "notes.txt", content: "draft", permission: true },
  { type: "message", text: "Done." },
]);

// Read once, when the agent server is created: the fake adapter and the provider CLI overrides.
const AT_CREATE = {
  THETERMINAL_FAKE_AGENT: "1",
  THETERMINAL_FAKE_SCRIPT: FAKE_SCRIPT,
  THETERMINAL_CODEX_BIN: fixture("fake-codex.mjs"),
  THETERMINAL_GEMINI_BIN: fixture("fake-gemini.mjs"),
  // Connections: secrets in memory (never the real keychain) and connection tests answered without network I/O.
  THETERMINAL_SECRET_STORE: "memory",
  THETERMINAL_FAKE_HTTP: "1",
};
// Read at every run start (the API keys) or by the fake CLIs, which inherit the server's env: kept until teardown.
// The fake OPENAI_API_KEY/GEMINI_API_KEY therefore stay in the Playwright main process env for the whole run.
const DURING_RUNS = {
  THETERMINAL_FAKE_CODEX_SCRIPT: FAKE_CODEX_SCRIPT,
  THETERMINAL_FAKE_GEMINI_SCRIPT: FAKE_GEMINI_SCRIPT,
  OPENAI_API_KEY: "sk-TESTKEY-openai-e2e-000000000000",
  GEMINI_API_KEY: "AIza-TESTKEY-gemini-e2e-0000000000",
};

/** Sets the given env vars and returns a function that restores their previous values. */
function setEnv(vars: Record<string, string>): () => void {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return () => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// Starts two core servers (serving the built UI) for the whole run and exposes their urls to the tests:
// TT_E2E_URL for the board flow, TT_E2E_AGENT_URL for the agent flow (its own data, with the fake agent enabled).
type Server = Awaited<ReturnType<typeof createServer>>;

export default async function globalSetup() {
  const uiDir = join(import.meta.dirname, "..", "apps", "ui", "dist");
  const dirs = [mkdtempSync(join(tmpdir(), "tt-e2e-")), mkdtempSync(join(tmpdir(), "tt-e2e-agent-"))];
  const servers: Server[] = [];
  let restoreRunEnv = () => {};
  const teardown = async () => {
    await Promise.allSettled(servers.map((s) => s.close()));
    restoreRunEnv();
    // SQLite WAL handles can linger briefly on Windows.
    for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  try {
    const board = await createServer({ dataDir: dirs[0]!, port: 47000, uiDir });
    servers.push(board);
    process.env.TT_E2E_URL = board.url;

    restoreRunEnv = setEnv(DURING_RUNS);
    const restoreCreateEnv = setEnv(AT_CREATE);
    try {
      const agent = await createServer({ dataDir: dirs[1]!, port: 47100, uiDir });
      servers.push(agent);
      process.env.TT_E2E_AGENT_URL = agent.url;
    } finally {
      restoreCreateEnv();
    }
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
