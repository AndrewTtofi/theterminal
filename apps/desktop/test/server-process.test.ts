import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ServerStartError, startServer, type ServerHandle } from "../src/server-process.js";

const cliFile = fileURLToPath(new URL("./fixtures/fake-server.mjs", import.meta.url));
const handles: ServerHandle[] = [];
const dirs: string[] = [];

function start(mode: string, o: { logFile?: string; readyTimeoutMs?: number; stopTimeoutMs?: number } = {}) {
  const h = startServer({ nodeFile: process.execPath, cliFile, args: [mode], env: { ...process.env }, ...o });
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
    const { code } = await h.exited;
    expect(code).not.toBe(0);
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
});
