import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type RunningServer } from "../src/server/server.js";
import { MemorySecretStore } from "../src/secrets/memory-store.js";
import type { ReadyMessage } from "../src/host.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const TIMEOUT = 30_000;

type Spawned = { child: ChildProcess; stdout: () => string; stderr: () => string; exit: Promise<number | null> };

const children: ChildProcess[] = [];
const servers: RunningServer[] = [];
const dirs: string[] = [];

/** A data folder whose name has a space and a non-ASCII letter, as real profile paths can. */
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "tt smoke ü-"));
  dirs.push(dir);
  return dir;
}

function startCli(args: string[], ipc = true): Spawned {
  const child = spawn(process.execPath, [CLI, ...args], {
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    env: { ...process.env, THETERMINAL_FAKE_AGENT: "1", THETERMINAL_SECRET_STORE: "memory" },
  });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout?.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr?.setEncoding("utf8").on("data", (d: string) => (err += d));
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, stdout: () => out, stderr: () => err, exit };
}

function firstMessage(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("exit", (code) => reject(new Error(`exited ${code} before a message`)));
  });
}

async function startReady(dir: string): Promise<Spawned & { ready: ReadyMessage }> {
  const spawned = startCli(["start", "--data-dir", dir, "--port", "0"]);
  const ready = (await firstMessage(spawned.child)) as ReadyMessage;
  return { ...spawned, ready };
}

afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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
    servers.push(await createServer({ dataDir: dir, port: 0, secrets: new MemorySecretStore() }));
    const { exit, stderr, stdout } = startCli(["start", "--data-dir", dir, "--port", "0"]);
    expect(await exit).toBe(1);
    expect(stderr()).toContain("The Terminal could not start: Another The Terminal server is already using this data folder.");
    expect(stdout()).toBe("");
  });
});
