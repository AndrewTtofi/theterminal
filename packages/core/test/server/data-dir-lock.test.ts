import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataDirInUseError, acquireDataDirLock } from "../../src/server/data-dir-lock.js";
import { createServer, type RunningServer } from "../../src/server/server.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";

const IN_USE = "Another The Terminal server is already using this data folder.";
const tmp = () => mkdtempSync(join(tmpdir(), "tt-lock-"));
const lockFile = (dir: string) => join(dir, "server.lock");

describe("acquireDataDirLock", () => {
  it("acquires server.lock with our pid and releases it", () => {
    const dir = tmp();
    const lock = acquireDataDirLock(dir, 111);
    expect(readFileSync(lockFile(dir), "utf8")).toBe("111\n");
    lock.release();
    expect(existsSync(lockFile(dir))).toBe(false);
  });

  it("a lock held by a live process is refused", () => {
    const dir = tmp();
    writeFileSync(lockFile(dir), "222\n");
    let caught: unknown;
    try {
      acquireDataDirLock(dir, 111, () => true);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DataDirInUseError);
    expect((caught as Error).message).toBe(IN_USE);
    expect(readFileSync(lockFile(dir), "utf8")).toBe("222\n");
  });

  it("a lock whose process is gone is taken over", () => {
    const dir = tmp();
    writeFileSync(lockFile(dir), "222\n");
    const seen: number[] = [];
    acquireDataDirLock(dir, 111, (pid) => (seen.push(pid), false));
    expect(seen).toEqual([222]);
    expect(readFileSync(lockFile(dir), "utf8")).toBe("111\n");
  });

  it("an unreadable or garbage lock counts as stale", () => {
    const dir = tmp();
    writeFileSync(lockFile(dir), "not a pid");
    acquireDataDirLock(dir, 111, () => true);
    expect(readFileSync(lockFile(dir), "utf8")).toBe("111\n");
  });

  it("release leaves a lock that is no longer ours", () => {
    const dir = tmp();
    const lock = acquireDataDirLock(dir, 111);
    writeFileSync(lockFile(dir), "333\n");
    lock.release();
    expect(readFileSync(lockFile(dir), "utf8")).toBe("333\n");
  });

  it("the default liveness check treats this process as alive", () => {
    const dir = tmp();
    writeFileSync(lockFile(dir), `${process.pid}\n`);
    expect(() => acquireDataDirLock(dir, 111)).toThrow(DataDirInUseError);
  });
});

describe("createServer and the data folder lock", () => {
  const running: RunningServer[] = [];
  afterEach(async () => {
    while (running.length) await running.pop()!.close().catch(() => undefined);
  });
  const opts = (dataDir: string, port: number) => ({ dataDir, port, which: () => null, secrets: new MemorySecretStore() });

  it("a second server on the same data folder is refused while the first runs", async () => {
    const dataDir = tmp();
    const s1 = await createServer(opts(dataDir, 0));
    running.push(s1);
    await expect(createServer(opts(dataDir, 0))).rejects.toBeInstanceOf(DataDirInUseError);
    await s1.close();
    running.pop();
    expect(existsSync(lockFile(dataDir))).toBe(false);
    running.push(await createServer(opts(dataDir, 0)));
  });

  it("a failed start releases the lock", async () => {
    const dataDir = tmp();
    await expect(createServer(opts(dataDir, 70000))).rejects.toThrow();
    expect(existsSync(lockFile(dataDir))).toBe(false);
    running.push(await createServer(opts(dataDir, 0)));
  });
});
