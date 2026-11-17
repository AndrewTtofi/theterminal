import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretStore, createServer, fakeDiscovery } from "../packages/core/dist/index.js";
import { HOME_APP_TEXT } from "./support.js";

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

// The collaboration servers' fake agent (people.spec.ts, remote.spec.ts): the same read and shell steps, but nothing
// a collaborator reads holds a test key, so their leak watchers can refuse any "TESTKEY" at all. Only in a run given
// the Azure connection, a second shell step prints that secret, which the run's redaction must hide.
const COLLAB_SCRIPT = JSON.stringify([
  { propose: { tool: "Read", kind: "file_read", summary: "Read README.md", input: { path: "README.md" }, paths: ["README.md"] } },
  {
    propose: { tool: "Bash", kind: "shell", summary: "Run: nvidia-smi", input: { command: "nvidia-smi" }, paths: [] },
    result: { ok: true, output: "(fake) one GPU" },
    write: { path: "notes.txt", content: "shared notes\nhello\n" },
  },
  {
    whenEnv: "AZURE_CLIENT_SECRET",
    propose: { tool: "Bash", kind: "shell", summary: "Run: printenv", input: { command: "printenv" }, paths: [] },
    result: { ok: true, output: "env=AZURE_CLIENT_SECRET={{AZURE_CLIENT_SECRET}}" },
  },
  { message: "I wrote notes.txt." },
]);

// The Home server's fake agent (home.spec.ts, sources.spec.ts): a plan of three steps, step 1 done, then step 2
// ("Change") writes src/app.txt once allowed, step 3 ("Check") runs a command that asks too, so the 67% between the
// two decisions stays on screen until the second one. Each marker is a line of its own, as STEP_PLAN_INSTRUCTION asks.
const HOME_SCRIPT = JSON.stringify([
  { message: "I will work in three steps.\n[[plan: Read | Change | Check]]" },
  { message: "[[step 1/3 started]]" },
  { message: "[[step 1/3 done]]" },
  { message: "[[step 2/3 started]]" },
  {
    propose: { tool: "Write", kind: "file_write", summary: "Write src/app.txt", input: { path: "src/app.txt" }, paths: ["src/app.txt"] },
    result: { ok: true, output: "wrote src/app.txt" },
    write: { path: "src/app.txt", content: HOME_APP_TEXT },
  },
  { message: "[[step 2/3 done]]" },
  { message: "[[step 3/3 started]]" },
  {
    propose: { tool: "Bash", kind: "shell", summary: "Run: npm test", input: { command: "npm test" }, paths: [] },
    result: { ok: true, output: "(fake) tests passed" },
  },
  { message: "I changed src/app.txt." },
]);

// The site server's fake agent (preview.spec.ts, agent-board.spec.ts), for projects imported from e2e/fixtures/site/:
// messages only. A plan of two steps, a card for the job, a website it offers to preview, a move of its card to Design
// (held by the "Plan approved" gate while the intake is not complete), step 1 done, then "[[noted]]": the first run on
// a card has no notes, so it changes nothing; a later run on the card reads the notes it was given.
const SITE_SCRIPT = JSON.stringify([
  { message: "[[plan: Build | Check]]" },
  { message: "[[card: Contact form]]" },
  { message: "[[preview: npm run dev | port 5173]]" },
  { message: "[[card-stage: design]]" },
  { message: "[[step 1/2 done]]" },
  { message: "[[noted]]" },
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

/** Whether a URL's host is this computer, which needs no internet. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const isLocalHost = (host: string) => LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");

/**
 * The peer's fetch: a computer with no internet. A loopback URL answers like a model server holding fake-coder:7b (and
 * 404 for anything else); every other URL fails the way undici does when the name does not resolve. Nothing leaves.
 */
const offlineFetch: typeof fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!isLocalHost(url.hostname)) {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${url.hostname}`), { code: "ENOTFOUND", hostname: url.hostname }),
    });
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.pathname.replace(/\/+$/, "").endsWith("/v1/models")) return json(200, { object: "list", data: [{ id: "fake-coder:7b", object: "model" }] });
  return json(404, {});
};

// Starts seven core servers (serving the built UI) for the whole run and exposes their urls to the tests:
// TT_E2E_URL for the board flow, TT_E2E_AGENT_URL for the agent flow (its own data, with the fake agent enabled),
// TT_E2E_PEER_URL for a second agent computer with no internet, which link.spec.ts pairs with the agent server and
// offline.spec.ts uses offline, and two collaboration servers with the fake agent: TT_E2E_PEOPLE_URL (remote access
// off, people.spec.ts) and TT_E2E_REMOTE_OWNER_URL (remote.spec.ts), whose remote TLS listener is on from the start at
// TT_E2E_REMOTE_URL with the self-signed certificate TT_E2E_FINGERPRINT, and TT_E2E_HOME_URL, the fake agent with
// step reports (home.spec.ts, sources.spec.ts), whose Home counts no other spec's runs or decisions, and
// TT_E2E_SITE_URL, the fake agent of SITE_SCRIPT for the website fixture (preview.spec.ts, agent-board.spec.ts). Each
// spec gets a workspace of its own, so the people it invites, removes and re-roles, and remote access going off, touch
// no other spec.
type Server = Awaited<ReturnType<typeof createServer>>;

export default async function globalSetup() {
  const uiDir = join(import.meta.dirname, "..", "apps", "ui", "dist");
  const dirs = ["tt-e2e-", "tt-e2e-agent-", "tt-e2e-peer-", "tt-e2e-people-", "tt-e2e-remote-", "tt-e2e-home-", "tt-e2e-site-"].map((p) => mkdtempSync(join(tmpdir(), p)));
  const servers: Server[] = [];
  let restoreRunEnv = () => {};
  const teardown = async () => {
    await Promise.allSettled(servers.map((s) => s.close()));
    restoreRunEnv();
    // SQLite WAL handles can linger briefly on Windows.
    for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  try {
    // Every server: secrets in memory (the link identity is never written to the real keychain), the in-process
    // discovery (no multicast), a loopback link listener on a free port should a test enable linking, and share
    // links on an ephemeral port, so a run never needs (or holds) the default one.
    const linkOpts = () => ({ secrets: new MemorySecretStore(), discovery: fakeDiscovery(), linkBind: "127.0.0.1", linkPort: 0, sharePort: 0 });
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
      // The peer: the same fake agent and CLIs, its own data, any free port, and no internet (offlineFetch).
      const peer = await createServer({ dataDir: dirs[2]!, port: 0, uiDir, ...linkOpts(), fetch: offlineFetch });
      servers.push(peer);
      process.env.TT_E2E_PEER_URL = peer.url;

      const restoreCollabEnv = setEnv({ THETERMINAL_FAKE_SCRIPT: COLLAB_SCRIPT });
      try {
        const people = await createServer({ dataDir: dirs[3]!, port: 0, uiDir, ...linkOpts() });
        servers.push(people);
        process.env.TT_E2E_PEOPLE_URL = people.url;
        // Remote access on at start, as the CLI's --remote does (the system actor, so no Owner credential is needed
        // yet): loopback only, and port 0, which picks a free port once and records it, so turning remote access on
        // again from the People view listens on the same address. The Owner bootstrap link it issues is not printed.
        const remote = await createServer({
          dataDir: dirs[4]!, port: 0, uiDir, ...linkOpts(),
          remote: { enabled: true, port: 0, bind: "127.0.0.1" },
          bootstrapInvite: () => {},
        });
        servers.push(remote);
        process.env.TT_E2E_REMOTE_OWNER_URL = remote.url;
        if (remote.remoteUrl === null || remote.fingerprint === null) throw new Error("the remote listener did not start");
        process.env.TT_E2E_REMOTE_URL = remote.remoteUrl;
        process.env.TT_E2E_FINGERPRINT = remote.fingerprint;
      } finally {
        restoreCollabEnv();
      }

      const restoreHomeEnv = setEnv({ THETERMINAL_FAKE_SCRIPT: HOME_SCRIPT });
      try {
        const home = await createServer({ dataDir: dirs[5]!, port: 0, uiDir, ...linkOpts() });
        servers.push(home);
        process.env.TT_E2E_HOME_URL = home.url;
      } finally {
        restoreHomeEnv();
      }

      const restoreSiteEnv = setEnv({ THETERMINAL_FAKE_SCRIPT: SITE_SCRIPT });
      try {
        const site = await createServer({ dataDir: dirs[6]!, port: 0, uiDir, ...linkOpts() });
        servers.push(site);
        process.env.TT_E2E_SITE_URL = site.url;
      } finally {
        restoreSiteEnv();
      }
    } finally {
      restoreCreateEnv();
    }
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
