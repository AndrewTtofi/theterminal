/**
 * Smoke tests for the packaged desktop app: the installed executable named by `TT_DESKTOP_APP`, never the source.
 *
 * Every test uses its own throwaway data folder (with a space and a non-ASCII letter in its path) and `--port 0`, so
 * it never touches the real data folder or a server already running on the default port. The session token is read
 * from that folder and is never printed: no assertion here compares a value that could carry it (a page URL with
 * `?token=`, a cookie value, `document.cookie`), and process output in an error message is redacted first.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron, expect, test as base } from "@playwright/test";
import { resourcesDir } from "./paths.js";

const APP = process.env.TT_DESKTOP_APP;
if (!APP) throw new Error("Set TT_DESKTOP_APP to the packaged app's executable");
const RESOURCES = resourcesDir(APP, process.platform);
const CORE_DIR = join(RESOURCES, "core");
const REPO_CLI = resolve(import.meta.dirname, "..", "..", "..", "packages", "core", "dist", "cli.js");
const IN_USE = "Another The Terminal server is already using this data folder.";

type BundledCli = { file: string; args: string[] };
type BundledModule = {
  bundledCodex(o: { coreDir: string }): BundledCli | null;
  bundledClaude(o: { coreDir: string }): string | null;
  bundledGemini(o: { coreDir: string }): BundledCli | null;
};

/** A process started by a test, with what it has written so far. */
type Proc = { child: ChildProcess; stdout: () => string; stderr: () => string; exit: Promise<number | null> };

/** A headless app that has written its ready file. */
type Headless = Proc & { base: string; token: string };

type Fixtures = {
  /** A fresh data folder, removed after the test. */
  dir: string;
  /** Starts a process that is killed (if still running) after the test, before its data folder is removed. */
  start: (file: string, args: string[]) => Proc;
};

const test = base.extend<Fixtures>({
  dir: async ({}, use, testInfo) => {
    const d = mkdtempSync(join(tmpdir(), "tt smoke ü-"));
    await use(d);
    try {
      removeDir(d);
    } catch (e) {
      // A file still busy at teardown (Windows) is worth a warning, not a failed test: the folder is throwaway.
      const description = `could not remove the data folder: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`;
      testInfo.annotations.push({ type: "warning", description });
      console.warn(`warning: ${description}`);
    }
  },
  start: async ({ dir }, use) => {
    const procs: Proc[] = [];
    await use((file, args) => {
      const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let out = "";
      let err = "";
      child.stdout!.setEncoding("utf8").on("data", (s: string) => (out += s));
      child.stderr!.setEncoding("utf8").on("data", (s: string) => (err += s));
      const exit = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
      const proc = { child, stdout: () => out, stderr: () => err, exit };
      procs.push(proc);
      return proc;
    });
    for (const p of procs) {
      if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGKILL");
      await p.exit;
    }
    // A killed host's server shuts down on its own (IPC disconnect); let it release the folder before removal.
    await waitFor(() => !existsSync(join(dir, "server.lock")), 15_000).catch(() => undefined);
  },
});

/** Removes a data folder, retrying while a process that is going away still holds a file in it. */
const removeDir = (d: string) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

/** Process output fit for a test report: any session token in a URL is redacted. */
const redact = (s: string) => s.replace(/token=[^&\s"'<>]+/g, "token=<redacted>");

/** Every file under `dir` (symlinks included) whose name is `claude` or `claude.exe`, relative to `dir`. */
function claudeFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => !e.isDirectory() && (e.name === "claude" || e.name === "claude.exe"))
    .map((e) => relative(dir, join(e.parentPath, e.name)));
}

/** Polls `check` every 100 ms until it is true; rejects after `ms`. */
async function waitFor(check: () => boolean | Promise<boolean>, ms: number, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The process's exit code, or a rejection when it is still running after `ms`. */
function exitWithin(p: Proc, ms: number): Promise<number | null> {
  return Promise.race([
    p.exit,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Still running after ${ms} ms`)), ms).unref()),
  ]);
}

/** Starts the app headless on `dir` and waits for its ready file. */
async function headless(start: Fixtures["start"], dir: string, readyFile: string): Promise<Headless> {
  const p = start(APP!, ["--headless", "--data-dir", dir, "--port", "0", "--ready-file", readyFile]);
  let exited = false;
  void p.exit.then(() => (exited = true));
  await waitFor(() => existsSync(readyFile) || exited, 60_000, "the ready file");
  if (!existsSync(readyFile)) throw new Error(`The app exited before it was ready: ${redact(p.stderr())}`);
  const ready = JSON.parse(readFileSync(readyFile, "utf8")) as { loopbackUrl: string; port: number };
  expect(ready.port).toBeGreaterThan(0);
  const token = readFileSync(join(dir, "token"), "utf8").trim();
  return { ...p, base: ready.loopbackUrl.replace(/\/$/, ""), token };
}

const get = (h: Headless, path: string) => fetch(`${h.base}${path}`, { headers: { authorization: `Bearer ${h.token}` } });

/** The server's pid, from the data folder's lock. */
const serverPid = (dir: string) => Number(readFileSync(join(dir, "server.lock"), "utf8").trim());

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Runs a program with `--version`: no shell, a minimal environment. Resolves with its exit code and stdout. */
function version(file: string, args: string[]): Promise<{ code: number; stdout: string }> {
  const env: NodeJS.ProcessEnv = { GEMINI_CLI_NO_RELAUNCH: "1" };
  for (const k of ["PATH", "HOME", "USERPROFILE", "SystemRoot"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  return new Promise((done) => {
    execFile(file, [...args, "--version"], { env, shell: false, timeout: 60_000, windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      done({ code, stdout: String(stdout).trim() });
    });
  });
}

test("headless: the server answers, serves the UI and the bundled CLIs run", async ({ dir, start }) => {
  const a = await headless(start, dir, join(dir, "ready.json"));

  const health = await get(a, "/api/health");
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ ok: true });
  const ui = await get(a, "/");
  expect(ui.status).toBe(200);
  expect(await ui.text()).toContain('<div id="root">');
  expect((await get(a, "/api/agents")).status).toBe(200);

  const bundled = (await import(pathToFileURL(join(CORE_DIR, "dist", "agents", "bundled.js")).href)) as BundledModule;
  const codex = bundled.bundledCodex({ coreDir: CORE_DIR });
  expect(codex, "bundled Codex").not.toBeNull();
  const codexRun = await version(codex!.file, codex!.args);
  expect(codexRun.code).toBe(0);
  expect(codexRun.stdout).not.toBe("");

  // Claude Code is not shipped in these builds: the app uses the user's own install.
  expect(bundled.bundledClaude({ coreDir: CORE_DIR }), "bundled Claude").toBeNull();
  expect(claudeFiles(RESOURCES), "Claude binaries in the app").toEqual([]);

  const gemini = bundled.bundledGemini({ coreDir: CORE_DIR });
  expect(gemini, "bundled Gemini").not.toBeNull();
  const node = join(RESOURCES, "node", process.platform === "win32" ? "node.exe" : "node");
  const geminiRun = await version(node, [gemini!.args[0]!]);
  expect(geminiRun.code).toBe(0);
  expect(geminiRun.stdout).not.toBe("");
});

test("a second launch with the same data folder exits and leaves the first serving", async ({ dir, start }) => {
  const a = await headless(start, dir, join(dir, "ready-a.json"));
  const readyB = join(dir, "ready-b.json");
  const b = start(APP, ["--headless", "--data-dir", dir, "--port", "0", "--ready-file", readyB]);
  expect(await exitWithin(b, 10_000)).toBe(0);
  expect(existsSync(readyB)).toBe(false);
  expect((await get(a, "/api/health")).status).toBe(200);
});

test("the app refuses a data folder held by a running CLI server", async ({ dir, start }) => {
  const cli = start(process.execPath, [REPO_CLI, "start", "--data-dir", dir, "--port", "0"]);
  await waitFor(() => cli.stdout().includes("The Terminal is running at") || cli.child.exitCode !== null, 60_000, "the CLI");
  expect(cli.child.exitCode, "the CLI server").toBeNull();

  const app = start(APP, ["--headless", "--data-dir", dir, "--port", "0", "--ready-file", join(dir, "ready.json")]);
  expect(await exitWithin(app, 60_000)).toBe(1);
  expect(redact(app.stderr())).toContain(IN_USE);

  cli.child.kill("SIGTERM");
  await exitWithin(cli, 15_000);
});

/**
 * Quits a headless app and waits for its server to go: SIGTERM on POSIX, which the app turns into a clean quit; on
 * Windows there is no signal, so the host is terminated and the server dies with it (kill-on-close job object).
 */
async function quitHeadless(h: Headless, dir: string): Promise<void> {
  const pid = serverPid(dir);
  h.child.kill(process.platform === "win32" ? undefined : "SIGTERM");
  await exitWithin(h, 15_000);
  await waitFor(() => !alive(pid), 15_000, "the server process to exit");
}

test("killing the app stops its server, and the next launch takes the folder over", async ({ dir, start }) => {
  const a = await headless(start, dir, join(dir, "ready.json"));
  // The server's own pid (from its lock), so the test sees the server child itself, not just its port.
  const pid = serverPid(dir);
  expect(alive(pid)).toBe(true);
  const lock = join(dir, "server.lock");

  // A force kill: the host gets no chance to stop the server.
  a.child.kill("SIGKILL");
  await waitFor(
    async () => {
      try {
        await get(a, "/api/health");
        return false;
      } catch {
        return true;
      }
    },
    15_000,
    "the server to stop answering",
  );
  if (process.platform === "win32") {
    // The server child sits in the host's kill-on-close job object: it dies with the host, and nothing removes its
    // lock. The lock is then stale: gone, or still naming the dead pid.
    await waitFor(() => !alive(pid), 15_000, "the server process to exit");
    if (existsSync(lock)) expect(serverPid(dir)).toBe(pid);
  } else {
    // The server notices its IPC channel closing, shuts down on its own and releases its lock.
    await waitFor(() => !existsSync(lock), 15_000, "the lock to be released");
    await waitFor(() => !alive(pid), 15_000, "the server process to exit");
  }

  // Takeover: a second app on the same folder starts in spite of whatever the dead server left behind.
  const b = await headless(start, dir, join(dir, "ready-b.json"));
  expect((await get(b, "/api/health")).status).toBe(200);
  expect(serverPid(dir)).not.toBe(pid);
  await quitHeadless(b, dir);

  // No process (server, agent or Electron helper) still holds a file in the data folder.
  removeDir(dir);
  expect(existsSync(dir)).toBe(false);
});

test("window: opens the workspace on theterminal.localhost with the session cookie", async ({ dir }) => {
  // The Chromium profile stores its cookie key in a mock keychain and a basic password store: never the real ones.
  const app = await _electron.launch({
    executablePath: APP,
    args: ["--data-dir", dir, "--port", "0", "--use-mock-keychain", "--password-store=basic"],
  });
  let closed = false;
  try {
    const page = await app.firstWindow();
    // Not toHaveURL: its failure message would print the bootstrap URL, which carries the session token.
    await waitFor(() => /^http:\/\/theterminal\.localhost:\d+\/$/.test(page.url()), 60_000, "the workspace URL");
    expect(new URL(page.url()).search).toBe("");
    // The activity bar shows every view of the shell (apps/ui/src/shell/views.ts), as e2e/shell.spec.ts checks too.
    const viewButtons = page.getByRole("navigation", { name: "Views" }).getByRole("button");
    await expect(viewButtons).toHaveCount(11);
    expect(await viewButtons.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))).toEqual([
      "Board", "Agents", "Changes", "Needs you", "Ledger", "Connections", "GitHub", "Capacity", "Machines", "Share", "Learn",
    ]);

    // Only the cookie's attributes are compared, never its value.
    const cookies = (await app.context().cookies()).map(({ name, domain, httpOnly, sameSite }) => ({ name, domain, httpOnly, sameSite }));
    expect(cookies).toContainEqual({ name: "tt_token", domain: "theterminal.localhost", httpOnly: true, sameSite: "Strict" });
    expect((await page.evaluate(() => document.cookie)).includes("tt_token")).toBe(false);

    const origin = new URL(page.url()).origin;
    await app.close();
    closed = true;
    await waitFor(
      async () => {
        try {
          await fetch(`http://127.0.0.1:${new URL(origin).port}/api/health`);
          return false;
        } catch {
          return true;
        }
      },
      15_000,
      "the port to stop answering",
    );
  } finally {
    if (!closed) {
      // An app stuck behind a modal error box never quits: give it 15 s, then kill it.
      const proc = app.process();
      const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
      await app.close().catch(() => undefined);
      clearTimeout(timer);
    }
    await waitFor(() => !existsSync(join(dir, "server.lock")), 15_000).catch(() => undefined);
  }
});
