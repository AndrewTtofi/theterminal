import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { LedgerEntry, Provider } from "@theterminal/shared";
import { SignInManager, signInLines, type SignInManagerDeps } from "../../src/connections/signin.js";
import { ensureEmptyGitconfig } from "../../src/agents/worktrees.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { createServer, type RunningServer } from "../../src/server/server.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-login.mjs", import.meta.url));
const fake = { file: process.execPath, args: [FIXTURE] };
const KEY = "sk-ant-TESTKEY-0000000000";

const dirs: string[] = [];
const managers: SignInManager[] = [];
const running: RunningServer[] = [];
const ENV_KEYS = ["THETERMINAL_FAKE_AGENT", "THETERMINAL_FAKE_LOGIN", "OPENAI_API_KEY"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(async () => {
  while (managers.length) await managers.pop()!.shutdown();
  while (running.length) await running.pop()!.close().catch(() => undefined);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "tt-signin-"));
  dirs.push(d);
  return d;
}

function manager(script: Record<string, unknown>, over: Partial<SignInManagerDeps> = {}) {
  const dataDir = tempDir();
  ensureEmptyGitconfig(dataDir);
  const recorded: { provider: Provider; ok: boolean }[] = [];
  const m = new SignInManager({
    dataDir,
    program: () => fake,
    extraEnv: { THETERMINAL_FAKE_LOGIN: JSON.stringify(script) },
    record: (provider, ok) => recorded.push({ provider, ok }),
    ...over,
  });
  managers.push(m);
  return { m, recorded, dataDir };
}

async function settle(m: SignInManager, id: string, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = m.get(id);
    if (s && s.state !== "running") return s;
    if (Date.now() > until) throw new Error("sign-in did not finish");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("signInLines", () => {
  const clean = (s: string) => s;

  it("keeps URLs on the provider's own domains, device codes and status words", () => {
    const out = signInLines("codex", [
      "\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m",
      "   ABCD-12345",
      "Successfully logged in",
    ].join("\n"), clean);
    expect(out).toEqual(["https://auth.openai.com/codex/device", "ABCD-12345", "Successfully logged in"]);
  });

  it("hides a line that holds an email or a path, and URLs on other domains", () => {
    const out = signInLines("codex", [
      "Logged in as someone@example.com",
      "https://auth.openai.com/authorize?login_hint=someone%40example.com",
      "Wrote credentials to /home/someone/.codex/auth.json",
      "https://evil.example.com/codex/device",
      "https://auth.openai.com.evil.example/codex/device",
      "https://user:pw@auth.openai.com/x",
      "http://auth.openai.com/codex/device",
      "Starting local login server on http://localhost:1455.",
    ].join("\n"), clean);
    expect(out).toEqual([]);
  });

  it("only uses a provider's own domains", () => {
    expect(signInLines("claude", "https://auth.openai.com/codex/device", clean)).toEqual([]);
    expect(signInLines("claude", "visit: \u001b]8;;https://claude.com/cai/oauth/authorize?x=1\u0007link\u001b]8;;\u0007", clean)).toEqual([
      "https://claude.com/cai/oauth/authorize?x=1",
    ]);
  });

  it("hides Claude's paste-the-code link: The Terminal never relays a login code", () => {
    expect(signInLines("claude", "https://claude.com/cai/oauth/authorize?code=true&client_id=x", clean)).toEqual([]);
  });

  it("passes what it shows through the cleaner", () => {
    const out = signInLines("codex", "https://auth.openai.com/codex/device?k=" + KEY, (s) => s.replace(KEY, "[REDACTED]"));
    expect(out).toEqual([]); // the cleaned URL holds a redaction marker, which is not a safe URL
  });
});

describe("SignInManager", { timeout: 15000 }, () => {
  it("starts the login command and reports the safe lines, then success, and records it", async () => {
    const { m, recorded } = manager({ exit: 0 });
    const { id } = m.start("codex");
    expect(m.get(id)?.state).toBe("running");
    const done = await settle(m, id);
    expect(done).toEqual({ state: "succeeded", lines: ["https://auth.openai.com/codex/device", "ABCD-12345"] });
    expect(recorded).toEqual([{ provider: "codex", ok: true }]);
  });

  it("reports a failed login", async () => {
    const { m, recorded } = manager({ exit: 1 });
    const { id } = m.start("codex");
    expect((await settle(m, id)).state).toBe("failed");
    expect(recorded).toEqual([{ provider: "codex", ok: false }]);
  });

  it("never shows a line with an email or a path, nor the user's home", async () => {
    const home = homedir();
    const { m } = manager({ lines: [`Saved to ${home}/.codex/auth.json`, "Logged in as someone@example.com", "ABCD-12345"] });
    const { id } = m.start("codex");
    const done = await settle(m, id);
    expect(done.lines).toEqual(["ABCD-12345"]);
    expect(JSON.stringify(done)).not.toContain(home);
    expect(JSON.stringify(done)).not.toContain("@");
  });

  it("allows one sign-in per provider at a time", async () => {
    const { m } = manager({ hang: true });
    m.start("codex");
    expect(() => m.start("codex")).toThrow(/already running/);
    expect(() => m.start("claude")).not.toThrow();
  });

  it("kills the login after the timeout", async () => {
    const pidFile = join(tempDir(), "pid");
    const { m, recorded } = manager({ hang: true, pidFile }, { timeoutMs: 300 });
    const { id } = m.start("codex");
    const done = await settle(m, id);
    expect(done.state).toBe("failed");
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
    expect(recorded).toEqual([{ provider: "codex", ok: false }]);
  });

  it("kills the login on cancel and on shutdown", async () => {
    const pidA = join(tempDir(), "a");
    const { m, recorded } = manager({ hang: true, pidFile: pidA });
    const { id } = m.start("codex");
    await waitForFile(pidA);
    expect(m.cancel(id)).toBe(true);
    expect((await settle(m, id)).state).toBe("failed");
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(Number(readFileSync(pidA, "utf8")))).toBe(false);
    expect(recorded).toEqual([]); // the Owner stopped it: nothing was attempted
    expect(m.cancel("nope")).toBe(false);

    const pidB = join(tempDir(), "b");
    const second = manager({ hang: true, pidFile: pidB });
    second.m.start("codex");
    await waitForFile(pidB);
    await second.m.shutdown();
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(Number(readFileSync(pidB, "utf8")))).toBe(false);
    expect(second.recorded).toEqual([]); // nothing is recorded while the server shuts down
  });

  it("gives the login an allowlisted environment: no provider keys and no THETERMINAL_* variables", async () => {
    process.env.OPENAI_API_KEY = KEY;
    process.env.THETERMINAL_FAKE_AGENT = "1";
    const envFile = join(tempDir(), "env");
    const { m } = manager({ envFile });
    const { id } = m.start("codex");
    await settle(m, id);
    const names = JSON.parse(readFileSync(envFile, "utf8")) as string[];
    expect(names).not.toContain("OPENAI_API_KEY");
    // Only the test fixture's own script variable, passed explicitly.
    expect(names.filter((n) => n.startsWith("THETERMINAL_"))).toEqual(["THETERMINAL_FAKE_LOGIN"]);
  });

  it("refuses Gemini, whose CLI signs in only in a terminal, and a provider that is not installed", () => {
    const { m } = manager({});
    expect(() => m.start("gemini")).toThrow(/terminal/);
    const missing = manager({}, { program: () => null });
    expect(() => missing.m.start("codex")).toThrow(/not installed/);
  });

  it("status: signed_in on exit 0, signed_out on exit 1, not_installed without the CLI, unknown for Gemini", async () => {
    const signedIn = manager({ status: 0 });
    expect(await signedIn.m.status()).toEqual({ claude: "signed_in", codex: "signed_in", gemini: "unknown" });
    const signedOut = manager({ status: 1 });
    expect(await signedOut.m.status()).toEqual({ claude: "signed_out", codex: "signed_out", gemini: "unknown" });
    const missing = manager({}, { program: () => null });
    expect(await missing.m.status()).toEqual({ claude: "not_installed", codex: "not_installed", gemini: "not_installed" });
    const gone = manager({}, { program: () => ({ file: join(tempDir(), "no-such-cli"), args: [] }) });
    expect((await gone.m.status()).codex).toBe("not_installed");
  });
});

async function waitForFile(f: string) {
  const until = Date.now() + 5000;
  while (!existsSync(f) || readFileSync(f, "utf8") === "") {
    if (Date.now() > until) throw new Error("no pid file");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("sign-in API", { timeout: 15000 }, () => {
  async function start(script: Record<string, unknown>, bundled = { claude: () => null, codex: () => fake, gemini: () => null }) {
    process.env.THETERMINAL_FAKE_AGENT = "1";
    process.env.THETERMINAL_FAKE_LOGIN = JSON.stringify(script);
    const s = await createServer({ dataDir: tempDir(), port: 0, which: () => null, bundled, secrets: new MemorySecretStore() });
    running.push(s);
    return s;
  }
  const call = (s: RunningServer, method: string, path: string) =>
    fetch(`http://127.0.0.1:${s.port}${path}`, { method, headers: { authorization: `Bearer ${s.token}` } });

  it("runs a sign-in, shows only the safe lines, and the ledger holds only connection.signin", async () => {
    const s = await start({ exit: 0, lines: ["https://auth.openai.com/codex/device", "ABCD-12345", "Logged in as someone@example.com"] });
    const res = await call(s, "POST", "/api/connections/signin/codex");
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    let body: { state: string; lines: string[] };
    for (;;) {
      body = (await (await call(s, "GET", `/api/connections/signin/${id}`)).json()) as typeof body;
      if (body.state !== "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(body).toEqual({ state: "succeeded", lines: ["https://auth.openai.com/codex/device", "ABCD-12345"] });

    const entries = (await (await call(s, "GET", "/api/ledger")).json()) as LedgerEntry[];
    expect(entries.map((e) => e.type)).toEqual(["connection.signin"]);
    expect(entries[0]!.payload).toEqual({ provider: "codex", ok: true });
  });

  it("answers 409 while a sign-in for the provider runs, and 404 for an unknown id", async () => {
    const s = await start({ hang: true });
    expect((await call(s, "POST", "/api/connections/signin/codex")).status).toBe(202);
    const again = await call(s, "POST", "/api/connections/signin/codex");
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "signin_running" });
    expect((await call(s, "GET", "/api/connections/signin/nope")).status).toBe(404);
    expect((await call(s, "POST", "/api/connections/signin/github")).status).toBe(400);
  });

  it("cancels a sign-in", async () => {
    const s = await start({ hang: true });
    const { id } = (await (await call(s, "POST", "/api/connections/signin/codex")).json()) as { id: string };
    expect((await call(s, "DELETE", `/api/connections/signin/${id}`)).status).toBe(204);
    const body = (await (await call(s, "GET", `/api/connections/signin/${id}`)).json()) as { state: string };
    expect(body.state).toBe("failed");
  });

  it("signin-status reports not_installed when a CLI is missing, and refuses a sign-in for it", async () => {
    const s = await start({ status: 0 });
    expect(await (await call(s, "GET", "/api/connections/signin-status")).json()).toEqual({
      claude: "not_installed", codex: "signed_in", gemini: "not_installed",
    });
    const res = await call(s, "POST", "/api/connections/signin/claude");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "not_installed" });
    const gem = await call(s, "POST", "/api/connections/signin/gemini");
    expect(gem.status).toBe(422);
    expect(await gem.json()).toEqual({ error: "terminal_required" });
  });

  it("requires the token", async () => {
    const s = await start({});
    const res = await fetch(`http://127.0.0.1:${s.port}/api/connections/signin-status`);
    expect(res.status).toBe(401);
  });
});
