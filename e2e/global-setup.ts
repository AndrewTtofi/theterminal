import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretStore, createServer, fakeDiscovery } from "../packages/core/dist/index.js";

const fixture = (name: string) => join(import.meta.dirname, "..", "packages", "core", "test", "fixtures", name);

// A read inside the worktree (auto-allowed), a message, a shell command (asks; once allowed, its output is the bare
// Claude test key that connections.spec.ts stores, which no built-in redaction pattern matches, and it writes
// notes.txt holding that key into the working copy, so a run has one untracked file to show in Changes), a message,
// an edit outside it (auto-denied). The first message is what the Needs-you tab shows as said before the decision.
const FAKE_SCRIPT = JSON.stringify([
  { propose: { tool: "Read", kind: "file_read", summary: "Read README.md", input: { path: "README.md" }, paths: ["README.md"] } },
  { message: "I read README.md. Next I check the GPU." },
  {
    propose: { tool: "Bash", kind: "shell", summary: "Run: nvidia-smi", input: { command: "nvidia-smi" }, paths: [] },
    result: { ok: true, output: "zq-TESTKEY-e2e-opaque-0000000000" },
    write: { path: "notes.txt", content: "key=zq-TESTKEY-e2e-opaque-0000000000\nhello\n" },
  },
  { message: "I wrote notes.txt." },
  { propose: { tool: "Edit", kind: "file_edit", summary: "Edit /etc/hosts", input: { path: "/etc/hosts" }, paths: ["/etc/hosts"] } },
  // Only in a run given AWS credentials (cloud.spec.ts), so the other flows are unchanged: a shell command that asks,
  // then prints the bare minted session token (never stored, and no redaction pattern matches it) and the Azure secret.
  {
    whenEnv: "AWS_SESSION_TOKEN",
    propose: { tool: "Bash", kind: "shell", summary: "Run: printenv", input: { command: "printenv" }, paths: [] },
    result: { ok: true, output: "{{AWS_SESSION_TOKEN}}\nenv=AZURE_CLIENT_SECRET={{AZURE_CLIENT_SECRET}}" },
  },
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
  // Capacity: a fixed fake machine instead of this computer's hardware.
  THETERMINAL_FAKE_HARDWARE: "1",
};
// Read at every run start (the API keys) or by the fake CLIs, which inherit the server's env: kept until teardown.
// The fake OPENAI_API_KEY/GEMINI_API_KEY therefore stay in the Playwright main process env for the whole run.
// THETERMINAL_FAKE_LOG is added in globalSetup, once the agent data dir exists.
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
    // Both servers: secrets in memory (the link identity is never written to the real keychain), the in-process
    // discovery (no multicast), and a loopback link listener on a free port should a test enable linking.
    const linkOpts = () => ({ secrets: new MemorySecretStore(), discovery: fakeDiscovery(), linkBind: "127.0.0.1", linkPort: 0 });
    const board = await createServer({ dataDir: dirs[0]!, port: 47000, uiDir, ...linkOpts() });
    servers.push(board);
    process.env.TT_E2E_URL = board.url;

    // The fake CLIs append every message they receive (and the env they started with) here; read by cloud.spec.ts.
    const fakeLog = join(dirs[1]!, "fake-cli.log");
    restoreRunEnv = setEnv({ ...DURING_RUNS, THETERMINAL_FAKE_LOG: fakeLog });
    process.env.TT_E2E_FAKE_LOG = fakeLog;
    const restoreCreateEnv = setEnv(AT_CREATE);
    try {
      const agent = await createServer({ dataDir: dirs[1]!, port: 47100, uiDir, ...linkOpts() });
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
