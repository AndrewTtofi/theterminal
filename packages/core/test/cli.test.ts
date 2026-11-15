import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type RunningServer } from "../src/server/server.js";
import { MemorySecretStore } from "../src/secrets/memory-store.js";
import { FileSecretStore } from "../src/secrets/file-store.js";
import { fakeDiscovery } from "../src/link/discovery.js";
import type { ReadyMessage } from "../src/host.js";
import { USAGE } from "../src/cli-support.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const TIMEOUT = 30_000;

type Spawned = { child: ChildProcess; stdout: () => string; stderr: () => string; exit: Promise<number | null> };

/** Every process a test started, with its exit: teardown awaits them before it removes their folders. */
const children: { child: ChildProcess; exit: Promise<unknown> }[] = [];
const servers: RunningServer[] = [];
const dirs: string[] = [];
/** Grandchildren, killed after each test if they outlived it. */
const pids: number[] = [];

/** A data folder whose name has a space and a non-ASCII letter, as real profile paths can. */
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "tt smoke ü-"));
  dirs.push(dir);
  return dir;
}

const CORE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");


function startCli(args: string[], ipc = true, extraEnv: NodeJS.ProcessEnv = {}): Spawned {
  const child = spawn(process.execPath, [CLI, ...args], {
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    env: { ...process.env, THETERMINAL_FAKE_AGENT: "1", THETERMINAL_SECRET_STORE: "memory", THETERMINAL_FAKE_DISCOVERY: "1", ...extraEnv },
  });
  let out = "";
  let err = "";
  child.stdout?.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr?.setEncoding("utf8").on("data", (d: string) => (err += d));
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  children.push({ child, exit });
  return { child, stdout: () => out, stderr: () => err, exit };
}

function firstMessage(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("exit", (code) => reject(new Error(`exited ${code} before a message`)));
  });
}

async function startReady(dir: string, extraArgs: string[] = [], extraEnv: NodeJS.ProcessEnv = {}): Promise<Spawned & { ready: ReadyMessage }> {
  const spawned = startCli(["start", "--data-dir", dir, "--port", "0", ...extraArgs], true, extraEnv);
  const ready = (await firstMessage(spawned.child)) as ReadyMessage;
  return { ...spawned, ready };
}

/** Which providers the server can run, asked over loopback with the bearer token. */
async function available(ready: ReadyMessage): Promise<Record<string, boolean>> {
  const token = ready.url.split("token=")[1]!;
  const res = await fetch(`${ready.loopbackUrl}api/agents`, { headers: { authorization: `Bearer ${token}` } });
  const body = (await res.json()) as { providers: Record<string, { available: boolean }> };
  return Object.fromEntries(Object.entries(body.providers).map(([p, v]) => [p, v.available]));
}

/** Whether a process with this pid still exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

afterEach(async () => {
  // A killed child is gone only once it has exited; removing its folder before that fails with EBUSY on Windows.
  const exits = children.splice(0).map(({ child, exit }) => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    return exit;
  });
  await Promise.all(exits);
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("theterminal start as a host's child process", () => {
  it("under an IPC channel it sends ready and prints no token", { timeout: TIMEOUT }, async () => {
    const { ready, stdout } = await startReady(tmp());
    expect(ready).toMatchObject({ type: "ready" });
    expect(ready.url).toMatch(/^http:\/\/theterminal\.localhost:\d+\/\?token=[0-9a-f]{64}$/);
    expect(ready.loopbackUrl).toBe(`http://127.0.0.1:${ready.port}/`);
    const token = ready.url.split("token=")[1]!;
    expect(stdout()).toContain("The Terminal is running at http://127.0.0.1:");
    expect(stdout()).not.toContain(token);
  });

  it("a shutdown message closes the server and exits 0", { timeout: TIMEOUT }, async () => {
    const dir = tmp();
    const { child, exit } = await startReady(dir);
    expect(existsSync(join(dir, "server.lock"))).toBe(true);
    child.send({ type: "shutdown" });
    expect(await exit).toBe(0);
    expect(existsSync(join(dir, "server.lock"))).toBe(false);
  });

  it("losing the host channel shuts down too", { timeout: TIMEOUT }, async () => {
    const dir = tmp();
    const { child, exit } = await startReady(dir);
    child.disconnect();
    expect(await exit).toBe(0);
    expect(existsSync(join(dir, "server.lock"))).toBe(false);
  });

  it("--core-dir must be absolute", { timeout: TIMEOUT }, async () => {
    const { exit, stderr } = startCli(["start", "--data-dir", tmp(), "--port", "0", "--core-dir", "relative/dir"]);
    expect(await exit).toBe(1);
    expect(stderr()).toContain("Invalid --core-dir: must be an absolute path");
  });

  it("a data folder in use exits 1 with the fixed message", { timeout: TIMEOUT }, async () => {
    const dir = tmp();
    servers.push(await createServer({ dataDir: dir, port: 0, secrets: new MemorySecretStore(), discovery: fakeDiscovery() }));
    const { exit, stderr, stdout } = startCli(["start", "--data-dir", dir, "--port", "0"]);
    expect(await exit).toBe(1);
    expect(stderr()).toContain("The Terminal could not start: Another The Terminal server is already using this data folder.");
    expect(stdout()).toBe("");
  });

  it("an unknown option prints the usage line, never a stack trace", { timeout: TIMEOUT }, async () => {
    const { exit, stderr } = startCli(["start", "--no-such-option"]);
    expect(await exit).toBe(1);
    expect(stderr()).toBe(`${USAGE}\n`);
  });

  it("any other start error prints a fixed line and logs the scrubbed detail", { timeout: TIMEOUT }, async () => {
    const ui = tmp();
    const dataDir = join(ui, "data"); // inside the UI folder: refused at start
    mkdirSync(dataDir);
    const { exit, stderr, stdout } = startCli(["start", "--data-dir", dataDir, "--ui-dir", ui, "--port", "0"]);
    expect(await exit).toBe(1);
    expect(stderr()).toBe("The Terminal could not start. See the log for details.\n");
    expect(stdout()).toBe("");
    const log = join(dataDir, "logs", "server-start.log");
    const text = readFileSync(log, "utf8");
    expect(text).toContain("is inside the UI directory");
    expect(text).toContain("<data>");
    if (process.platform !== "win32") expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  it("the usage line names every flag", () => {
    for (const flag of ["--remote", "--remote-port", "--remote-bind", "--remote-domain", "--remote-tls", "--tls-cert", "--tls-key",
      "--secret-store", "--secret-key-file", "--allow-key-in-data-dir"]) {
      expect(USAGE).toContain(`[${flag}`);
    }
  });

  it("--secret-store file without --secret-key-file exits 1", { timeout: TIMEOUT }, async () => {
    const { exit, stderr, stdout } = startCli(["start", "--data-dir", tmp(), "--port", "0", "--secret-store", "file"]);
    expect(await exit).toBe(1);
    expect(stderr()).toBe("--secret-store file needs --secret-key-file\n");
    expect(stdout()).toBe("");
  });

  it("--remote-tls acme without --remote-domain exits 1", { timeout: TIMEOUT }, async () => {
    const { exit, stderr } = startCli(["start", "--data-dir", tmp(), "--port", "0", "--remote", "--remote-tls", "acme"]);
    expect(await exit).toBe(1);
    expect(stderr()).toBe("--remote-tls acme needs --remote-domain\n");
  });

  it("a --secret-key-file inside --data-dir exits 1 and writes no key", { timeout: TIMEOUT }, async () => {
    const dir = tmp();
    const keyFile = join(dir, "secret.key");
    const { exit, stderr, stdout } = startCli(["start", "--data-dir", dir, "--port", "0", "--secret-store", "file", "--secret-key-file", keyFile]);
    expect(await exit).toBe(1);
    expect(stderr()).toBe("Refusing to start: the secret key file is inside the data directory\n");
    expect(stdout()).toBe("");
    expect(existsSync(keyFile)).toBe(false);
  });

  it("--remote on a port in use exits 1 with the fixed line, so a server asked for remote access never comes up without it", { timeout: TIMEOUT }, async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const busy = (blocker.address() as AddressInfo).port;
    try {
      const { exit, stderr, stdout } = startCli(["start", "--data-dir", tmp(), "--port", "0", "--remote", "--remote-bind", "127.0.0.1", "--remote-port", String(busy)]);
      expect(await exit).toBe(1);
      expect(stderr()).toBe("The Terminal could not start: the remote listener could not start\n");
      expect(stdout()).toBe("");
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it("an unusable key file exits 1 with a fixed line", { timeout: TIMEOUT }, async () => {
    const keyFile = join(tmp(), "secret.key");
    writeFileSync(keyFile, Buffer.alloc(31, 7));
    const { exit, stderr, stdout } = startCli(["start", "--data-dir", tmp(), "--port", "0", "--secret-store", "file", "--secret-key-file", keyFile]);
    expect(await exit).toBe(1);
    expect(stderr()).toBe("The Terminal could not start: secret key file unavailable\n");
    expect(stdout()).toBe("");
  });

  it("a 32-byte key that does not open the existing secrets file exits 1 with a fixed line", { timeout: TIMEOUT }, async () => {
    const dir = tmp();
    const keyFile = join(tmp(), "secret.key");
    await new FileSecretStore({ file: join(dir, "secrets.enc.json"), keyFile, createKey: true }).set("connection/x", "sk-TESTKEY-0000000000");
    writeFileSync(keyFile, randomBytes(32));
    const { exit, stderr, stdout } = startCli(["start", "--data-dir", dir, "--port", "0", "--secret-store", "file", "--secret-key-file", keyFile]);
    expect(await exit).toBe(1);
    expect(stderr()).toBe("The Terminal could not start: the secret key does not open the secrets file\n");
    expect(stdout()).toBe("");
  });

  it("--secret-store file creates the key file at startup, outside the data folder", { timeout: TIMEOUT }, async () => {
    const dir = tmp();
    const keyFile = join(tmp(), "key", "secret.key");
    const { ready, stdout } = await startReady(dir, ["--secret-store", "file", "--secret-key-file", keyFile]);
    expect(ready).toMatchObject({ type: "ready" });
    expect(statSync(keyFile).size).toBe(32);
    if (process.platform !== "win32") expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, "secret.key"))).toBe(false);
    expect(stdout()).not.toContain("Open this link once");
  });

  it("a real --core-dir is used for the bundled programs", { timeout: TIMEOUT }, async () => {
    // An empty PATH, so only the bundled programs can be found.
    const { ready } = await startReady(tmp(), ["--core-dir", CORE_DIR], { PATH: tmp() });
    expect((await available(ready)).codex).toBe(true);
  });

  it("an absolute --core-dir that does not exist starts with no bundled programs", { timeout: TIMEOUT }, async () => {
    const missing = join(tmp(), "no-such-core");
    const { ready } = await startReady(tmp(), ["--core-dir", missing], { PATH: tmp() });
    expect(await available(ready)).toEqual({ claude: false, codex: false, gemini: false });
  });

  it.skipIf(process.platform === "win32")("a host killed with SIGKILL takes the server down with it", { timeout: TIMEOUT }, async () => {
    const dir = tmp();
    // The host: spawns the CLI with an IPC channel and reports its pid once the CLI is ready.
    const host = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, process.argv.slice(1), { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      child.once("message", () => process.stdout.write(String(child.pid) + "\\n"));
      setInterval(() => {}, 1000);
    `;
    const parent = spawn(process.execPath, ["-e", host, CLI, "start", "--data-dir", dir, "--port", "0"], {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, THETERMINAL_FAKE_AGENT: "1", THETERMINAL_SECRET_STORE: "memory", THETERMINAL_FAKE_DISCOVERY: "1" },
    });
    children.push({ child: parent, exit: new Promise((resolve) => parent.once("exit", resolve)) });
    const pid = await new Promise<number>((resolve, reject) => {
      let out = "";
      parent.stdout!.setEncoding("utf8").on("data", (d: string) => {
        out += d;
        if (out.includes("\n")) resolve(Number(out.trim()));
      });
      parent.once("exit", () => reject(new Error("host exited early")));
    });
    pids.push(pid);
    expect(alive(pid)).toBe(true);
    parent.kill("SIGKILL");
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 15_000, interval: 100 });
    expect(existsSync(join(dir, "server.lock"))).toBe(false);
  });
});
