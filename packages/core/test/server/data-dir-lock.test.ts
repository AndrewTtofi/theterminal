import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataDirInUseError, acquireDataDirLock, releaseDataDirLock } from "../../src/server/data-dir-lock.js";
import { createServer, type RunningServer } from "../../src/server/server.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { fakeDiscovery } from "../../src/link/discovery.js";
import type { Db } from "../../src/db.js";

/** Every database the server opens, so a test can check that a failed start closed it. */
const opened = vi.hoisted(() => [] as unknown[]);
vi.mock("../../src/db.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/db.js")>();
  return {
    ...actual,
    openDatabase: (...args: Parameters<typeof actual.openDatabase>) => {
      const db = actual.openDatabase(...args);
      opened.push(db);
      return db;
    },
  };
});

const IN_USE = "Another The Terminal server is already using this data folder.";
const tmp = () => mkdtempSync(join(tmpdir(), "tt-lock-"));
const lockFile = (dir: string) => join(dir, "server.lock");
/** Backdates a file well past the young-lock grace period. */
const age = (file: string) => utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
/** Every file in the folder: no temp or stale files may be left behind. */
const files = (dir: string) => readdirSync(dir).sort();

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
    age(lockFile(dir));
    acquireDataDirLock(dir, 111, () => true);
    expect(readFileSync(lockFile(dir), "utf8")).toBe("111\n");
    expect(files(dir)).toEqual(["server.lock"]);
  });

  it("an empty lock file that is still young counts as live (its writer may be mid-publish)", () => {
    const dir = tmp();
    writeFileSync(lockFile(dir), "");
    expect(() => acquireDataDirLock(dir, 111, () => false)).toThrow(DataDirInUseError);
    expect(readFileSync(lockFile(dir), "utf8")).toBe("");
  });

  it("a takeover race: the loser gets DataDirInUseError and never deletes the winner's live lock", () => {
    const dir = tmp();
    writeFileSync(lockFile(dir), "222\n");
    let caught: unknown;
    try {
      // While the second process judges 222 dead, a first process takes the stale lock over for itself.
      acquireDataDirLock(dir, 111, (pid) => {
        if (pid === 222) acquireDataDirLock(dir, 444, () => false);
        return pid !== 222;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DataDirInUseError);
    expect((caught as Error).message).toBe(IN_USE);
    expect(readFileSync(lockFile(dir), "utf8")).toBe("444\n");
    expect(files(dir)).toEqual(["server.lock"]);
  });

  it("leaves no temp file behind when the lock is held", () => {
    const dir = tmp();
    writeFileSync(lockFile(dir), "222\n");
    expect(() => acquireDataDirLock(dir, 111, () => true)).toThrow(DataDirInUseError);
    expect(files(dir)).toEqual(["server.lock"]);
  });

  it("release when the lock file is already gone does nothing", () => {
    const dir = tmp();
    const lock = acquireDataDirLock(dir, 111);
    rmSync(lockFile(dir));
    expect(() => lock.release()).not.toThrow();
    expect(existsSync(lockFile(dir))).toBe(false);
  });

  it("release leaves a lock that is no longer ours", () => {
    const dir = tmp();
    const lock = acquireDataDirLock(dir, 111);
    writeFileSync(lockFile(dir), "333\n");
    lock.release();
    expect(readFileSync(lockFile(dir), "utf8")).toBe("333\n");
  });

  it("releaseDataDirLock removes the lock only while it names the given pid, and never throws", () => {
    const dir = tmp();
    acquireDataDirLock(dir, 111);
    releaseDataDirLock(dir, 222);
    expect(readFileSync(lockFile(dir), "utf8")).toBe("111\n");
    releaseDataDirLock(dir, 111);
    expect(existsSync(lockFile(dir))).toBe(false);
    expect(() => releaseDataDirLock(dir, 111)).not.toThrow();
    expect(() => releaseDataDirLock(join(dir, "missing"), 111)).not.toThrow();
  });

  it("a lock naming this process's own pid, which this process does not hold, is stale (PID 1 in a container)", () => {
    // After docker kill or an OOM kill the lock names 1, and the next start is PID 1 again: it cannot be the holder.
    const dir = tmp();
    writeFileSync(lockFile(dir), `${process.pid}\n`);
    const lock = acquireDataDirLock(dir);
    expect(readFileSync(lockFile(dir), "utf8")).toBe(`${process.pid}\n`);
    expect(files(dir)).toEqual(["server.lock"]);
    lock.release();
    expect(existsSync(lockFile(dir))).toBe(false);
  });

  it("a lock naming another live pid is still refused by the default liveness check", () => {
    const dir = tmp();
    writeFileSync(lockFile(dir), `${process.ppid}\n`); // the test runner's parent: alive and not us
    expect(() => acquireDataDirLock(dir)).toThrow(DataDirInUseError);
    expect(readFileSync(lockFile(dir), "utf8")).toBe(`${process.ppid}\n`);
  });

  it("a lock this process holds itself is refused, and free again once released", () => {
    const dir = tmp();
    const lock = acquireDataDirLock(dir);
    expect(() => acquireDataDirLock(dir)).toThrow(DataDirInUseError);
    expect(() => acquireDataDirLock(join(dir, "."))).toThrow(DataDirInUseError);
    lock.release();
    acquireDataDirLock(dir).release();
    expect(existsSync(lockFile(dir))).toBe(false);
  });
});

/**
 * Each test here starts and closes whole servers (up to three), which take tens of milliseconds on a quiet machine but
 * seconds each on a loaded Windows runner, where even the sync lock tests above take most of a second.
 */
const WIN32 = process.platform === "win32";
const SERVER_TEST_TIMEOUT_MS = WIN32 ? 40_000 : 15_000;

describe("createServer and the data folder lock", { timeout: SERVER_TEST_TIMEOUT_MS }, () => {
  const running: RunningServer[] = [];
  afterEach(async () => {
    while (running.length) await running.pop()!.close().catch(() => undefined);
  }, SERVER_TEST_TIMEOUT_MS);
  const opts = (dataDir: string, port: number) => ({ dataDir, port, which: () => null, secrets: new MemorySecretStore(), discovery: fakeDiscovery() });

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

  it("close() twice resolves and leaves the folder unlocked", async () => {
    const dataDir = tmp();
    const s = await createServer(opts(dataDir, 0));
    await s.close();
    await expect(s.close()).resolves.toBeUndefined();
    expect(existsSync(lockFile(dataDir))).toBe(false);
  });

  it("a start that fails after the ledger opened closes it and releases the lock", async () => {
    const dataDir = tmp();
    mkdirSync(join(dataDir, "token")); // reading the token then fails, after openDatabase
    opened.length = 0;
    await expect(createServer(opts(dataDir, 0))).rejects.toThrow();
    expect(opened).toHaveLength(1);
    expect((opened[0] as Db).open).toBe(false);
    expect(existsSync(lockFile(dataDir))).toBe(false);
  });

  it("a failed start releases the lock", async () => {
    const dataDir = tmp();
    await expect(createServer(opts(dataDir, 70000))).rejects.toThrow();
    expect(existsSync(lockFile(dataDir))).toBe(false);
    running.push(await createServer(opts(dataDir, 0)));
  });
});
