import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent, AdapterStartOptions, GateResult, ProposedAction } from "../../src/agents/adapter.js";
import { ApprovalBroker } from "../../src/agents/approvals.js";
import { CHILD_ENV_ALLOWLIST, fakeAgentEnv } from "../../src/agents/child-env.js";
import { GeminiAdapter } from "../../src/agents/gemini/adapter.js";
import { classify } from "../../src/agents/policy.js";
import { redact } from "../../src/agents/redact.js";
import { AgentRunner } from "../../src/agents/runner.js";
import { WorktreeManager, EMPTY_GITCONFIG } from "../../src/agents/worktrees.js";
import { BoardService } from "../../src/board/board-service.js";
import { openDatabase } from "../../src/db.js";
import { getRun, listActions, listPendingActions } from "../../src/events/projections.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { GeminiAdapter as IndexGeminiAdapter } from "../../src/index.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-gemini.mjs");
const FAKE_KEY = "AIzaFAKEKEY0123456789abcdefghijklmnopqrst";
const SECRET = "sk-ant-TESTKEY0123456789abcdef";
/** A stored secret no pattern matches: only the run's live secrets redact it. */
const STORED = "stored-conn-value-0123456789";
/** Opaque values no token pattern matches: only the context before them (an auth scheme, a secret key) redacts them. */
const OPAQUE_TOKEN = "q7Rt2Lp9Xz4Kw8Vn3Bm6Hd1Fj5Gs0Ac2Ue7Yi4Oy";
const OPAQUE_VALUE = "zq0RS6kd83JWnB2yT5pe7MaV4cUx9hLf1Gt";
/** Private key body lines: each holds a run of "k" that no other text in these tests does. */
const keyBody = (lines: number) => Array.from({ length: lines }, (_, i) => `${String(i).padStart(4, "0")}${"k".repeat(60)}`);
const KEY_BEGIN = "-----BEGIN RSA PRIVATE KEY-----";
const KEY_END = "-----END RSA PRIVATE KEY-----";
const KEY_FRAGMENT = "kkkkkkkk";

/** `line` cut at `cut`, after padding that makes the first chunk reach the 4000-character size split. */
function straddle(line: string, cut: number): Step[] {
  const pad = "w ".repeat(Math.ceil((4000 - cut) / 2));
  return [{ type: "message", text: pad + line.slice(0, cut) }, { type: "message", text: `${line.slice(cut)} end` }];
}
/** `text` as message steps of `size` characters. */
const chunked = (text: string, size: number): Step[] =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) => ({ type: "message", text: text.slice(i * size, (i + 1) * size) }));
const streamed = (steps: Step[]) => steps.map((s) => s.text as string).join("");
function expectNoFragment(text: string, secret: string): void {
  for (let i = 0; i + 8 <= secret.length; i++) expect(text).not.toContain(secret.slice(i, i + 8));
}
const MiB = 1024 * 1024;
const ACP_ARGS = ["--acp", "--approval-mode", "default", "--extensions", "none", "--allowed-mcp-server-names", "theterminal-none"];
/** The per-run arguments: the policy directory varies, the allowlist name matches no tool. */
const RUN_ARGS = [...ACP_ARGS, "--policy", expect.stringMatching(/policies$/), "--allowed-tools", "theterminal-none"];
const CORE_TOOLS = ["read_file", "write_file", "replace", "run_shell_command"];
const POLICY_TOML =
  CORE_TOOLS.map((t) => `[[rule]]\ntoolName = "${t}"\ndecision = "ask_user"\npriority = 999\nargsPattern = ".*"\n`).join("\n") +
  `\n[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 998\n`;
/** The user-scope settings written into the isolated GEMINI_CLI_HOME in api_key mode. */
const HOME_SETTINGS = {
  security: { auth: { selectedType: "gemini-api-key" }, disableAlwaysAllow: true, folderTrust: { enabled: true } },
  tools: { core: CORE_TOOLS, discoveryCommand: "", callCommand: "", sandbox: false },
  mcp: { serverCommand: "" },
  hooksConfig: { enabled: false },
  advanced: { ignoreLocalEnv: true },
};

type Step = Record<string, unknown>;
type Script = Step[] | { config?: Record<string, unknown>; steps: Step[] };
type LogEntry = Record<string, any>;

let worktree: string;
let outside: string;
let logFile: string;
const saved: Record<string, string | undefined> = {};
const FAKE_ENV: Record<string, string> = {
  GOOGLE_API_KEY: "AIzaFAKEfromprocessenv00000000000000000000",
  GOOGLE_CLOUD_PROJECT: "fake-project",
  GEMINI_MODEL: "fake-model",
  GEMINI_API_KEY: "AIzaFAKEinheritedkey0000000000000000000000",
  VERTEXAI_LOCATION: "nowhere",
  GIT_DIR: "/nonexistent/fake.git",
  GIT_AUTHOR_EMAIL: "someone@example.com",
  ANTHROPIC_API_KEY: "sk-ant-TESTKEYotherprovider00000000",
  OPENAI_API_KEY: "sk-TESTKEYotherprovider0000000000000",
};

beforeEach(() => {
  // The native realpath expands Windows short names (RUNNER~1), as WorktreeManager.resolveInside does.
  worktree = realpathSync.native(mkdtempSync(join(tmpdir(), "gemini-wt-")));
  outside = realpathSync.native(mkdtempSync(join(tmpdir(), "gemini-outside-")));
  logFile = join(outside, "fake.log");
  writeFileSync(join(worktree, "README.md"), "hello from the worktree\n");
  for (const k of [...Object.keys(FAKE_ENV), "THETERMINAL_FAKE_GEMINI_SCRIPT", "THETERMINAL_FAKE_LOG", "THETERMINAL_FAKE_AGENT"]) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(FAKE_ENV)) process.env[k] = v;
  process.env.THETERMINAL_FAKE_LOG = logFile;
  process.env.THETERMINAL_FAKE_AGENT = "1"; // lets the fixture CLI receive its THETERMINAL_FAKE_* script variables
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(worktree, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** For tests that build the adapter before calling script(): filled in by script(), still a fixed object per adapter. */
const lateFake: NodeJS.ProcessEnv = {};
function script(s: Script): void {
  process.env.THETERMINAL_FAKE_GEMINI_SCRIPT = JSON.stringify(s);
  Object.assign(lateFake, fakeAgentEnv());
}
function readLog(): LogEntry[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as LogEntry);
}
const methodsCalled = () => readLog().filter((e) => typeof e.method === "string").map((e) => e.method as string);
const logged = (step: string) => readLog().filter((e) => e.step === step);

/** Policy as the runner applies it; `ask` decides what a human would say. */
function policyGate(ask: (a: ProposedAction) => GateResult = () => ({ decision: "allow", reason: "owner allowed" })) {
  const wt = new WorktreeManager(outside);
  return (a: ProposedAction): GateResult => {
    const v = classify(a, worktree, wt);
    if (v.verdict === "auto_allow") return { decision: "allow", reason: v.reason };
    if (v.verdict === "auto_deny") return { decision: "deny", reason: v.reason };
    return ask(a);
  };
}

function harness(decide: (a: ProposedAction) => GateResult | Promise<GateResult> = policyGate(), authMode: AdapterStartOptions["authMode"] = "api_key") {
  const proposed: ProposedAction[] = [];
  const decisions: (GateResult & { actionId: string })[] = [];
  const denied: [ProposedAction, string][] = [];
  const events: AdapterEvent[] = [];
  let n = 0;
  const abort = new AbortController();
  const opts: AdapterStartOptions = {
    cwd: worktree, projectId: "p1", prompt: "do it", authMode, signal: abort.signal,
    gate: async (a) => {
      proposed.push(a);
      const d = { ...(await decide(a)), actionId: `act-${++n}` };
      decisions.push(d);
      return d;
    },
    emit: (e) => events.push(e),
    recordDenied: async (a, reason) => {
      denied.push([a, reason]);
    },
    clean: (t) => t,
  };
  return { opts, proposed, decisions, denied, events, abort };
}

/** Spawns the fake through node and remembers the child, so a test can check it was killed. */
function fakeSpawn() {
  const children: ChildProcess[] = [];
  const spawn = ((file: string, args: string[], o: Record<string, unknown>) => {
    const child = nodeSpawn(file, args, o as never);
    children.push(child);
    return child;
  }) as typeof nodeSpawn;
  return { spawn, children };
}

function adapter(extra: { spawn?: typeof nodeSpawn; apiKey?: () => string | undefined; bin?: () => string | null } = {}) {
  return new GeminiAdapter({ dataDir: outside, command: { file: process.execPath, args: [FAKE] }, apiKey: () => FAKE_KEY, fakeEnv: fakeAgentEnv(), ...extra });
}

const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;
const waitExit = (c: ChildProcess) => vi.waitFor(() => expect(exited(c)).toBe(true), { timeout: 10_000 });

describe("GeminiAdapter", () => {
  it("is exported from the core index", () => {
    expect(IndexGeminiAdapter).toBe(GeminiAdapter);
  });

  it("starts gemini in ACP mode locked down, advertises fs and terminal, never authenticates, and completes", async () => {
    script([{ type: "message", text: "Hello " }, { type: "message", text: "there" }]);
    const h = harness();
    const r = await adapter().start(h.opts);
    expect(r).toEqual({ status: "completed" });
    expect(h.events).toEqual([{ type: "message", text: "Hello there" }]);
    expect(h.proposed).toEqual([]);

    expect(methodsCalled()).toEqual(["initialize", "session/new", "session/prompt"]);
    const init = readLog().find((e) => e.method === "initialize")!;
    expect(init.params.protocolVersion).toBe(1);
    expect(init.params.clientCapabilities).toEqual({ fs: { readTextFile: true, writeTextFile: true }, terminal: true });
    const snap = readLog().find((e) => e.initialize)!.initialize;
    expect(snap.cwd).toBe(worktree);
    expect(snap.argv).toEqual(RUN_ARGS);
    expect(snap.policies).toEqual({ "theterminal.toml": POLICY_TOML });
    expect(snap.env.NO_BROWSER).toBe("true");
    expect(snap.env.GEMINI_CLI_NO_RELAUNCH).toBe("1");
    expect(snap.env.GEMINI_CLI_TRUST_WORKSPACE).toBe("false"); // a repo-planted .gemini/settings.json or .env never merges in
    expect(snap.env).not.toHaveProperty("GEMINI_CLI_SYSTEM_SETTINGS_PATH");
    // api_key mode: an isolated, per-project home holds our user-scope settings; nothing of the user's ~/.gemini is read.
    const home = join(outside, "projects", "p1", "gemini-home");
    expect(snap.env.GEMINI_CLI_HOME).toBe(home);
    expect(snap.settings).toEqual(HOME_SETTINGS);
    expect(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"))).toEqual(HOME_SETTINGS);
    const session = readLog().find((e) => e.method === "session/new")!;
    expect(session.params).toEqual({ cwd: worktree, mcpServers: [] });
    const prompt = readLog().find((e) => e.method === "session/prompt")!;
    expect(prompt.params).toEqual({ sessionId: "fake-session", prompt: [{ type: "text", text: "do it" }] });
  });

  it("api_key mode passes only the configured key; inherited Gemini, Google, Vertex and git variables are stripped", async () => {
    script([]);
    await adapter().start(harness().opts);
    const env = readLog().find((e) => e.initialize)!.initialize.env as Record<string, string>;
    expect(env.GEMINI_API_KEY).toBe(FAKE_KEY);
    for (const k of ["GOOGLE_API_KEY", "GOOGLE_CLOUD_PROJECT", "GEMINI_MODEL", "VERTEXAI_LOCATION", "GIT_DIR", "GIT_AUTHOR_EMAIL"]) expect(env).not.toHaveProperty(k);
    expect(Object.keys(env).filter((k) => /^GIT_/i.test(k)).sort()).toEqual(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"]);
    expect(env.GIT_CONFIG_GLOBAL).toBe(join(outside, EMPTY_GITCONFIG));
    expect(process.env.GEMINI_API_KEY).toBe(FAKE_ENV.GEMINI_API_KEY); // a copy, not the real env
  });

  it("the child env is exactly the allowlist plus what we set; the fake flag is read at construction", async () => {
    process.env.AWS_SECRET_ACCESS_KEY = "aws-TESTSECRET";
    process.env.NPM_TOKEN = "npm-TESTTOKEN";
    process.env.NODE_OPTIONS = "--no-warnings";
    saved.AWS_SECRET_ACCESS_KEY = saved.NPM_TOKEN = saved.NODE_OPTIONS = undefined;
    script([]);
    const seen: NodeJS.ProcessEnv[] = [];
    const a = adapter({
      spawn: ((f: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
        seen.push(o.env);
        return nodeSpawn(f, args, o as never);
      }) as typeof nodeSpawn,
    });
    delete process.env.THETERMINAL_FAKE_AGENT; // unset after construction: the snapshot still carries the script
    expect(await a.start(harness().opts)).toEqual({ status: "completed" });
    const keys = Object.keys(seen[0]!);
    for (const k of ["AWS_SECRET_ACCESS_KEY", "NPM_TOKEN", "NODE_OPTIONS", "THETERMINAL_FAKE_AGENT", "GIT_DIR", "OPENAI_API_KEY"]) expect(keys).not.toContain(k);
    const allowed = new Set([
      ...CHILD_ENV_ALLOWLIST, "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "GEMINI_API_KEY", "GEMINI_CLI_HOME",
      "GEMINI_CLI_TRUST_WORKSPACE", "GEMINI_CLI_NO_RELAUNCH", "NO_BROWSER", "THETERMINAL_FAKE_GEMINI_SCRIPT", "THETERMINAL_FAKE_LOG",
    ]);
    expect(keys.filter((k) => !allowed.has(k) && !k.startsWith("LC_"))).toEqual([]);
    expect(keys).toContain("THETERMINAL_FAKE_GEMINI_SCRIPT");
  });

  it("google mode passes no API key, selects the Google login, and never calls authenticate", async () => {
    script([]);
    const apiKey = vi.fn(() => FAKE_KEY);
    const r = await adapter({ apiKey }).start(harness(policyGate(), "google").opts);
    expect(r).toEqual({ status: "completed" });
    expect(apiKey).not.toHaveBeenCalled();
    const snap = readLog().find((e) => e.initialize)!.initialize;
    expect(snap.env).not.toHaveProperty("GEMINI_API_KEY");
    expect(snap.env).not.toHaveProperty("GOOGLE_API_KEY");
    // The user's own home must stay in place for the login, so no isolated home and no settings of ours.
    expect(snap.env).not.toHaveProperty("GEMINI_CLI_HOME");
    expect(snap.env).not.toHaveProperty("GEMINI_CLI_SYSTEM_SETTINGS_PATH");
    expect(snap.env.GEMINI_CLI_TRUST_WORKSPACE).toBe("false"); // even a worktree the user trusts stays untrusted for this run
    expect(snap.settings).toBeNull();
    expect(existsSync(join(outside, "projects"))).toBe(false);
    expect(snap.argv).toEqual(RUN_ARGS);
    expect(snap.policies).toEqual({ "theterminal.toml": POLICY_TOML });
    expect(methodsCalled()).not.toContain("authenticate");
  });

  it("refuses a project id that is not a plain path segment before starting gemini", async () => {
    const { spawn, children } = fakeSpawn();
    for (const projectId of ["../p1", "a/b", "", "x".repeat(101)]) {
      expect(await adapter({ spawn }).start({ ...harness().opts, projectId })).toEqual({ status: "failed", error: "invalid projectId" });
    }
    expect(children).toEqual([]);
  });

  it("google mode reports a missing login when session/new fails", async () => {
    script({ config: { failAt: "session/new" }, steps: [] });
    const r = await adapter().start(harness(policyGate(), "google").opts);
    expect(r).toEqual({ status: "failed", error: "Gemini is not logged in; run 'gemini' once yourself" });
  });

  it("reports an early exit with the redacted stderr tail rather than a login problem", async () => {
    script({ config: { exitAt: "session/new" }, steps: [] });
    const r = await adapter().start(harness(policyGate(), "google").opts);
    expect(r).toEqual({ status: "failed", error: "Gemini exited unexpectedly: fake gemini: exiting at session/new" });
  });

  it("refuses a prompt that gemini would run as a slash or shell command, without starting it", async () => {
    const { spawn, children } = fakeSpawn();
    for (const prompt of ["/init", "  /extensions install x", "$ls", "\n$ rm -rf"]) {
      const r = await adapter({ spawn }).start({ ...harness().opts, prompt });
      expect(r).toEqual({ status: "failed", error: "Gemini treats a prompt starting with / or $ as a command; rephrase it" });
    }
    expect(children).toEqual([]);
  });

  it("api_key mode without a key fails with the exact message without starting gemini", async () => {
    script([]);
    const { spawn, children } = fakeSpawn();
    const r = await adapter({ spawn, apiKey: () => undefined }).start(harness().opts);
    expect(r).toEqual({ status: "failed", error: "No Gemini API key configured" });
    expect(children).toEqual([]);
  });

  it("fails without starting when there is no bundled Gemini CLI and none on PATH", async () => {
    const { spawn, children } = fakeSpawn();
    const r = await new GeminiAdapter({ dataDir: outside, bundled: () => null, bin: () => null, apiKey: () => FAKE_KEY, spawn }).start(harness().opts);
    expect(r).toEqual({ status: "failed", error: "Gemini CLI is unavailable: its bundled program is missing and none is on PATH" });
    expect(children).toEqual([]);
  });

  describe("bundled program", () => {
    /** Runs the fake whatever program the adapter chose, recording what it asked for. */
    const recordingSpawn = () =>
      vi.fn((_file: string, args: string[], o: object) => nodeSpawn(process.execPath, [FAKE, ...args.slice(args.indexOf("--acp"))], o as never));

    it("runs the bundled Gemini CLI with this Node by default and never looks on PATH", async () => {
      script([]);
      const spawn = recordingSpawn();
      const bin = vi.fn(() => "/opt/gemini/bin/gemini");
      const entry = join(outside, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js");
      const r = await new GeminiAdapter({ dataDir: outside, bundled: () => ({ file: process.execPath, args: [entry] }), bin, apiKey: () => FAKE_KEY, spawn: spawn as never }).start(harness().opts);
      expect(r).toEqual({ status: "completed" });
      expect(spawn).toHaveBeenCalledWith(process.execPath, [entry, ...RUN_ARGS], expect.objectContaining({ env: expect.objectContaining({ GEMINI_CLI_NO_RELAUNCH: "1" }) }));
      expect(bin).not.toHaveBeenCalled();
    });

    it("uses the package's own bundled Gemini CLI when none is injected", async () => {
      script([]);
      const { bundledGemini } = await import("../../src/agents/bundled.js");
      const expected = bundledGemini()!;
      const spawn = recordingSpawn();
      const bin = vi.fn(() => null);
      const r = await new GeminiAdapter({ dataDir: outside, bin, apiKey: () => FAKE_KEY, spawn: spawn as never }).start(harness().opts);
      expect(r).toEqual({ status: "completed" });
      expect(spawn).toHaveBeenCalledWith(expected.file, [...expected.args, ...RUN_ARGS], expect.anything());
      expect(bin).not.toHaveBeenCalled();
    });

    it("consults PATH only when the bundled lookup returns null", async () => {
      script([]);
      const spawn = recordingSpawn();
      const bundled = vi.fn(() => null);
      const bin = vi.fn(() => "/opt/gemini/bin/gemini");
      const r = await new GeminiAdapter({ dataDir: outside, bundled, bin, apiKey: () => FAKE_KEY, spawn: spawn as never }).start(harness().opts);
      expect(r).toEqual({ status: "completed" });
      expect(bundled).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledWith("/opt/gemini/bin/gemini", RUN_ARGS, expect.anything());
    });

    it("a test command wins over the bundled program", async () => {
      script([]);
      const bundled = vi.fn(() => null);
      const r = await new GeminiAdapter({ dataDir: outside, command: { file: process.execPath, args: [FAKE] }, bundled, apiKey: () => FAKE_KEY }).start(harness().opts);
      expect(r).toEqual({ status: "completed" });
      expect(bundled).not.toHaveBeenCalled();
    });
  });

  describe("npm .cmd shim", () => {
    const shim = () => join(outside, "npm", "gemini.CMD");
    const pkg = () => join(outside, "npm", "node_modules", "@google", "gemini-cli", "package.json");
    const target = () => join(outside, "npm", "node_modules", "@google", "gemini-cli", "bundle", "gemini.js");
    const readFile = (p: string) => {
      if (p !== pkg()) throw new Error("ENOENT");
      return JSON.stringify({ name: "@google/gemini-cli", bin: { gemini: "bundle/gemini.js" } });
    };

    it("runs the package's bin script with node instead of a shell", async () => {
      script([]);
      const spawn = vi.fn((_file: string, args: string[], o: object) => nodeSpawn(process.execPath, [FAKE, ...args.slice(1)], o as never));
      const exists = vi.fn((p: string) => p === target());
      const r = await new GeminiAdapter({ dataDir: outside, bundled: () => null, bin: shim, apiKey: () => FAKE_KEY, spawn: spawn as never, exists, readFile }).start(harness().opts);
      expect(r).toEqual({ status: "completed" });
      expect(spawn).toHaveBeenCalledWith(process.execPath, [target(), ...RUN_ARGS], expect.objectContaining({ env: expect.objectContaining({ GEMINI_CLI_NO_RELAUNCH: "1" }) }));
      expect(spawn.mock.calls[0]![2]).not.toHaveProperty("shell");
    });

    it("refuses the shim when the package or its bin script is missing, or the script points outside the package", async () => {
      const spawn = vi.fn();
      const refused = { status: "failed", error: "Gemini CLI must be a native executable on Windows (found a .cmd shim)" };
      const withBin = (bin: string) => () => JSON.stringify({ bin: { gemini: bin } });
      expect(await new GeminiAdapter({ dataDir: outside, bundled: () => null, bin: shim, apiKey: () => FAKE_KEY, spawn: spawn as never, exists: () => true, readFile: () => { throw new Error("ENOENT"); } }).start(harness().opts)).toEqual(refused);
      expect(await new GeminiAdapter({ dataDir: outside, bundled: () => null, bin: shim, apiKey: () => FAKE_KEY, spawn: spawn as never, exists: () => false, readFile }).start(harness().opts)).toEqual(refused);
      expect(await new GeminiAdapter({ dataDir: outside, bundled: () => null, bin: shim, apiKey: () => FAKE_KEY, spawn: spawn as never, exists: () => true, readFile: () => "{}" }).start(harness().opts)).toEqual(refused);
      expect(await new GeminiAdapter({ dataDir: outside, bundled: () => null, bin: shim, apiKey: () => FAKE_KEY, spawn: spawn as never, exists: () => true, readFile: withBin("../../../evil.js") }).start(harness().opts)).toEqual(refused);
      expect(await new GeminiAdapter({ dataDir: outside, bundled: () => null, bin: shim, apiKey: () => FAKE_KEY, spawn: spawn as never, exists: () => true, readFile: withBin(join(outside, "evil.js")) }).start(harness().opts)).toEqual(refused);
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("rejects unsupported auth modes", async () => {
    const r = await adapter().start(harness(policyGate(), "subscription").opts);
    expect(r).toEqual({ status: "failed", error: "Unsupported auth mode for Gemini: subscription" });
  });

  it("does not start gemini when the signal is already aborted", async () => {
    script([]);
    const h = harness();
    h.abort.abort();
    const { spawn, children } = fakeSpawn();
    expect(await adapter({ spawn }).start(h.opts)).toEqual({ status: "failed", error: "run stopped" });
    expect(children).toEqual([]);
  });

  it("switches the session to the default mode when it starts in another one", async () => {
    script({ config: { modes: { currentModeId: "yolo", availableModes: [{ id: "default", name: "Default" }, { id: "yolo", name: "YOLO" }] } }, steps: [] });
    expect(await adapter().start(harness().opts)).toEqual({ status: "completed" });
    expect(methodsCalled()).toEqual(["initialize", "session/new", "session/set_mode", "session/prompt"]);
    expect(readLog().find((e) => e.method === "session/set_mode")!.params).toEqual({ sessionId: "fake-session", modeId: "default" });
  });

  it("refuses to prompt when no mode asks for every tool", async () => {
    script({ config: { modes: { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "YOLO" }] } }, steps: [] });
    const r = await adapter().start(harness().opts);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/mode/);
    expect(methodsCalled()).not.toContain("session/prompt");
  });

  it("fails on an unsupported protocol version without prompting", async () => {
    script({ config: { protocolVersion: 2 }, steps: [] });
    const r = await adapter().start(harness().opts);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/protocol version/);
    expect(methodsCalled()).toEqual(["initialize"]);
  });

  it("a read inside the worktree is gated as file_read, auto-allowed by policy, and the content returned", async () => {
    const path = join(worktree, "README.md");
    script([{ type: "read", path, toolCall: true }]);
    const h = harness();
    const r = await adapter().start(h.opts);
    expect(r).toEqual({ status: "completed" });
    expect(h.proposed).toEqual([{ tool: "fs/read_text_file", kind: "file_read", summary: "Read README.md", input: { path }, paths: [path] }]);
    expect(h.decisions[0]).toMatchObject({ decision: "allow", reason: "read-only inside worktree" });
    expect(logged("read")[0]!.result).toEqual({ content: "hello from the worktree\n" });
    expect(h.events).toEqual([{ type: "action_result", actionId: "act-1", ok: true, output: "hello from the worktree\n" }]);
  });

  it("honours line and limit on a read", async () => {
    writeFileSync(join(worktree, "lines.txt"), "one\ntwo\nthree\nfour\n");
    script([{ type: "read", path: join(worktree, "lines.txt"), line: 2, limit: 2 }]);
    await adapter().start(harness().opts);
    expect(logged("read")[0]!.result).toEqual({ content: "two\nthree\n" });
  });

  it("denies reads of ../x, an absolute path outside, .git/config and a symlink escape, and reads nothing", async () => {
    mkdirSync(join(worktree, ".git"));
    writeFileSync(join(worktree, ".git", "config"), "[core]\n");
    writeFileSync(join(outside, "secret.txt"), "outside secret\n");
    symlinkSync(join(outside, "secret.txt"), join(worktree, "link.txt"));
    const paths = ["../x", join(outside, "secret.txt"), join(worktree, ".git", "config"), join(worktree, "link.txt"), ".git/config", "sub/../../x"];
    script(paths.map((path) => ({ type: "read", path })));
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(h.proposed.map((a) => a.paths)).toEqual(paths.map((p) => [p]));
    for (const d of h.decisions) expect(d).toMatchObject({ decision: "deny", reason: "outside worktree" });
    const reads = logged("read");
    expect(reads).toHaveLength(paths.length);
    for (const e of reads) {
      expect(e.error).toBeDefined();
      expect(JSON.stringify(e)).not.toContain("outside secret");
    }
    expect(h.events).toEqual([]);
  });

  it("a read tool whose client read was denied still completes (as gemini reports it) without being ungated", async () => {
    const path = join(outside, "secret.txt");
    writeFileSync(path, "outside secret\n");
    script([{ type: "read", path, toolCall: true }, { type: "message", text: "went on" }]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(h.decisions[0]).toMatchObject({ decision: "deny", reason: "outside worktree" });
    expect(logged("read")[0]!.error).toBeDefined();
    expect(h.denied).toEqual([]);
    expect(h.events).toEqual([{ type: "message", text: "went on" }]);
  });

  it("reads only regular files and caps them at 8 MiB", async () => {
    mkdirSync(join(worktree, "dir"));
    writeFileSync(join(worktree, "big.txt"), Buffer.alloc(8 * MiB + 1, 0x61));
    script([{ type: "read", path: join(worktree, "dir") }, { type: "read", path: join(worktree, "big.txt") }]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    const reads = logged("read");
    expect(reads[0]!.error).toBeDefined();
    expect(reads[1]!.error).toBeDefined();
    expect(h.events).toEqual([
      { type: "action_result", actionId: "act-1", ok: false, output: "not a regular file" },
      { type: "action_result", actionId: "act-2", ok: false, output: "file is larger than 8 MiB" },
    ]);
  });

  it("an edit asks once: the write carrying exactly the approved diff is performed under that approval", async () => {
    const path = join(worktree, "sub", "dir", "notes.md");
    script([{ type: "write", path, content: "# notes\n", permission: true }]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(h.proposed.map((a) => [a.tool, a.kind, a.summary, a.paths])).toEqual([["gemini", "file_edit", `Write ${path}`, [path]]]);
    expect(readFileSync(path, "utf8")).toBe("# notes\n");
    expect(logged("permission")[0]!.result).toEqual({ outcome: { outcome: "selected", optionId: "proceed_once" } });
    expect(logged("write")[0]!.result).toEqual({});
    expect(h.events).toEqual([{ type: "action_result", actionId: "act-1", ok: true, output: "written" }]);
  });

  it("a write that differs from the approved diff is gated again as file_write", async () => {
    const path = join(worktree, "notes.md");
    script([{ type: "write", path, content: "approved\n", permission: true, writeContent: "something else\n" }]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(h.proposed.map((a) => [a.tool, a.kind, a.summary, a.paths])).toEqual([
      ["gemini", "file_edit", `Write ${path}`, [path]],
      ["fs/write_text_file", "file_write", "Write notes.md", [path]],
    ]);
    expect(h.proposed[1]!.input).toEqual({ path, content: "something else\n" });
    expect(readFileSync(path, "utf8")).toBe("something else\n");
    expect(h.events).toEqual([
      { type: "action_result", actionId: "act-2", ok: true, output: "wrote 15 bytes" },
      { type: "action_result", actionId: "act-1", ok: true, output: "written" },
    ]);
  });

  it("a write with no approval in flight is gated as file_write and creates parent directories", async () => {
    const path = join(worktree, "sub", "dir", "notes.md");
    script([{ type: "write", path, content: "# notes\n" }]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(h.proposed.map((a) => [a.tool, a.kind, a.summary, a.paths])).toEqual([["fs/write_text_file", "file_write", "Write sub/dir/notes.md", [path]]]);
    expect(readFileSync(path, "utf8")).toBe("# notes\n");
    expect(h.events).toEqual([{ type: "action_result", actionId: "act-1", ok: true, output: "wrote 8 bytes" }]);
  });

  it("overwriting a file keeps its mode", async () => {
    const path = join(worktree, "run.sh");
    writeFileSync(path, "#!/bin/sh\necho old\n");
    chmodSync(path, 0o755);
    script([{ type: "write", path, content: "#!/bin/sh\necho new\n" }]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\necho new\n");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o7777).toBe(0o755);
  });

  it("overwriting a setuid file keeps only its permission bits", async () => {
    if (process.platform === "win32") return;
    const path = join(worktree, "tool.sh");
    writeFileSync(path, "#!/bin/sh\necho old\n");
    chmodSync(path, 0o4755);
    expect(statSync(path).mode & 0o7777).toBe(0o4755);
    script([{ type: "write", path, content: "#!/bin/sh\necho new\n" }]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\necho new\n");
    expect(statSync(path).mode & 0o7777).toBe(0o755);
  });

  it("Deny on the write leaves no file and returns an error to the agent", async () => {
    const path = join(worktree, "notes.md");
    script([{ type: "write", path, content: "x" }]);
    const h = harness(policyGate(() => ({ decision: "deny", reason: "not now" })));
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(h.proposed).toHaveLength(1);
    expect(existsSync(path)).toBe(false);
    expect(logged("write")[0]!.error).toBeDefined();
    expect(h.events).toEqual([]);
  });

  it("never writes outside the worktree, even if the gate allowed it", async () => {
    const path = join(outside, "escaped.txt");
    script([{ type: "write", path, content: "x" }]);
    const h = harness(() => ({ decision: "allow", reason: "a bug" }));
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(existsSync(path)).toBe(false);
    expect(logged("write")[0]!.error).toBeDefined();
    expect(h.events).toEqual([{ type: "action_result", actionId: "act-1", ok: false, output: "outside worktree" }]);
  });

  it("a terminal asks as shell, runs the command without a shell in the worktree, and returns the output", async () => {
    const probe = "process.stdout.write(JSON.stringify({ cwd: process.cwd(), key: process.env.GEMINI_API_KEY ?? null, git: process.env.GIT_CONFIG_NOSYSTEM, extra: process.env.FAKE_EXTRA, others: Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_|CODEX_|GEMINI_|GOOGLE_|VERTEX)/i.test(k)) }))";
    script([{ type: "terminal", command: process.execPath, args: ["-e", probe], env: [{ name: "FAKE_EXTRA", value: "yes" }] }]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(h.proposed).toHaveLength(1);
    expect(h.proposed[0]).toMatchObject({ tool: "terminal/create", kind: "shell", paths: [] });
    const suffix = " (in ., +1 env)";
    expect(h.proposed[0]!.summary).toBe(`Run: ${`${process.execPath} -e ${probe}`.slice(0, 150 - suffix.length)}${suffix}`);
    expect(h.proposed[0]!.input).toEqual({ command: process.execPath, args: ["-e", probe], env: [{ name: "FAKE_EXTRA", value: "yes" }] });
    const out = logged("terminal/output")[0]!.result;
    expect(out.truncated).toBe(false);
    expect(out.exitStatus).toEqual({ exitCode: 0, signal: null });
    expect(JSON.parse(out.output)).toEqual({ cwd: worktree, key: null, git: "1", extra: "yes", others: [] });
    expect(logged("terminal/wait_for_exit")[0]!.result).toEqual({ exitCode: 0, signal: null });
    expect(logged("terminal/release")[0]!.result).toEqual({});
    expect(h.events).toEqual([{ type: "action_result", actionId: "act-1", ok: true, output: out.output }]);
  });

  it("a terminal with a cwd outside the worktree is denied and never runs", async () => {
    const marker = join(outside, "ran.txt");
    script([{ type: "terminal", command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`], cwd: outside }]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(h.proposed[0]).toMatchObject({ kind: "shell", paths: [outside] });
    expect(h.decisions[0]).toMatchObject({ decision: "deny", reason: "outside worktree" });
    expect(logged("terminal/output")).toEqual([]); // no terminal was ever created
    expect(existsSync(marker)).toBe(false);
    expect(h.events).toEqual([]);
  });

  it("a terminal cwd inside the worktree is used", async () => {
    mkdirSync(join(worktree, "pkg"));
    script([{ type: "terminal", command: process.execPath, args: ["-e", "process.stdout.write(process.cwd())"], cwd: join(worktree, "pkg") }]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(h.proposed[0]!.paths).toEqual([join(worktree, "pkg")]);
    expect(h.proposed[0]!.summary).toBe(`Run: ${process.execPath} -e process.stdout.write(process.cwd()) (in pkg)`);
    expect(logged("terminal/output")[0]!.result.output).toBe(join(worktree, "pkg"));
  });

  it("caps a long terminal cwd in the summary so the command stays visible", async () => {
    const cwd = join(outside, "d".repeat(200));
    script([{ type: "terminal", command: "npm", args: ["run", "build"], cwd }]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    const shown = `${cwd.replace(/\\/g, "/").slice(0, 59)}…`; // the summary shows a path with / separators
    expect(h.proposed[0]!.summary).toBe(`Run: npm run build (in ${shown})`);
  });

  it("cleans a terminal's cwd and command with the run's live secrets before capping them for the summary", async () => {
    script([
      { type: "terminal", command: "npm", args: ["run", "build"], cwd: join(worktree, `${"d".repeat(52)}${STORED}`) },
      { type: "terminal", command: "echo", args: ["a".repeat(134), STORED] },
    ]);
    const h = harness(() => ({ decision: "deny", reason: "no" }));
    h.opts.clean = (t) => redact(t, [STORED]);
    await adapter().start(h.opts);
    expect(h.proposed.map((a) => a.summary)).toEqual([
      `Run: npm run build (in ${"d".repeat(52)}[REDACT…)`,
      `Run: echo ${"a".repeat(134)} [REDACTED]`,
    ]);
  });

  it("a clean() that throws while building a terminal summary records the request as denied and fails the run", async () => {
    script([{ type: "terminal", command: "npm", args: ["run", "build"] }, { type: "message", text: "after" }]);
    const h = harness();
    h.opts.clean = () => {
      throw new Error("secret store unavailable");
    };
    expect(await adapter().start(h.opts)).toEqual({ status: "failed", error: "internal error" });
    expect(h.proposed).toEqual([]);
    expect(h.denied.map(([a, reason]) => [a.tool, a.kind, reason])).toEqual([["terminal/create", "shell", "internal error"]]);
    expect(logged("terminal/output")).toEqual([]); // no terminal was ever created
  });

  it("holds back the tail of a size-split message, so a secret streamed across two chunks is redacted whole", async () => {
    const head = "w ".repeat(1995); // 3990 characters, then the secret begins
    script([
      { type: "message", text: `${head}${STORED.slice(0, 12)}` },
      { type: "message", text: `${STORED.slice(12)} end` },
    ]);
    const h = harness();
    h.opts.clean = (t) => redact(t, [STORED]);
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    const texts = h.events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
    expect(texts.join("")).toBe(`${head}${STORED} end`);
    expect(texts.some((t) => t.includes(STORED))).toBe(true); // one message carries the whole secret, for the runner to redact
  });

  for (const [label, line, secret] of [
    ["an Authorization: Bearer token", `Authorization: Bearer ${OPAQUE_TOKEN}`, OPAQUE_TOKEN],
    ["an api_key = value pair", `api_key = ${OPAQUE_VALUE}`, OPAQUE_VALUE],
  ] as const) {
    it(`never separates ${label} from its context at a size split, wherever the split falls`, async () => {
      const at = line.indexOf(secret);
      const space = line.indexOf(" ");
      for (const cut of new Set([at + 12, at, at - 1, at - 2, at - 3, space, space + 1])) {
        const steps = straddle(line, cut);
        script(steps);
        const h = harness();
        expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
        const texts = h.events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
        expect(texts.length).toBeGreaterThan(1);
        expect(texts.join("")).toBe(streamed(steps)); // every character once, in order
        const recorded = texts.map((t) => redact(t)).join(""); // each message redacted on its own, as the runner does
        expect(recorded).toBe(redact(streamed(steps)));
        expect(recorded).toContain("[REDACTED]");
        expectNoFragment(recorded, secret);
      }
    });
  }

  it("holds a private key block whole across size splits, so no line of its body is left outside the redacted block", async () => {
    const text = `${"intro line\n".repeat(330)}${KEY_BEGIN}\n${keyBody(30).join("\n")}\n${KEY_END}\nafter the key\n`;
    script(chunked(text, 200));
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    const texts = h.events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
    expect(texts.join("")).toBe(text);
    const recorded = texts.map((t) => redact(t)).join("");
    expect(recorded).toBe(redact(text));
    expect(recorded).toContain("[REDACTED]");
    expect(recorded).toContain("after the key");
    expect(recorded).not.toContain(KEY_FRAGMENT);
  });

  for (const [label, after, expected] of [
    ["ends later", [{ type: "message", text: `\n${KEY_END}\nstill here` }], "before\n[REDACTED]\nstill here"],
    ["never ends", [], "before\n[REDACTED]"],
  ] as const) {
    it(`emits a 20 KiB key block that ${label} as [REDACTED] at 16 KiB, never its body, and the run goes on`, async () => {
      const block = `${KEY_BEGIN}\n${keyBody(320).join("\n")}`;
      expect(block.length).toBeGreaterThan(20 * 1024);
      script([{ type: "message", text: "before\n" }, ...chunked(block, 1000), ...after]);
      const h = harness();
      expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
      const texts = h.events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
      expect(texts.join("")).toBe(expected);
      expect(texts.join("")).not.toContain(KEY_FRAGMENT);
    });
  }

  for (const [label, first] of [
    ["a key block", `intro\n${KEY_BEGIN}\n${keyBody(3).join("\n")}`],
    ["a partial BEGIN line", "intro\n-----BEGIN RSA PRIV"],
  ] as const) {
    it(`keeps back ${label} at a pause flush until the block is complete`, async () => {
      const full = `intro\n${KEY_BEGIN}\n${keyBody(3).join("\n")}\n${KEY_END}\nafter`;
      script([{ type: "message", text: first }, { type: "sleep", ms: 600 }, { type: "message", text: full.slice(first.length) }]);
      const h = harness();
      expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
      const texts = h.events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
      expect(texts).toEqual(["intro\n", full.slice("intro\n".length)]);
      expect(texts.map((t) => redact(t)).join("")).toBe("intro\n[REDACTED]\nafter");
    });
  }

  it("delivers all prose after an inline mention of a certificate BEGIN line, across a tool call and past 16 KiB", async () => {
    const prose = (n: number) => Array.from({ length: n }, (_, i) => `Sentence ${i} explains the next step of the setup.\n`).join("");
    const steps: Step[] = [
      { type: "message", text: "The file should start with `-----BEGIN CERTIFICATE-----` and hold the certificate.\n" },
      ...chunked(prose(200), 500),
      { type: "read", path: join(worktree, "README.md"), toolCall: true },
      ...chunked(prose(200), 500),
    ];
    expect(streamed(steps.filter((s) => s.type === "message")).length).toBeGreaterThan(16 * 1024);
    script(steps);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    const texts = h.events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
    expect(texts.join("")).toBe(streamed(steps.filter((s) => s.type === "message")));
    expect(h.events.findIndex((e) => e.type === "action_result")).toBeLessThan(h.events.length - 1); // prose went out before the run ended
  });

  for (const [label, mention, shown] of [
    ["inline", "Start it with -----BEGIN RSA PRIVATE KEY----- and then paste the body.\n", "Start it with [REDACTED] and then paste the body.\n"],
    ["on its own line", `Example:\n${KEY_BEGIN}\nThe body goes here, then the END line.\n`, "Example:\n[REDACTED]\nThe body goes here, then the END line.\n"],
  ] as const) {
    it(`releases the prose after a private key BEGIN line mentioned ${label}, from the first line that is not key body`, async () => {
      const more = Array.from({ length: 40 }, (_, i) => `Line ${i} of the explanation.\n`).join("");
      script([{ type: "message", text: mention }, { type: "sleep", ms: 400 }, ...chunked(more, 300), { type: "read", path: join(worktree, "README.md"), toolCall: true }]);
      const h = harness();
      expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
      const texts = h.events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
      expect(texts.join("")).toBe(shown + more);
      expect(h.events.at(-1)!.type).toBe("action_result"); // nothing was held to the end of the run
    });
  }

  it("redacts a private key whose body lines stream with pauses, and releases the prose after an inline-looking key line", async () => {
    const body = keyBody(4);
    const steps: Step[] = [
      { type: "message", text: `Here:\n${KEY_BEGIN}\n${body[0]}\n` },
      { type: "sleep", ms: 400 },
      { type: "message", text: `${body[1]}\n${body[2]}` },
      { type: "sleep", ms: 400 },
      { type: "message", text: `\n${body[3]}\n${KEY_END}\nDone.\n` },
    ];
    script(steps);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    const texts = h.events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
    const recorded = texts.map((t) => redact(t)).join("");
    expect(recorded).toBe("Here:\n[REDACTED]\nDone.\n");
    expect(recorded).not.toContain(KEY_FRAGMENT);
  });

  it("cuts minified JSON with no whitespace at punctuation, or before a secret key whose quoted value is still open", async () => {
    const pad = (n: number) => `{"pad":"${"p".repeat(n)}",`;
    const longValue = Array.from({ length: 20 }, () => OPAQUE_VALUE).join("");
    for (const [first, second, secret] of [
      [`"password":"${OPAQUE_VALUE}","note":"${"n".repeat(500)}`, '"}', OPAQUE_VALUE],
      [`"password":"${longValue.slice(0, 600)}`, `${longValue.slice(600)}"}`, longValue],
    ] as const) {
      const head = pad(4000 - first.length) + first;
      const min = head.length - 512;
      expect(head.indexOf(secret.slice(0, 20))).toBeLessThan(min); // without punctuation or step-back, the cut would fall inside the value
      const steps: Step[] = [{ type: "message", text: head }, { type: "message", text: second }];
      script(steps);
      const h = harness();
      expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
      const texts = h.events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
      expect(texts.length).toBeGreaterThan(1);
      expect(texts.join("")).toBe(streamed(steps));
      const recorded = texts.map((t) => redact(t)).join("");
      expect(recorded).toBe(redact(streamed(steps)));
      expectNoFragment(recorded, secret);
    }
  });

  it("holds a secret YAML block scalar until it ends, even across pause flushes", async () => {
    const steps: Step[] = [
      { type: "message", text: "config:\n  password: |\n    line-one-of-the-body\n" },
      { type: "sleep", ms: 400 },
      { type: "message", text: "    line-two-of-the-body\n" },
      { type: "sleep", ms: 400 },
      { type: "message", text: "  other: x\ndone\n" },
    ];
    script(steps);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    const texts = h.events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
    expect(texts.join("")).toBe(streamed(steps));
    const recorded = texts.map((t) => redact(t)).join("");
    expect(recorded).toBe(redact(streamed(steps)));
    expect(recorded).not.toContain("line-one");
    expect(recorded).not.toContain("line-two");
  });

  it("flushes the held tail of a size-split message after a pause, without waiting for more output", async () => {
    const head = "w ".repeat(2000);
    script([{ type: "message", text: `${head}held\ntail more` }, { type: "sleep", ms: 1500 }, { type: "message", text: "later" }]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    const texts = h.events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
    // The pause flush keeps back the trailing word, which may still be growing; the end of the turn flushes it.
    expect(texts).toEqual([`${head}held\n`, "tail ", "morelater"]);
  });

  it("never emits part of a secret streamed with pauses longer than the flush delay between its chunks", async () => {
    script([
      { type: "message", text: "intro text " },
      { type: "sleep", ms: 400 },
      { type: "message", text: STORED.slice(0, 10) },
      { type: "sleep", ms: 400 },
      { type: "message", text: STORED.slice(10, 20) },
      { type: "sleep", ms: 400 },
      { type: "message", text: `${STORED.slice(20)} done` },
    ]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    const texts = h.events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
    expect(texts.join("")).toBe(`intro text ${STORED} done`);
    expect(texts[0]).toBe("intro text "); // the pause flushed what was safe
    for (const t of texts) if (t.includes(STORED.slice(0, 6)) || t.includes(STORED.slice(-6))) expect(t).toContain(STORED);
  });

  it("debounces the pause flush, but never holds streaming text back longer than 2 s", async () => {
    const steps: Step[] = [];
    for (let i = 0; i < 50; i++) steps.push({ type: "message", text: `w${i} ` }, { type: "sleep", ms: 50 });
    script(steps);
    const h = harness();
    const at: number[] = [];
    const t0 = Date.now();
    h.opts.emit = (e) => {
      h.events.push(e);
      if (e.type === "message") at.push(Date.now() - t0);
    };
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    const texts = h.events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
    expect(texts.join("")).toBe(streamed(steps.filter((s) => s.type === "message")));
    expect(texts.length).toBeGreaterThanOrEqual(2); // flushed at the cap while still streaming
    expect(texts.length).toBeLessThanOrEqual(4); // not every 250 ms
    expect(at.at(-1)! - at[0]!).toBeGreaterThan(200); // the first flush came at the cap, well before the end
    for (const t of texts.slice(0, -1)) expect(t).toMatch(/\s$/); // never cut inside a word
  });

  it("records the output of a truncated terminal without the partial word its cut left at the start", async () => {
    script([{ type: "terminal", command: process.execPath, args: ["-e", `process.stdout.write("${STORED} tail")`], outputByteLimit: 12 }]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(logged("terminal/output")[0]!.result).toMatchObject({ output: "3456789 tail", truncated: true });
    expect(h.events).toEqual([{ type: "action_result", actionId: "act-1", ok: true, output: " tail" }]);
  });

  it("emits a reported cumulative USD cost once, at the end of the turn; context-size usage alone is not reported", async () => {
    script([
      { type: "update", update: { sessionUpdate: "usage_update", used: 1200, size: 1000000 } },
      { type: "update", update: { sessionUpdate: "usage_update", used: 1500, size: 1000000, cost: { amount: 0.01, currency: "USD" } } },
      { type: "update", update: { sessionUpdate: "usage_update", used: 1800, size: 1000000, cost: { amount: 0.03, currency: "USD" } } },
      { type: "message", text: "done" },
    ]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(h.events.filter((e) => e.type === "usage")).toEqual([{ type: "usage", costUsd: 0.03 }]);

    script([
      { type: "update", update: { sessionUpdate: "usage_update", used: 1200, size: 1000000 } },
      { type: "update", update: { sessionUpdate: "usage_update", used: 1300, size: 1000000, cost: { amount: 5, currency: "EUR" } } },
    ]);
    const h2 = harness();
    expect(await adapter().start(h2.opts)).toEqual({ status: "completed" });
    expect(h2.events.filter((e) => e.type === "usage")).toEqual([]);
  });

  it("caps terminal output at 1 MiB keeping the tail, and reports a non-zero exit", async () => {
    const code = "process.stdout.write('xxxxxxx\\n'.repeat(192 * 1024) + 'TAIL'); process.exitCode = 3";
    script([{ type: "terminal", command: process.execPath, args: ["-e", code] }]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    const out = logged("terminal/output")[0]!.result;
    expect(out.truncated).toBe(true);
    expect(out.output.length).toBeLessThanOrEqual(MiB);
    expect(out.output.endsWith("TAIL")).toBe(true);
    expect(out.exitStatus).toEqual({ exitCode: 3, signal: null });
    expect(h.events).toEqual([{ type: "action_result", actionId: "act-1", ok: false, output: out.output.replace(/^\S*/, "") }]);
  });

  it("honours a smaller outputByteLimit and refuses terminals it did not create", async () => {
    script([
      { type: "terminal", command: process.execPath, args: ["-e", "process.stdout.write('abcdefghij')"], outputByteLimit: 4 },
      { type: "request", method: "terminal/output", params: { sessionId: "fake-session", terminalId: "not-ours" } },
    ]);
    const h = harness();
    const r = await adapter().start(h.opts);
    expect(logged("terminal/output")[0]!.result).toMatchObject({ output: "ghij", truncated: true });
    expect(r).toEqual({ status: "failed", error: "unknown terminal from agent: terminal/output" });
  });

  it("kills a terminal still running when the run finishes", async () => {
    const pidFile = join(outside, "pid.txt");
    const code = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    script([{ type: "request", method: "terminal/create", params: { sessionId: "fake-session", command: process.execPath, args: ["-e", code] } }, { type: "sleep", ms: 300 }]);
    const h = harness();
    const started = Date.now();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(Date.now() - started).toBeLessThan(8000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
    expect(h.events).toEqual([{ type: "action_result", actionId: "act-1", ok: false, output: "" }]);
  });

  it("request_permission maps tool kinds and locations, answers allow_once, and links the result", async () => {
    const options = [
      { optionId: "always", name: "Allow for this session", kind: "allow_always" },
      { optionId: "once", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ];
    const file = join(worktree, "a.ts");
    const calls: [string, Record<string, unknown>][] = [
      ["edit", { locations: [{ path: file, line: 3 }] }],
      ["delete", { locations: [{ path: file }] }],
      ["execute", {}],
      ["read", { locations: [{ path: file }] }],
      ["fetch", {}],
      ["search", {}],
      ["other", { name: "my_tool" }],
    ];
    script(calls.map(([kind, extra], i) => ({ type: "requestPermission", result: `out-${i}`, options, toolCall: { toolCallId: `tc-${i}`, title: `Title ${i}`, kind, content: [], ...extra } })));
    const h = harness(() => ({ decision: "allow", reason: "ok" }));
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(h.proposed.map((a) => [a.tool, a.kind, a.summary, a.paths])).toEqual([
      ["gemini", "file_edit", "Title 0", [file]],
      ["gemini", "file_write", "Title 1", [file]],
      ["gemini", "shell", "Title 2", []],
      ["gemini", "file_read", "Title 3", [file]],
      ["gemini", "web", "Title 4", []],
      ["gemini", "other", "Title 5", []],
      ["my_tool", "other", "Title 6", []],
    ]);
    expect(h.proposed[0]!.input).toEqual({ toolCallId: "tc-0", title: "Title 0", kind: "edit", content: [], locations: [{ path: file, line: 3 }] });
    for (const e of logged("requestPermission")) expect(e.result).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    expect(h.events).toEqual(calls.map((_, i) => ({ type: "action_result", actionId: `act-${i + 1}`, ok: true, output: `out-${i}` })));
  });

  it("request_permission answers reject_once on deny, and a failed call reports ok false", async () => {
    const options = [
      { optionId: "always", name: "Allow for this session", kind: "allow_always" },
      { optionId: "once", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ];
    script([
      { type: "requestPermission", options, toolCall: { toolCallId: "tc-1", title: "rm -rf build", kind: "execute" } },
      { type: "requestPermission", options, toolCall: { toolCallId: "tc-2", title: "ls", kind: "execute" } },
      { type: "update", update: { sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "failed", content: [{ type: "content", content: { type: "text", text: "boom" } }] } },
    ]);
    let n = 0;
    const h = harness(() => (++n === 1 ? { decision: "deny", reason: "no" } : { decision: "allow", reason: "ok" }));
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    const answers = logged("requestPermission");
    expect(answers[0]!.result).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(answers[1]!.result).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    // The fake reports tc-2 completed (ok) and then the scripted update fails it again: only the first result counts.
    expect(h.events).toEqual([{ type: "action_result", actionId: "act-2", ok: true, output: "done" }]);
  });

  it("never picks allow_always: without an allow_once option an allowed call is rejected and recorded as not run", async () => {
    script([
      { type: "requestPermission", options: [{ optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "no", name: "Reject", kind: "reject_once" }], toolCall: { toolCallId: "tc-1", title: "edit", kind: "edit", locations: [{ path: join(worktree, "a") }] } },
      { type: "requestPermission", options: [{ optionId: "always", name: "Always", kind: "allow_always" }], toolCall: { toolCallId: "tc-2", title: "edit", kind: "edit", locations: [{ path: join(worktree, "a") }] } },
    ]);
    const h = harness(() => ({ decision: "allow", reason: "ok" }));
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    const answers = logged("requestPermission");
    expect(answers[0]!.result).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(answers[1]!.result).toEqual({ outcome: { outcome: "cancelled" } });
    expect(h.events).toEqual([
      { type: "action_result", actionId: "act-1", ok: false, output: "agent offered no allow_once option" },
      { type: "action_result", actionId: "act-2", ok: false, output: "agent offered no allow_once option" },
    ]);
  });

  it("an ungated tool execution fails the run, kills gemini, and records a denied action", async () => {
    const later = join(worktree, "later.txt");
    script([
      { type: "message", text: "about to run" },
      { type: "ungatedTool", toolCallId: "tc-x", kind: "execute", title: "rm -rf /" },
      { type: "sleep", ms: 2000 },
      { type: "write", path: later, content: "x" },
    ]);
    const { spawn, children } = fakeSpawn();
    const h = harness();
    const r = await adapter({ spawn }).start(h.opts);
    expect(r).toEqual({ status: "failed", error: "agent executed an ungated tool" });
    await waitExit(children[0]!);
    expect(h.proposed).toEqual([]);
    expect(h.denied).toEqual([
      [{ tool: "gemini", kind: "other", summary: "Ungated tool: rm -rf /", input: expect.objectContaining({ toolCallId: "tc-x", kind: "execute" }), paths: [] }, "agent executed an ungated tool"],
    ]);
    expect(h.events).toEqual([{ type: "message", text: "about to run" }]);
    expect(existsSync(later)).toBe(false);
    expect(logged("write")).toEqual([]);
  });

  it("a read tool that completes without ever reading through the client is ungated", async () => {
    script([{ type: "ungatedTool", toolCallId: "tc-r", kind: "read", title: "Read README.md", locations: [{ path: join(worktree, "README.md") }] }]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "failed", error: "agent executed an ungated tool" });
    expect(h.denied[0]![0]).toMatchObject({ kind: "other", summary: "Ungated tool: Read README.md" });
  });

  it("a completed tool call we never saw before is ungated, while one that failed before running is ignored", async () => {
    script([
      { type: "update", update: { sessionUpdate: "tool_call_update", toolCallId: "never-ran", status: "failed", content: [] } },
      { type: "message", text: "still here" },
      { type: "update", update: { sessionUpdate: "tool_call_update", toolCallId: "ghost", status: "completed", content: [] } },
    ]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "failed", error: "agent executed an ungated tool" });
    expect(h.events).toEqual([{ type: "message", text: "still here" }]);
    expect(h.denied).toHaveLength(1);
    expect(h.denied[0]![0]).toMatchObject({ summary: "Ungated tool: unknown tool", input: expect.objectContaining({ toolCallId: "ghost" }) });
  });

  it("a mode change away from default fails the run", async () => {
    script([{ type: "update", update: { sessionUpdate: "current_mode_update", currentModeId: "yolo" } }, { type: "sleep", ms: 2000 }]);
    const r = await adapter().start(harness().opts);
    expect(r).toEqual({ status: "failed", error: "agent changed its approval mode" });
  });

  it("an unknown client request is denied and fails the run", async () => {
    script([{ type: "request", method: "fs/delete_file", params: { sessionId: "fake-session", path: join(worktree, "README.md") } }, { type: "sleep", ms: 2000 }]);
    const h = harness();
    const r = await adapter().start(h.opts);
    expect(r).toEqual({ status: "failed", error: "unknown request from agent: fs/delete_file" });
    expect(h.proposed).toEqual([]);
    expect(h.denied).toEqual([
      [{ tool: "fs/delete_file", kind: "other", summary: "Unsupported request: fs/delete_file", input: { sessionId: "fake-session", path: join(worktree, "README.md") }, paths: [] }, "unknown request from agent: fs/delete_file"],
    ]);
    expect(existsSync(join(worktree, "README.md"))).toBe(true);
  });

  it("a malformed client request is denied and fails the run", async () => {
    script([{ type: "request", method: "fs/read_text_file", params: { sessionId: "fake-session", path: 42 } }, { type: "sleep", ms: 2000 }]);
    const h = harness();
    const r = await adapter().start(h.opts);
    expect(r).toEqual({ status: "failed", error: "malformed request from agent: fs/read_text_file" });
    expect(h.proposed).toEqual([]);
    expect(h.denied).toEqual([
      [{ tool: "fs/read_text_file", kind: "other", summary: "Unsupported request: fs/read_text_file", input: { sessionId: "fake-session", path: 42 }, paths: [] }, "malformed request from agent: fs/read_text_file"],
    ]);
  });

  it("a request or update for another session fails the run", async () => {
    script([{ type: "request", method: "fs/read_text_file", params: { sessionId: "other", path: join(worktree, "README.md") } }, { type: "sleep", ms: 2000 }]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "failed", error: "malformed request from agent: fs/read_text_file" });
    expect(h.proposed).toEqual([]);

    rmSync(logFile, { force: true });
    script([{ type: "update", sessionId: "other", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } }, { type: "sleep", ms: 2000 }]);
    const h2 = harness();
    expect(await adapter().start(h2.opts)).toEqual({ status: "failed", error: "update for an unknown session" });
    expect(h2.events).toEqual([]);
  });

  it("fails with the stop reason when gemini does not end its turn normally", async () => {
    script([{ type: "stop", reason: "refusal" }]);
    expect(await adapter().start(harness().opts)).toEqual({ status: "failed", error: "Gemini stopped: refusal" });
  });

  it("fails with a redacted error when the prompt fails", async () => {
    script([{ type: "fail", message: `quota exceeded for ${SECRET}` }]);
    const r = await adapter().start(harness().opts);
    expect(r.status).toBe("failed");
    expect(r.error).toContain("quota exceeded");
    expect(r.error).not.toContain(SECRET);
  });

  it("fails when gemini exits in the middle of a prompt", async () => {
    script([{ type: "message", text: "partial" }, { type: "exit", code: 2 }]);
    const h = harness();
    const r = await adapter().start(h.opts);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/exited/);
    expect(h.events).toEqual([{ type: "message", text: "partial" }]);
  });

  it("aborting kills gemini and returns run stopped", async () => {
    script([{ type: "message", text: "working " }, { type: "hang" }]); // a trailing word would be held until the end
    const { spawn, children } = fakeSpawn();
    const h = harness();
    const done = adapter({ spawn }).start(h.opts);
    await vi.waitFor(() => expect(h.events).toHaveLength(1));
    h.abort.abort();
    expect(await done).toEqual({ status: "failed", error: "run stopped" });
    await waitExit(children[0]!);
  });

  it("a gate that waits is cut off by abort: the pending write is denied and nothing is written", async () => {
    const path = join(worktree, "notes.md");
    script([{ type: "write", path, content: "x" }]);
    const { spawn, children } = fakeSpawn();
    let release: (() => void) | undefined;
    const h = harness(() => new Promise<GateResult>((resolve) => (release = () => resolve({ decision: "deny", reason: "run stopped" }))));
    const done = adapter({ spawn }).start(h.opts);
    await vi.waitFor(() => expect(h.proposed).toHaveLength(1));
    h.abort.abort();
    release!();
    expect(await done).toEqual({ status: "failed", error: "run stopped" });
    await waitExit(children[0]!);
    expect(existsSync(path)).toBe(false);
  });

  it("messages are flushed before tool results so the ledger keeps their order", async () => {
    script([
      { type: "message", text: "Reading " },
      { type: "message", text: "the file" },
      { type: "read", path: join(worktree, "README.md") },
      { type: "message", text: "done" },
    ]);
    const h = harness();
    expect(await adapter().start(h.opts)).toEqual({ status: "completed" });
    expect(h.events).toEqual([
      { type: "message", text: "Reading the file" },
      { type: "action_result", actionId: "act-1", ok: true, output: "hello from the worktree\n" },
      { type: "message", text: "done" },
    ]);
  });
});

describe("GeminiAdapter through the runner", () => {
  it("records a human-approved write and a terminal whose output holds a secret, redacted", async () => {
    const owner = { kind: "human", id: "owner" } as const;
    const db = openDatabase(":memory:");
    const ledger = new Ledger(db);
    const projectId = new BoardService(db, ledger).createProject(owner, { name: "Gemini" }).id;
    const worktrees = new WorktreeManager(outside);
    const gemini = new GeminiAdapter({ dataDir: outside, command: { file: process.execPath, args: [FAKE] }, apiKey: () => FAKE_KEY, fakeEnv: lateFake });
    const runner = new AgentRunner({ db, ledger, worktrees, broker: new ApprovalBroker(), adapters: { gemini }, extraSecrets: () => [], dataDir: outside });
    try {
      // The fake does not know the worktree the runner creates: it resolves relative paths against its cwd.
      script([
        { type: "write", path: "hello.txt", content: `hi\n${SECRET}\n`, permission: true },
        // The secret comes from the file, not the command: a command that holds a secret is auto-denied by policy.
        { type: "terminal", command: process.execPath, args: ["-e", `console.log("line two is " + require("fs").readFileSync("hello.txt", "utf8").split("\\n")[1])`] },
        { type: "message", text: `the key is ${SECRET}` },
      ]);
      const run = await runner.start(owner, { projectId, adapter: "gemini", prompt: "write hello and run a command" });
      await vi.waitFor(
        () => {
          for (const a of listPendingActions(db, projectId)) runner.decide(owner, a.id, "allow", "fine");
          expect(getRun(db, run.id)!.status).not.toBe("running");
        },
        { timeout: 20_000, interval: 50 },
      );
      expect(getRun(db, run.id)!.status).toBe("completed");
      const actions = listActions(db, run.id);
      expect(actions.map((a) => [a.kind, a.status, a.decidedBy])).toEqual([
        ["file_edit", "completed", "human"],
        ["shell", "completed", "human"],
      ]);
      expect(readFileSync(join(outside, run.worktree, "hello.txt"), "utf8")).toBe(`hi\n${SECRET}\n`);
      const shell = actions[1]!;
      expect(shell.output).toBe("line two is [REDACTED]\n");
      expect(JSON.stringify(actions)).not.toContain(SECRET); // the write's input and the message are redacted too
      const log = logged("terminal/output")[0]!.result.output as string;
      expect(log).toContain(SECRET); // the agent itself saw the real output; only the record is redacted
    } finally {
      await runner.shutdown();
      db.close();
    }
  }, 30_000);

  it("leaves no fragment of a stored secret across the cwd and command caps in the recorded summaries", async () => {
    const owner = { kind: "human", id: "owner" } as const;
    const db = openDatabase(":memory:");
    const ledger = new Ledger(db);
    const projectId = new BoardService(db, ledger).createProject(owner, { name: "Gemini" }).id;
    const worktrees = new WorktreeManager(outside);
    const gemini = new GeminiAdapter({ dataDir: outside, command: { file: process.execPath, args: [FAKE] }, apiKey: () => FAKE_KEY, fakeEnv: lateFake });
    const runner = new AgentRunner({ db, ledger, worktrees, broker: new ApprovalBroker(), adapters: { gemini }, extraSecrets: () => [STORED], dataDir: outside });
    try {
      script([
        { type: "terminal", command: "npm", args: ["run", "build"], cwd: `${"d".repeat(52)}${STORED}` },
        { type: "terminal", command: "echo", args: ["a".repeat(136), STORED] },
      ]);
      const run = await runner.start(owner, { projectId, adapter: "gemini", prompt: "build" });
      await vi.waitFor(
        () => {
          for (const a of listPendingActions(db, projectId)) runner.decide(owner, a.id, "deny", "no");
          expect(getRun(db, run.id)!.status).not.toBe("running");
        },
        { timeout: 20_000, interval: 50 },
      );
      expect(listActions(db, run.id).map((a) => a.summary)).toEqual([
        `Run: npm run build (in ${"d".repeat(52)}[REDACT…)`,
        `Run: echo ${"a".repeat(136)} [REDACTE`,
      ]);
      expect(JSON.stringify(ledger.list())).not.toContain(STORED.slice(0, 6));
    } finally {
      await runner.shutdown();
      db.close();
    }
  }, 30_000);

  const keyText = `${"intro line\n".repeat(330)}${KEY_BEGIN}\n${keyBody(30).join("\n")}\n${KEY_END}\nafter the key\n`;
  for (const [label, steps, field, fragments] of [
    [
      "a secret streamed across a message split",
      [{ type: "message", text: `${"w ".repeat(1995)}${STORED.slice(0, 12)}` }, { type: "message", text: `${STORED.slice(12)} end` }],
      "messages",
      [STORED.slice(0, 6), STORED.slice(12)],
    ],
    ["a secret across char 500 of a peer error", [{ type: "fail", message: `${"e".repeat(490)} ${STORED} rest` }], "error", [STORED.slice(0, 6), STORED.slice(12)]],
    [
      "a Bearer token whose header straddles a message split",
      straddle(`Authorization: Bearer ${OPAQUE_TOKEN}`, 34),
      "messages",
      [OPAQUE_TOKEN.slice(0, 8), OPAQUE_TOKEN.slice(12), OPAQUE_TOKEN.slice(-8)],
    ],
    ["a private key block streamed across message splits", chunked(keyText, 200), "messages", [KEY_FRAGMENT]],
  ] as const) {
    it(`leaves no fragment of ${label} in the record`, async () => {
      const owner = { kind: "human", id: "owner" } as const;
      const db = openDatabase(":memory:");
      const ledger = new Ledger(db);
      const projectId = new BoardService(db, ledger).createProject(owner, { name: "Gemini" }).id;
      const gemini = new GeminiAdapter({ dataDir: outside, command: { file: process.execPath, args: [FAKE] }, apiKey: () => FAKE_KEY, fakeEnv: lateFake });
      const runner = new AgentRunner({
        db, ledger, worktrees: new WorktreeManager(outside), broker: new ApprovalBroker(), adapters: { gemini }, extraSecrets: () => [STORED], dataDir: outside,
      });
      try {
        script([...steps]);
        const run = await runner.start(owner, { projectId, adapter: "gemini", prompt: "go" });
        await vi.waitFor(() => expect(getRun(db, run.id)!.status).not.toBe("running"), { timeout: 20_000, interval: 50 });
        const record = JSON.stringify(ledger.list());
        expect(record).toContain("[REDACTED]");
        for (const f of fragments) expect(record).not.toContain(f);
        if (field === "error") expect(getRun(db, run.id)!.error).toContain("[REDACTED] rest");
      } finally {
        await runner.shutdown();
        db.close();
      }
    }, 30_000);
  }
});
