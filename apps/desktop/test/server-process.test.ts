import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createLogSink, ServerStartError, startServer, terminateChild, type ServerHandle } from "../src/server-process.js";

const cliFile = fileURLToPath(new URL("./fixtures/fake-server.mjs", import.meta.url));
const handles: ServerHandle[] = [];
const dirs: string[] = [];

const posix = process.platform !== "win32";
type StartOpts = {
  logFile?: string;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  nodeFile?: string;
  extraArgs?: string[];
};

function start(mode: string, o: StartOpts = {}) {
  const { env = { ...process.env }, nodeFile = process.execPath, extraArgs = [], ...rest } = o;
  const h = startServer({ nodeFile, cliFile, args: [mode, ...extraArgs], env, ...rest });
  handles.push(h);
  return h;
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("startServer", () => {
  it("resolves ready with the child's ready message", async () => {
    const h = start("ready");
    expect(h.pid).toBeTypeOf("number");
    await expect(h.ready).resolves.toEqual({
      type: "ready",
      url: "http://127.0.0.1:4321/?token=fake",
      loopbackUrl: "http://127.0.0.1:4321/",
      port: 4321,
    });
  });

  it("rejects with ServerStartError carrying the exit code and stderr tail when the child exits first", async () => {
    const h = start("fail");
    const err = await h.ready.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServerStartError);
    expect((err as ServerStartError).exitCode).toBe(3);
    expect((err as ServerStartError).detail).toContain("boom");
    await expect(h.exited).resolves.toEqual({ code: 3, signal: null });
  });

  it("rejects after readyTimeoutMs and kills the child", async () => {
    const h = start("hang", { readyTimeoutMs: 500 });
    const err = await h.ready.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServerStartError);
    expect((err as ServerStartError).detail).toBe("timed out waiting for the server");
    expect((err as ServerStartError).exitCode).toBeNull();
    await h.exited;
  });

  it("stop() sends shutdown and resolves after a clean exit", async () => {
    const h = start("ready");
    await h.ready;
    await h.stop();
    await expect(h.exited).resolves.toEqual({ code: 0, signal: null });
  });

  it("stop() kills a child that ignores shutdown after stopTimeoutMs", async () => {
    const h = start("ignore-shutdown", { stopTimeoutMs: 300 });
    await h.ready;
    const t0 = Date.now();
    await h.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    const { code, signal } = await h.exited;
    expect(code).not.toBe(0);
    if (posix) expect(signal).toBe("SIGTERM");
  });

  it("writes child output to the log file, truncated at start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-desktop-log-"));
    dirs.push(dir);
    const logFile = join(dir, "server.log");
    writeFileSync(logFile, "stale content from an earlier run\n");
    const h = start("ready", { logFile });
    await h.ready;
    await h.stop();
    const log = readFileSync(logFile, "utf8");
    expect(log).not.toContain("stale content");
    expect(log).toContain("fake server is running");
  });

  it.skipIf(!posix)("escalates to SIGKILL when the child ignores SIGTERM for the grace period", async () => {
    const h = start("ignore-sigterm", { stopTimeoutMs: 200, killGraceMs: 300 });
    await h.ready;
    await h.stop();
    await expect(h.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });

  it.skipIf(!posix)("escalates a ready timeout to SIGKILL too", async () => {
    const h = start("hang-ignore-sigterm", { readyTimeoutMs: 500, killGraceMs: 300 });
    await expect(h.ready).rejects.toMatchObject({ detail: "timed out waiting for the server" });
    await expect(h.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });

  it("resolves exited and stop() even when a detached grandchild keeps stdout open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-desktop-gc-"));
    dirs.push(dir);
    const pidFile = join(dir, "grandchild.pid");
    const h = start("grandchild", { extraArgs: [pidFile], logFile: join(dir, "server.log") });
    try {
      await h.ready;
      const t0 = Date.now();
      await h.stop();
      await expect(h.exited).resolves.toEqual({ code: 0, signal: null });
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")));
      } catch {
        // already gone
      }
    }
  });

  it("rejects with a null exitCode and the reason when the spawn itself fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-desktop-missing-"));
    dirs.push(dir);
    const h = start("ready", { nodeFile: join(dir, "no-such-node") });
    const err = await h.ready.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServerStartError);
    expect((err as ServerStartError).exitCode).toBeNull();
    expect((err as ServerStartError).detail).toContain("ENOENT");
    expect((err as ServerStartError).message).toContain("ENOENT");
    await expect(h.exited).resolves.toEqual({ code: null, signal: null });
    await h.stop();
  });

  it("keeps ready resolved when the child exits after it", async () => {
    const h = start("ready-then-exit");
    await expect(h.ready).resolves.toMatchObject({ type: "ready", port: 4321 });
    await expect(h.exited).resolves.toEqual({ code: 5, signal: null });
  });

  it("rejects ready when stop() runs mid-startup", async () => {
    const h = start("hang", { stopTimeoutMs: 200 });
    await h.stop();
    await expect(h.ready).rejects.toBeInstanceOf(ServerStartError);
  });

  it("passes exactly the given env to the child", async () => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TT_TEST_VALUE: "reached" };
    if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
    expect(process.env.VITEST).toBeDefined();
    const h = start("env", { env });
    const m = await h.ready;
    expect(m.url).toContain("value=reached");
    expect(m.url).toContain("vitest=unset");
  });

  it("ignores malformed ready messages", async () => {
    const h = start("bad-ready");
    await expect(h.ready).resolves.toEqual({
      type: "ready",
      url: "http://127.0.0.1:2/",
      loopbackUrl: "http://127.0.0.1:2/",
      port: 2,
    });
  });
});

describe("terminateChild", () => {
  class FakeChild extends EventEmitter {
    pid: number | undefined = 1234;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    signals: (NodeJS.Signals | undefined)[] = [];
    constructor(private readonly diesOn: NodeJS.Signals | "never") {
      super();
    }
    kill(signal?: NodeJS.Signals) {
      this.signals.push(signal);
      if (this.diesOn === (signal ?? "SIGTERM")) {
        this.signalCode = signal ?? "SIGTERM";
        setImmediate(() => this.emit("exit", null, this.signalCode));
      }
      return true;
    }
  }

  it("stops at SIGTERM when the child exits within the grace", async () => {
    const c = new FakeChild("SIGTERM");
    const runs: [string, string[]][] = [];
    await terminateChild(c, { graceMs: 1000, platform: "darwin", run: (f, a) => runs.push([f, a]) });
    expect(c.signals).toEqual([undefined]);
    expect(runs).toEqual([]);
  });

  it("sends SIGKILL after the grace on POSIX", async () => {
    const c = new FakeChild("never");
    const runs: [string, string[]][] = [];
    await terminateChild(c, { graceMs: 50, platform: "linux", run: (f, a) => runs.push([f, a]) });
    expect(c.signals).toEqual([undefined, "SIGKILL"]);
    expect(runs).toEqual([]);
  });

  it("runs taskkill on the process tree after the grace on win32", async () => {
    const c = new FakeChild("never");
    const runs: [string, string[]][] = [];
    await terminateChild(c, { graceMs: 50, platform: "win32", run: (f, a) => runs.push([f, a]) });
    expect(c.signals).toEqual([undefined]);
    expect(runs).toEqual([["taskkill", ["/PID", "1234", "/T", "/F"]]]);
  });

  it("does nothing for a child that has already exited", async () => {
    const c = new FakeChild("never");
    c.exitCode = 0;
    await terminateChild(c, { graceMs: 50, platform: "linux", run: () => {} });
    expect(c.signals).toEqual([]);
  });
});

describe("createLogSink", () => {
  class FakeStream extends EventEmitter {
    writableNeedDrain = false;
    writes: string[] = [];
    ended = false;
    write(chunk: Buffer | string) {
      this.writes.push(chunk.toString());
      return true;
    }
    end(cb?: () => void) {
      this.ended = true;
      cb?.();
      return this;
    }
  }

  it("drops chunks while the stream needs a drain and notes the dropped bytes once at the end", async () => {
    const s = new FakeStream();
    const sink = createLogSink(s);
    sink.write(Buffer.from("first\n"));
    s.writableNeedDrain = true;
    sink.write(Buffer.from("12345"));
    sink.write(Buffer.from("678"));
    s.writableNeedDrain = false;
    sink.write(Buffer.from("last\n"));
    await sink.close();
    expect(s.writes.slice(0, 2)).toEqual(["first\n", "last\n"]);
    expect(s.writes).toHaveLength(3);
    expect(s.writes[2]).toMatch(/dropped 8 bytes/);
    expect(s.ended).toBe(true);
  });

  it("adds no note when nothing was dropped, and ignores writes after close", async () => {
    const s = new FakeStream();
    const sink = createLogSink(s);
    sink.write(Buffer.from("a"));
    await sink.close();
    sink.write(Buffer.from("b"));
    expect(s.writes).toEqual(["a"]);
  });
});
