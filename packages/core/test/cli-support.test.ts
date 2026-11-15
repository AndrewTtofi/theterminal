import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DataDirInUseError } from "../src/server/data-dir-lock.js";
import {
  SHUTDOWN_FAILED,
  SHUTDOWN_TIMED_OUT,
  START_FAILED,
  createShutdown,
  startErrorLine,
  writeStartLog,
} from "../src/cli-support.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "tt-cli-support-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("startErrorLine", () => {
  it("keeps the data-folder-in-use message, which holds no path or pid", () => {
    expect(startErrorLine(new DataDirInUseError())).toBe(
      "The Terminal could not start: Another The Terminal server is already using this data folder.",
    );
  });

  it("prints a fixed line for every other error, never its message", () => {
    expect(startErrorLine(new Error("EACCES: permission denied, open '/somewhere/private'"))).toBe(START_FAILED);
    expect(startErrorLine("a thrown string")).toBe(START_FAILED);
    expect(START_FAILED).toBe("The Terminal could not start. See the log for details.");
  });
});

describe("writeStartLog", () => {
  it("writes the scrubbed, redacted detail to logs/server-start.log with mode 0600", () => {
    const dataDir = tmp();
    const token = "f".repeat(64);
    writeFileSync(join(dataDir, "token"), token);
    const err = new Error(
      `boom in ${join(dataDir, "ledger.db")} under ${join(homedir(), "x")} key sk-ant-${"a".repeat(20)} env ${"s3cretvalue"} token ${token}`,
    );
    writeStartLog(dataDir, err, { MY_API_KEY: "s3cretvalue" });
    const file = join(dataDir, "logs", "server-start.log");
    const text = readFileSync(file, "utf8");
    expect(text).toContain("boom in <data>");
    expect(text).toContain("~");
    expect(text).not.toContain(dataDir);
    expect(text).not.toContain(homedir());
    expect(text).not.toContain("sk-ant-");
    expect(text).not.toContain("s3cretvalue");
    expect(text).not.toContain(token);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("tightens an existing log to 0600 and never throws when the folder cannot be written", () => {
    const dataDir = tmp();
    writeStartLog(dataDir, new Error("first"));
    const file = join(dataDir, "logs", "server-start.log");
    if (process.platform !== "win32") {
      writeFileSync(file, "old", { mode: 0o644 });
      writeStartLog(dataDir, new Error("second"));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, "utf8")).toContain("second");
    }
    const notADir = join(dataDir, "plain-file");
    writeFileSync(notADir, "");
    expect(() => writeStartLog(notADir, new Error("x"))).not.toThrow();
    expect(existsSync(join(notADir, "logs"))).toBe(false);
  });
});

describe("createShutdown", () => {
  const deps = (close: () => Promise<void>) => ({
    close: vi.fn(close),
    releaseLock: vi.fn(),
    exit: vi.fn(),
    fail: vi.fn(),
    timeoutMs: 20,
  });

  it("closes once and exits 0, however often it is called", async () => {
    const d = deps(() => Promise.resolve());
    const shutdown = createShutdown(d);
    shutdown();
    shutdown();
    await vi.waitFor(() => expect(d.exit).toHaveBeenCalledWith(0));
    expect(d.close).toHaveBeenCalledTimes(1);
    expect(d.fail).not.toHaveBeenCalled();
  });

  it("a close that rejects fails with a fixed line and no stack", async () => {
    const d = deps(() => Promise.reject(new Error("secret detail")));
    createShutdown(d)();
    await vi.waitFor(() => expect(d.fail).toHaveBeenCalledWith(SHUTDOWN_FAILED));
    expect(d.exit).not.toHaveBeenCalled();
  });

  it("a close that never resolves releases the lock and fails after the timeout, on an unref'd timer", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const d = deps(() => new Promise<void>(() => undefined));
    createShutdown(d)();
    const timer = timers.mock.results[0]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    await vi.waitFor(() => expect(d.fail).toHaveBeenCalledWith(SHUTDOWN_TIMED_OUT));
    expect(d.releaseLock).toHaveBeenCalledTimes(1);
    expect(d.exit).not.toHaveBeenCalled();
  });

  it("a lock release that throws still fails", async () => {
    const d = deps(() => new Promise<void>(() => undefined));
    d.releaseLock.mockImplementation(() => {
      throw new Error("EPERM");
    });
    createShutdown(d)();
    await vi.waitFor(() => expect(d.fail).toHaveBeenCalledWith(SHUTDOWN_TIMED_OUT));
  });

  it("the default timeout is 10 s", () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const { timeoutMs: _omit, ...rest } = deps(() => new Promise<void>(() => undefined));
    createShutdown(rest)();
    expect(timers.mock.calls[0]![1]).toBe(10_000);
    clearTimeout(timers.mock.results[0]!.value as NodeJS.Timeout);
  });
});
