import { execFile, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redact } from "../../src/agents/redact.js";
import {
  frameable,
  freePort,
  isExposed,
  listeningAddresses,
  probe,
  startSupervised,
  waitReady,
  type Supervised,
} from "../../src/preview/process.js";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-site.mjs");
const SECRET = "sk-ant-TESTKEY-0000000000";

/** The few variables node needs to start and use the network, on every platform. */
function minimalEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const keep = new Set(["path", "systemroot", "windir", "temp", "tmp"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (keep.has(name.toLowerCase())) env[name] = value;
  return { ...env, ...extra };
}

const started: Supervised[] = [];
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.kill()));
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function site(extra: Record<string, string>): Supervised {
  const s = startSupervised(
    { file: process.execPath, args: [SITE] },
    { cwd: tmpdir(), env: minimalEnv(extra), clean: (t) => redact(t) },
  );
  started.push(s);
  return s;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function fileText(path: string): Promise<string> {
  await vi.waitFor(() => expect(existsSync(path) && readFileSync(path, "utf8").length > 0).toBe(true), { timeout: 10_000 });
  return readFileSync(path, "utf8");
}

describe("freePort", () => {
  it("gives a port nothing listens on", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
    expect(await probe(port, { timeoutMs: 500 })).toBeNull();
  });
});

describe("waitReady", () => {
  it("reports the port open, then the first page loaded, and gives the loopback origin", async () => {
    const port = await freePort();
    site({ PORT: String(port), HOST: "127.0.0.1", FAKE_SITE_DELAY_MS: "300" });
    const stages: string[] = [];
    const ready = await waitReady([port], {
      deadline: Date.now() + 20_000,
      signal: new AbortController().signal,
      onStage: (s) => stages.push(s),
    });
    expect(stages).toEqual(["open", "loaded"]);
    expect(ready?.origin).toBe(`http://127.0.0.1:${port}`);
    expect(ready?.headers["content-type"]).toBe("text/html");
  }, 30_000);

  it("finds a site on ::1 when 127.0.0.1 is closed", async (ctx) => {
    const port = await freePort();
    const v6 = createServer();
    const ok = await new Promise<boolean>((res) => {
      v6.once("error", () => res(false));
      v6.listen(port, "::1", () => res(true));
    });
    if (!ok) return ctx.skip(); // no IPv6 loopback on this machine
    await new Promise((r) => v6.close(r));
    site({ PORT: String(port), HOST: "::1" });
    const ready = await waitReady([port], { deadline: Date.now() + 20_000, signal: new AbortController().signal, onStage: () => undefined });
    expect(ready?.origin).toBe(`http://[::1]:${port}`);
  }, 30_000);

  it("tries the stated port after the chosen one", async () => {
    const [chosen, stated] = [await freePort(), await freePort()];
    site({ PORT: String(stated) });
    const ready = await waitReady([chosen, stated], { deadline: Date.now() + 20_000, signal: new AbortController().signal, onStage: () => undefined });
    expect(ready?.origin).toBe(`http://127.0.0.1:${stated}`);
  }, 30_000);

  it("gives null once the deadline passes, and never reports the page loaded", async () => {
    const port = await freePort();
    let t = 1_000_000;
    const stages: string[] = [];
    const sleeps: number[] = [];
    const ready = await waitReady([port], {
      deadline: t + 3000,
      signal: new AbortController().signal,
      onStage: (s) => stages.push(s),
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    expect(ready).toBeNull();
    expect(stages).not.toContain("loaded");
    expect(sleeps.every((ms) => ms === 500)).toBe(true);
    expect(sleeps.length).toBeGreaterThanOrEqual(5);
  });

  it("reports a port that accepts but never answers as open only", async () => {
    const port = await freePort();
    const silent = createServer((c) => c.resume()); // reads, never answers
    servers.push(silent);
    await new Promise<void>((r) => silent.listen(port, "127.0.0.1", r));
    let t = 0;
    const stages: string[] = [];
    const ready = await waitReady([port], {
      deadline: 1,
      signal: new AbortController().signal,
      onStage: (s) => stages.push(s),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(ready).toBeNull();
    expect(stages).toEqual(["open"]);
  }, 20_000);

  it("stops at once when aborted", async () => {
    const port = await freePort();
    const ac = new AbortController();
    ac.abort();
    const ready = await waitReady([port], { deadline: Date.now() + 60_000, signal: ac.signal, onStage: () => undefined });
    expect(ready).toBeNull();
  });
});

describe("probe", () => {
  it("reads the first page's status and headers", async () => {
    const port = await freePort();
    site({ PORT: String(port), FAKE_SITE_NOFRAME: "1" });
    await vi.waitFor(async () => expect(await probe(port)).not.toBeNull(), { timeout: 10_000, interval: 100 });
    const r = await probe(port);
    expect(r).toMatchObject({ origin: `http://127.0.0.1:${port}`, status: 200 });
    expect(frameable((r as { headers: Record<string, string> }).headers)).toBe(false);
  }, 20_000);

  it("says open when TCP connects but HTTP does not answer in time", async () => {
    const port = await freePort();
    const silent = createServer((c) => c.resume()); // reads, never answers
    servers.push(silent);
    await new Promise<void>((r) => silent.listen(port, "127.0.0.1", r));
    expect(await probe(port, { timeoutMs: 300 })).toBe("open");
  });
});

describe("startSupervised", () => {
  it("kills the tree and keeps a redacted tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-site-"));
    dirs.push(dir);
    const lines = Array.from({ length: 29 }, (_, i) => `line ${i + 1}`);
    lines.push(`token ${SECRET}`);
    const pidFile = join(dir, "grandchild");
    const s = site({ PORT: String(await freePort()), FAKE_SITE_PRINT: `${lines.join("\n")}\n`, FAKE_SITE_GRANDCHILD: pidFile });
    const seen: string[] = [];
    s.onLine((l) => seen.push(l));
    const grandchild = Number(await fileText(pidFile));
    const parent = Number(await fileText(`${pidFile}.parent`));
    expect(parent).toBe(s.pid);
    await vi.waitFor(() => expect(s.tail()).toHaveLength(20), { timeout: 10_000 });
    const tail = s.tail();
    expect(tail[0]).toBe("line 11");
    expect(tail[19]).toContain("[REDACTED]");
    expect(tail.join("\n")).not.toContain("TESTKEY");
    expect(seen).toHaveLength(30);
    expect(alive(grandchild)).toBe(true);

    await s.kill();
    // taskkill on Windows returns once the tree is told to go; the processes can take a moment to be gone.
    await vi.waitFor(() => expect([alive(parent), alive(grandchild)]).toEqual([false, false]), { timeout: 10_000, interval: 100 });
    expect(await s.exited).toBeDefined();
  }, 30_000);

  it("clips each line to 300 characters and shows control characters", async () => {
    const s = site({ FAKE_SITE_EXIT: "0", FAKE_SITE_PRINT: `${"x".repeat(1000)}\nbell\u0007\r\n\u001b[32mgreen\u001b[0m\nlast without a break` });
    await s.exited;
    await vi.waitFor(() => expect(s.tail()).toHaveLength(4));
    const [long, bell, green, last] = s.tail();
    expect(long!.length).toBe(300);
    expect(bell).toBe("bell\\u0007");
    expect(green).toBe("green");
    expect(last).toBe("last without a break");
  });

  it("resolves exited with the code of a site that exits at once", async () => {
    const s = site({ FAKE_SITE_EXIT: "3" });
    expect(await s.exited).toEqual({ code: 3, signal: null });
    await s.kill(); // already gone: nothing to do, and it does not hang
  });

  it("resolves exited for a program that cannot be started, without a path in the tail", async () => {
    const s = startSupervised(
      { file: join(tmpdir(), "no-such-program-tt"), args: [] },
      { cwd: tmpdir(), env: minimalEnv({}), clean: (t) => t },
    );
    started.push(s);
    expect(await s.exited).toEqual({ code: null, signal: null });
    expect(s.tail().join("\n")).not.toContain("no-such-program-tt");
    expect(s.tail()[0]).toMatch(/could not be started/);
  });

  it("spawns with an argument array, no shell, hidden windows, and its own group on POSIX", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const calls: { file: string; args: readonly string[]; opts: Record<string, unknown> }[] = [];
      const fake = ((file: string, args: readonly string[], opts: Record<string, unknown>) => {
        calls.push({ file, args, opts });
        throw Object.assign(new Error("nope"), { code: "ENOENT" });
      }) as unknown as typeof import("node:child_process").spawn;
      const s = startSupervised({ file: "prog", args: ["a b", "c"] }, { cwd: "here", env: { A: "1" }, clean: (t) => t, spawn: fake, platform });
      expect(calls[0]!.file).toBe("prog");
      expect(calls[0]!.args).toEqual(["a b", "c"]);
      expect(calls[0]!.opts).toMatchObject({ cwd: "here", env: { A: "1" }, shell: false, windowsHide: true, detached: platform !== "win32" });
      void s.exited;
    }
  });

  it("on Windows kills with taskkill /T /F and waits for the exit", async () => {
    const execCalls: { file: string; args: readonly string[] }[] = [];
    let child: (ChildProcess & { emitExit: () => void }) | undefined;
    const fakeSpawn = (() => {
      const c = new EventEmitter() as ChildProcess & { emitExit: () => void };
      Object.assign(c, { pid: 4242, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
      c.kill = () => true;
      c.emitExit = () => {
        Object.assign(c, { exitCode: 1 });
        (c.stdout as PassThrough).end();
        (c.stderr as PassThrough).end();
        c.emit("exit", 1, null);
        c.emit("close", 1, null);
      };
      child = c;
      return c;
    }) as unknown as typeof import("node:child_process").spawn;
    const fakeExec = ((file: string, args: readonly string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      execCalls.push({ file, args });
      setTimeout(() => {
        cb(null, "", "");
        child!.emitExit(); // taskkill finishes before the process is gone
      }, 20);
      return {} as ChildProcess;
    }) as unknown as typeof execFile;
    const s = startSupervised({ file: "site.exe", args: [] }, { cwd: ".", env: {}, clean: (t) => t, spawn: fakeSpawn, execFile: fakeExec, platform: "win32" });
    await s.kill();
    expect(execCalls).toEqual([{ file: "taskkill", args: ["/PID", "4242", "/T", "/F"] }]);
    expect(await s.exited).toEqual({ code: 1, signal: null });
    await s.kill();
    expect(execCalls).toHaveLength(1);
  });
});

describe("frameable", () => {
  it("follows X-Frame-Options and frame-ancestors", () => {
    expect(frameable({ "x-frame-options": "DENY" })).toBe(false);
    expect(frameable({ "x-frame-options": "SAMEORIGIN" })).toBe(false);
    expect(frameable({ "content-security-policy": "frame-ancestors 'self'" })).toBe(false);
    expect(frameable({ "content-security-policy": "default-src 'self'; frame-ancestors 'none'" })).toBe(false);
    expect(frameable({ "content-security-policy": "default-src 'self', frame-ancestors 'self'" })).toBe(false);
    expect(frameable({})).toBe(true);
    expect(frameable({ "content-security-policy": "frame-ancestors *" })).toBe(true);
    expect(frameable({ "content-security-policy": "default-src 'self'; script-src 'self'" })).toBe(true);
    expect(frameable({ "Content-Security-Policy": "FRAME-ANCESTORS 'self'" })).toBe(false);
  });
});

describe("network exposure", () => {
  it("isExposed is true only for a non-loopback address", () => {
    expect(isExposed(["127.0.0.1", "::1"])).toBe(false);
    expect(isExposed([])).toBe(false);
    expect(isExposed(["0.0.0.0"])).toBe(true);
    expect(isExposed(["*"])).toBe(true);
    expect(isExposed(["::"])).toBe(true);
    expect(isExposed(["127.0.0.1", "192.168.1.20"])).toBe(true);
  });

  type Call = { file: string; args: readonly string[]; opts: Record<string, unknown> };
  const recorded = (out: string | Error, calls: Call[] = []) =>
    ((file: string, args: readonly string[], opts: Record<string, unknown>, cb: (e: Error | null, so: string, se: string) => void) => {
      calls.push({ file, args, opts });
      queueMicrotask(() => (out instanceof Error ? cb(out, "", "") : cb(null, out, "")));
      return {} as ChildProcess;
    }) as unknown as typeof execFile;

  it("reads lsof -Fn on macOS and Linux", async () => {
    const calls: Call[] = [];
    const sample = "p4711\nf23\nn*:5173\nf24\nn127.0.0.1:5173\nf25\nn[::1]:5173\nf26\nn127.0.0.1:51730\n";
    for (const platform of ["darwin", "linux"] as const) {
      expect(await listeningAddresses(5173, { platform, execFile: recorded(sample, calls) })).toEqual(["*", "127.0.0.1", "::1"]);
    }
    expect(calls[0]!.file).toBe("lsof");
    expect(calls[0]!.args).toEqual(["-nP", "-iTCP:5173", "-sTCP:LISTEN", "-Fn"]);
    expect(calls[0]!.opts).toMatchObject({ timeout: 5000, shell: false, windowsHide: true });
  });

  it("reads netstat -ano on Windows", async () => {
    const calls: Call[] = [];
    const sample = [
      "",
      "Active Connections",
      "",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1000",
      "  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       4711",
      "  TCP    127.0.0.1:5173         127.0.0.1:50123        ESTABLISHED     4711",
      "  TCP    10.0.0.2:51730         0.0.0.0:0              LISTENING       9",
      "",
    ].join("\r\n");
    expect(await listeningAddresses(5173, { platform: "win32", execFile: recorded(sample, calls) })).toEqual(["0.0.0.0"]);
    expect(calls[0]!.file).toBe("netstat");
    expect(calls[0]!.args).toEqual(["-ano", "-p", "tcp"]);
    expect(calls[0]!.opts).toMatchObject({ timeout: 5000, shell: false, windowsHide: true });
  });

  it("gives [] when the tool fails or is missing", async () => {
    const missing = Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" });
    expect(await listeningAddresses(5173, { platform: "darwin", execFile: recorded(missing) })).toEqual([]);
    expect(await listeningAddresses(5173, { platform: "win32", execFile: recorded(new Error("timed out")) })).toEqual([]);
    const throwing = (() => {
      throw new Error("boom");
    }) as unknown as typeof execFile;
    expect(await listeningAddresses(5173, { platform: "linux", execFile: throwing })).toEqual([]);
  });
});
