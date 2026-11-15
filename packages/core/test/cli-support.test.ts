import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DataDirInUseError } from "../src/server/data-dir-lock.js";
import { KeyInsideDataDirError } from "../src/secrets/file-store.js";
import { RemoteStartError } from "../src/server/remote.js";
import { CertificateError } from "../src/server/certs.js";
import {
  SHUTDOWN_FAILED,
  SHUTDOWN_TIMED_OUT,
  START_FAILED,
  USAGE,
  createShutdown,
  parseStartArgs,
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

  it("keeps the fixed messages of the key-in-data-folder, remote listener and certificate errors", () => {
    expect(startErrorLine(new KeyInsideDataDirError())).toBe("Refusing to start: the secret key file is inside the data directory");
    expect(startErrorLine(new RemoteStartError())).toBe("The Terminal could not start: the remote listener could not start");
    const cert = new CertificateError("unreadable");
    expect(startErrorLine(cert)).toBe(`The Terminal could not start: ${cert.message}`);
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

describe("parseStartArgs", () => {
  const defaults = { dataDir: () => join(tmpdir(), "tt-default-data"), uiDir: () => join(tmpdir(), "tt-default-ui") };
  const parse = (...args: string[]) => parseStartArgs(["start", ...args], defaults);
  const fail = (...args: string[]) => {
    const r = parse(...args);
    if (r.ok) throw new Error("expected a failure");
    return r.message;
  };

  it("names every flag in the usage line", () => {
    for (const flag of [
      "--port", "--data-dir", "--ui-dir", "--core-dir", "--remote", "--remote-port", "--remote-bind", "--remote-domain",
      "--remote-tls", "--tls-cert", "--tls-key", "--secret-store", "--secret-key-file", "--allow-key-in-data-dir",
    ]) {
      expect(USAGE).toContain(`[${flag}`);
    }
    expect(USAGE).toContain("self_signed|acme|provided");
    expect(USAGE).toContain("keychain|file");
  });

  it("with no flags starts locally on the keychain", () => {
    expect(parse()).toEqual({ ok: true, options: { dataDir: defaults.dataDir(), uiDir: defaults.uiDir() } });
  });

  it("refuses an unknown option, a missing command and a bad --port with the usage or a fixed line", () => {
    expect(parseStartArgs(["start", "--nope"], defaults)).toEqual({ ok: false, message: USAGE });
    expect(parseStartArgs([], defaults)).toEqual({ ok: false, message: USAGE });
    expect(fail("--port", "70000")).toBe("Invalid --port: 70000");
    expect(fail("--core-dir", "relative")).toBe("Invalid --core-dir: must be an absolute path");
  });

  it("reads the remote flags", () => {
    const certFile = join(tmpdir(), "cert.pem");
    const keyFile = join(tmpdir(), "key.pem");
    const r = parse("--remote", "--remote-port", "8443", "--remote-bind", "0.0.0.0", "--remote-domain", "tt.example.org",
      "--remote-tls", "provided", "--tls-cert", certFile, "--tls-key", keyFile);
    expect(r).toEqual({
      ok: true,
      options: {
        dataDir: defaults.dataDir(),
        uiDir: defaults.uiDir(),
        remote: { enabled: true, port: 8443, bind: "0.0.0.0", domain: "tt.example.org", tls: "provided", certFile, keyFile },
      },
    });
    expect(parse("--remote")).toMatchObject({ ok: true, options: { remote: { enabled: true } } });
    expect(parse("--remote", "--remote-bind", "::")).toMatchObject({ ok: true, options: { remote: { bind: "::" } } });
    expect(parse("--remote", "--remote-tls", "acme", "--remote-domain", "tt.example.org")).toMatchObject({ ok: true });
  });

  it("refuses bad or inconsistent remote flags with fixed lines that echo nothing", () => {
    expect(fail("--remote-port", "8443")).toBe("--remote-port, --remote-bind, --remote-domain, --remote-tls, --tls-cert and --tls-key need --remote");
    expect(fail("--remote", "--remote-port", "port")).toBe("Invalid --remote-port: must be a port number");
    expect(fail("--remote", "--remote-port", "0")).toBe("Invalid --remote-port: must be a port number");
    expect(fail("--remote", "--remote-bind", "my-host")).toBe("Invalid --remote-bind: must be an IP address");
    expect(fail("--remote", "--remote-domain", "192.168.1.10")).toBe("Invalid --remote-domain: must be a DNS name");
    expect(fail("--remote", "--remote-tls", "none")).toBe("Invalid --remote-tls: must be self_signed, acme or provided");
    expect(fail("--remote", "--remote-tls", "acme")).toBe("--remote-tls acme needs --remote-domain");
    expect(fail("--remote", "--remote-tls", "provided", "--tls-cert", "c.pem")).toBe("--remote-tls provided needs --tls-cert and --tls-key");
    expect(fail("--remote", "--tls-cert", "c.pem", "--tls-key", "k.pem")).toBe("--tls-cert and --tls-key need --remote-tls provided");
  });

  it("reads the secret store flags and resolves the key file", () => {
    const keyFile = join(tmpdir(), "tt-key", "secret.key");
    expect(parse("--secret-store", "file", "--secret-key-file", keyFile)).toEqual({
      ok: true,
      options: { dataDir: defaults.dataDir(), uiDir: defaults.uiDir(), secretStore: "file", secretKeyFile: keyFile },
    });
    expect(parse("--secret-store", "keychain")).toMatchObject({ ok: true, options: { secretStore: "keychain" } });
  });

  it("refuses bad or inconsistent secret store flags", () => {
    expect(fail("--secret-store", "vault")).toBe("Invalid --secret-store: must be keychain or file");
    expect(fail("--secret-store", "file")).toBe("--secret-store file needs --secret-key-file");
    expect(fail("--secret-key-file", "k")).toBe("--secret-key-file and --allow-key-in-data-dir need --secret-store file");
    expect(fail("--allow-key-in-data-dir")).toBe("--secret-key-file and --allow-key-in-data-dir need --secret-store file");
  });

  it("refuses a key file inside the data folder unless allowed", () => {
    const dataDir = tmp();
    const keyFile = join(dataDir, "secret.key");
    expect(fail("--data-dir", dataDir, "--secret-store", "file", "--secret-key-file", keyFile)).toBe(
      "Refusing to start: the secret key file is inside the data directory",
    );
    expect(parse("--data-dir", dataDir, "--secret-store", "file", "--secret-key-file", keyFile, "--allow-key-in-data-dir")).toMatchObject({
      ok: true,
      options: { allowKeyInDataDir: true, secretKeyFile: keyFile },
    });
  });
});
