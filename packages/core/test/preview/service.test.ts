import { execFile, spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, LedgerEntry } from "@theterminal/shared";
import { RemoteRunError } from "../../src/agents/runner.js";
import { redact, truncate } from "../../src/agents/redact.js";
import { WorktreeManager } from "../../src/agents/worktrees.js";
import { BoardService } from "../../src/board/board-service.js";
import { openDatabase, type Db } from "../../src/db.js";
import { commitEvent } from "../../src/events/commit.js";
import { countCardScreenshots, getPreview, latestOffer, listScreenshots, rebuildAllProjections } from "../../src/events/projections.js";
import { HumanRequiredError } from "../../src/intake/service.js";
import { Ledger } from "../../src/ledger/ledger.js";
import type { ToolRunner } from "../../src/preview/native.js";
import {
  NoPreviewOfferError, PlatformUnsupportedError, PreviewBusyError, PreviewChangedError, PreviewFailedError, PreviewNotAllowedError,
  PreviewService, ScreenshotsUnavailableError, type PreviewDeps,
} from "../../src/preview/service.js";
import { PreviewFailedError as NativePreviewFailedError } from "../../src/preview/native.js";
import { PNG_1X1, pngOf } from "../fixtures/png.js";

vi.setConfig({ testTimeout: process.platform === "win32" ? 60_000 : 20_000 });

const SITE = fileURLToPath(new URL("../fixtures/fake-site.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("../fixtures/fake-native.mjs", import.meta.url));
const SECRET = "sk-ant-TESTKEY-0000000000";
const UDID = "0B0E0C2A-1D2F-4E8A-9C3B-5A6D7E8F9012";

const owner: Actor = { kind: "human", id: "owner" };
const maint: Actor = { kind: "human", id: "maint-1" };
const other: Actor = { kind: "human", id: "maint-2" };
const agent: Actor = { kind: "agent", id: "r1" };

let dataDir: string;
let db: Db;
let ledger: Ledger;
let worktrees: WorktreeManager;
let projectId: string;
let service: PreviewService;
let services: PreviewService[];
/** Extra variables the fake site gets (the service's own environment drops them). */
let siteEnv: Record<string, string>;
/** The environments the service spawned with, as it built them. */
let spawned: NodeJS.ProcessEnv[];
/** Added to the real clock. */
let offset: number;

const spawn = ((file: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
  spawned.push(o.env);
  return nodeSpawn(file, args, { ...o, env: { ...o.env, ...siteEnv } });
}) as unknown as typeof nodeSpawn;

const resolveWeb: PreviewDeps["resolveWeb"] = (cmd) => {
  if (cmd.join(" ") === "npm run dev") return { file: process.execPath, args: [SITE] };
  throw new Error(`unexpected command ${cmd.join(" ")}`);
};

function fakeTools(script: Record<string, unknown> = {}, calls: string[] = []): ToolRunner {
  return (tool, args, o) =>
    new Promise((resolve) => {
      calls.push([tool, ...args].join(" "));
      const name = tool.endsWith("gradlew") ? "gradlew" : tool;
      execFile(
        process.execPath,
        [FAKE, name, ...args],
        { cwd: o.cwd, env: { ...o.env, THETERMINAL_FAKE_NATIVE: JSON.stringify(script) }, timeout: o.timeoutMs, windowsHide: true, encoding: "utf8" },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null) : 0;
          resolve({ code, stdout, stderr });
        },
      );
    });
}

function make(extra: Partial<PreviewDeps> = {}): PreviewService {
  const s = new PreviewService({
    db, ledger, dataDir, worktrees,
    clean: (_runId, s, max) => truncate(redact(s, [SECRET]), max),
    settling: () => false,
    platform: process.platform,
    homedir: dataDir,
    newId: (() => {
      let n = 0;
      return () => `pv${++n}-${services.length}`;
    })(),
    now: () => new Date(Date.now() + offset),
    spawn,
    resolveWeb,
    ...extra,
  });
  services.push(s);
  return s;
}

const emit = (type: string, payload: Record<string, unknown>, actor: Actor, project: string | null = projectId) =>
  commitEvent(db, ledger, () => ({ event: { projectId: project, actor, type, payload }, result: (e) => e }));

let runCount = 0;
/** A run started by `by`, with a working copy holding `package.json` (scripts.dev) and `node_modules`. */
function makeRun(by: Actor = maint, o: { cardId?: string | null; offer?: boolean } = {}): { runId: string; wt: string } {
  const runId = `run${++runCount}`;
  const rel = `projects/${projectId}/worktrees/${runId}`;
  const wt = join(dataDir, ...rel.split("/"));
  mkdirSync(join(wt, "node_modules"), { recursive: true });
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "site", scripts: { dev: "node ../fake-site.mjs" } }));
  emit("agent.started", { runId, adapter: "fake", authMode: "none", prompt: "build the site", cardId: o.cardId ?? null, worktree: rel }, by);
  if (o.offer !== false) emit("preview.offered", { runId, kind: "web", command: "npm run dev", port: 5173 }, { kind: "agent", id: runId });
  return { runId, wt };
}

const entries = (type: string): LedgerEntry[] => ledger.list({ limit: 5000 }).filter((e) => e.type === type);
const of = (previewId: string, type: string) => entries(type).filter((e) => (e.payload as { previewId: string }).previewId === previewId);
const waitFor = (previewId: string, type: string, timeout = 15_000) =>
  vi.waitFor(() => expect(of(previewId, type)).toHaveLength(1), { timeout, interval: 20 });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Expects the promise to reject with `type`, and the ledger to be unchanged. */
async function refused(p: () => Promise<unknown>, type: new (...a: never[]) => Error): Promise<Error> {
  const head = ledger.headSeq();
  let caught: unknown;
  try {
    await p();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(type);
  expect(ledger.headSeq()).toBe(head);
  return caught as Error;
}

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "tt-preview-")));
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  worktrees = new WorktreeManager(dataDir);
  projectId = new BoardService(db, ledger).createProject(owner, { name: "Demo" }).id;
  services = [];
  siteEnv = {};
  spawned = [];
  offset = 0;
  service = make();
});

afterEach(async () => {
  await Promise.all(services.map((s) => s.shutdown()));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("plan", () => {
  it("shows the offered command, and says confirmedEarlier once a start used the same key", async () => {
    const { runId } = makeRun();
    const plan = await service.plan(maint, runId, "web");
    expect(plan).toMatchObject({
      kind: "web", commands: [["npm", "run", "dev"]], display: ["npm run dev"], confirmedEarlier: false, install: false,
      target: { source: "marker", label: "npm run dev" },
    });
    expect(plan.key).toMatch(/^[0-9a-f]{64}$/);
    await service.start(maint, runId, { kind: "web", key: plan.key });
    expect(await service.plan(maint, runId, "web")).toMatchObject({ key: plan.key, confirmedEarlier: true });
  });

  it("refuses a maintainer on someone else's run and an agent; the Owner may", async () => {
    const { runId } = makeRun(other);
    await refused(() => service.plan(maint, runId, "web"), PreviewNotAllowedError);
    await refused(() => service.plan(agent, runId, "web"), HumanRequiredError);
    await expect(service.plan(owner, runId, "web")).resolves.toMatchObject({ kind: "web" });
  });

  it("gives NoPreviewOfferError for a website without an offer", async () => {
    const { runId } = makeRun(maint, { offer: false });
    await refused(() => service.plan(maint, runId, "web"), NoPreviewOfferError);
  });

  it("refuses a run on a linked machine", async () => {
    const { runId } = makeRun();
    db.prepare("UPDATE agent_runs SET machine_id = 'm1' WHERE id = ?").run(runId);
    await refused(() => service.plan(maint, runId, "web"), RemoteRunError);
  });

  it("gives PlatformUnsupportedError for Android on Windows and iOS off macOS", async () => {
    const { runId } = makeRun();
    const win = make({ platform: "win32" });
    const e = await refused(() => win.plan(maint, runId, "android"), PlatformUnsupportedError);
    expect((e as PlatformUnsupportedError).kind).toBe("android");
    await refused(() => make({ platform: "linux" }).plan(maint, runId, "ios"), PlatformUnsupportedError);
  });

  it("re-exports the one PreviewFailedError", () => {
    expect(PreviewFailedError).toBe(NativePreviewFailedError);
  });
});

describe("start", () => {
  it("asks again when package.json changes", async () => {
    const { runId, wt } = makeRun();
    const { key } = await service.plan(maint, runId, "web");
    writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "site", scripts: { dev: "node ../fake-site.mjs " } }));
    await refused(() => service.start(maint, runId, { kind: "web", key }), PreviewChangedError);
    expect(spawned).toHaveLength(0);
  });

  it("records the request, the start, three steps and ready, with the site on loopback and no key in its environment", async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = SECRET;
    try {
      const { runId } = makeRun();
      const { key } = await service.plan(maint, runId, "web");
      const { view, created } = await service.start(maint, runId, { kind: "web", key });
      expect(created).toBe(true);
      expect(view).toMatchObject({ runId, projectId, kind: "web", state: "starting" });
      await waitFor(view.id, "preview.ready");
      const [requested] = of(view.id, "preview.requested");
      expect(requested!.actor).toEqual(maint);
      expect(requested!.payload).toEqual({
        previewId: view.id, runId, kind: "web", commands: [["npm", "run", "dev"]], key, install: false, target: "npm run dev",
      });
      expect(of(view.id, "preview.started")).toHaveLength(1);
      expect(of(view.id, "preview.progress").map((e) => (e.payload as { done: number[] }).done)).toEqual([[1], [1, 2], [1, 2, 3]]);
      const ready = of(view.id, "preview.ready")[0]!.payload as { origin: string; frameable: boolean; exposed: boolean };
      const env = spawned[0]!;
      expect(ready.origin).toBe(`http://127.0.0.1:${env.PORT}`);
      expect(ready.frameable).toBe(true);
      expect(ready.exposed).toBe(false);
      expect(env.HOST).toBe("127.0.0.1");
      expect(env.BROWSER).toBe("none");
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(service.view(view.id)).toMatchObject({ state: "ready", percent: 100, origin: ready.origin, liveCount: null });
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
  });

  it("marks a site that refuses framing", async () => {
    siteEnv = { FAKE_SITE_NOFRAME: "1" };
    const { runId } = makeRun();
    const { view } = await service.start(maint, runId, { kind: "web", key: (await service.plan(maint, runId, "web")).key });
    await waitFor(view.id, "preview.ready");
    expect(of(view.id, "preview.ready")[0]!.payload).toMatchObject({ frameable: false });
  });

  it("fails after three minutes, with the tail, and kills the tree", async () => {
    const grandchild = join(dataDir, "grandchild.pid");
    siteEnv = { FAKE_SITE_DELAY_MS: "600000", FAKE_SITE_PRINT: `starting with ${SECRET}\n`, FAKE_SITE_GRANDCHILD: grandchild };
    const slow = make({
      // A minute of the fake clock per round, so a slow refused connect (Windows) does not stretch the test.
      sleep: async () => {
        offset += 60_000;
        await new Promise((r) => setTimeout(r, 300));
      },
    });
    const { runId } = makeRun();
    const { view } = await slow.start(maint, runId, { kind: "web", key: (await slow.plan(maint, runId, "web")).key });
    await vi.waitFor(() => expect(existsSync(grandchild)).toBe(true), { timeout: 10_000 });
    await waitFor(view.id, "preview.failed", 30_000);
    const failed = of(view.id, "preview.failed")[0]!.payload as { reason: string; tail: string[] };
    expect(failed.reason).toBe("timed_out");
    expect(failed.tail).toEqual(["starting with [REDACTED]"]);
    expect(offset).toBeGreaterThan(170_000); // the fake clock ran the three minutes
    const pid = Number(readFileSync(grandchild, "utf8"));
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 15_000 });
    expect(of(view.id, "preview.stopped")).toHaveLength(0);
    expect(slow.view(view.id).state).toBe("failed");
  });

  it("fails at once with exited when the site stops by itself", async () => {
    siteEnv = { FAKE_SITE_EXIT: "3" };
    const { runId } = makeRun();
    const { view } = await service.start(maint, runId, { kind: "web", key: (await service.plan(maint, runId, "web")).key });
    await waitFor(view.id, "preview.failed");
    expect(of(view.id, "preview.failed")[0]!.payload).toMatchObject({ reason: "exited" });
    expect(offset).toBe(0);
  });

  it("returns the live preview for the same key, refuses another key, and holds at most four websites", async () => {
    const runs = [makeRun(), makeRun(), makeRun(), makeRun(), makeRun()];
    const keys = await Promise.all(runs.map((r) => service.plan(maint, r.runId, "web").then((p) => p.key)));
    const first = await service.start(maint, runs[0]!.runId, { kind: "web", key: keys[0]! });
    const again = await service.start(maint, runs[0]!.runId, { kind: "web", key: keys[0]! });
    expect(again).toMatchObject({ created: false, view: { id: first.view.id } });
    expect(of(first.view.id, "preview.requested")).toHaveLength(1);
    for (let i = 1; i < 4; i++) await service.start(maint, runs[i]!.runId, { kind: "web", key: keys[i]! });
    await refused(() => service.start(maint, runs[4]!.runId, { kind: "web", key: keys[4]! }), PreviewBusyError);
  });
});

describe("the agent's stated port", () => {
  /** A local service on its own port, answering every request. */
  async function otherService(): Promise<{ server: Server; port: number }> {
    const server = createServer((_req, res) => res.end("someone else's"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { server, port: (server.address() as AddressInfo).port };
  }

  async function startWithStated(s: PreviewService, port: number): Promise<string> {
    const { runId } = makeRun(maint, { offer: false });
    emit("preview.offered", { runId, kind: "web", command: "npm run dev", port }, { kind: "agent", id: runId });
    const { view } = await s.start(maint, runId, { kind: "web", key: (await s.plan(maint, runId, "web")).key });
    return view.id;
  }

  it("is never recorded as the preview's origin when something else already listens there", async () => {
    const other = await otherService();
    try {
      siteEnv = { FAKE_SITE_DELAY_MS: "1500" };
      const id = await startWithStated(service, other.port);
      await waitFor(id, "preview.ready");
      const ready = of(id, "preview.ready")[0]!.payload as { origin: string };
      expect(ready.origin).toBe(`http://127.0.0.1:${spawned[0]!.PORT}`);
      expect(ready.origin).not.toContain(`:${other.port}`);
    } finally {
      other.server.close();
    }
  });

  it("is never probed when it is the server's own port", async () => {
    const own = await otherService();
    try {
      siteEnv = { FAKE_SITE_DELAY_MS: "1500" };
      // The port is free again before the start, so only the own-port rule keeps it out.
      await new Promise((r) => own.server.close(r));
      const s = make({ ownPorts: () => [own.port] });
      const id = await startWithStated(s, own.port);
      const again = createServer((_req, res) => res.end("the server itself"));
      await new Promise<void>((r) => again.listen(own.port, "127.0.0.1", () => r()));
      try {
        await waitFor(id, "preview.ready");
        expect((of(id, "preview.ready")[0]!.payload as { origin: string }).origin).toBe(`http://127.0.0.1:${spawned[0]!.PORT}`);
      } finally {
        again.close();
      }
    } finally {
      own.server.close();
    }
  });
});

describe("stop, idle and restart", () => {
  it("stops for the person, killing the tree, once", async () => {
    const grandchild = join(dataDir, "gc.pid");
    siteEnv = { FAKE_SITE_GRANDCHILD: grandchild };
    const { runId } = makeRun();
    const { view } = await service.start(maint, runId, { kind: "web", key: (await service.plan(maint, runId, "web")).key });
    await waitFor(view.id, "preview.ready");
    await refused(() => service.stop(other, view.id, "person"), PreviewNotAllowedError);
    await service.stop(maint, view.id, "tab_closed");
    await service.stop(maint, view.id, "person");
    expect(of(view.id, "preview.stopped").map((e) => e.payload)).toEqual([{ previewId: view.id, reason: "tab_closed" }]);
    const pid = Number(readFileSync(grandchild, "utf8"));
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 15_000 });
    expect(service.view(view.id).state).toBe("stopped");
    // A new start is allowed once it stopped.
    const next = await service.start(maint, runId, { kind: "web", key: (await service.plan(maint, runId, "web")).key });
    expect(next.created).toBe(true);
  });

  it("stops when idle", async () => {
    const grandchild = join(dataDir, "idle.pid");
    siteEnv = { FAKE_SITE_GRANDCHILD: grandchild };
    const { runId } = makeRun();
    const { view } = await service.start(maint, runId, { kind: "web", key: (await service.plan(maint, runId, "web")).key });
    await waitFor(view.id, "preview.ready");
    offset += 29 * 60_000;
    await service.sweepIdle();
    expect(of(view.id, "preview.stopped")).toHaveLength(0);
    offset += 60_000;
    await service.sweepIdle();
    expect(of(view.id, "preview.stopped").map((e) => e.payload)).toEqual([{ previewId: view.id, reason: "idle" }]);
    expect(of(view.id, "preview.stopped")[0]!.actor).toEqual({ kind: "system", id: "preview" });
    const pid = Number(readFileSync(grandchild, "utf8"));
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 15_000 });
  });

  it("keeps running while the tab says seen every minute", async () => {
    const { runId } = makeRun();
    const { view } = await service.start(maint, runId, { kind: "web", key: (await service.plan(maint, runId, "web")).key });
    await waitFor(view.id, "preview.ready");
    for (let i = 0; i < 45; i++) {
      offset += 60_000;
      service.seen(view.id);
      await service.sweepIdle();
    }
    expect(of(view.id, "preview.stopped")).toHaveLength(0);
    expect(service.view(view.id).state).toBe("ready");
  });

  it("records shutdown for every live preview", async () => {
    const { runId } = makeRun();
    const { view } = await service.start(maint, runId, { kind: "web", key: (await service.plan(maint, runId, "web")).key });
    await waitFor(view.id, "preview.ready");
    await service.shutdown();
    expect(of(view.id, "preview.stopped").map((e) => (e.payload as { reason: string }).reason)).toEqual(["shutdown"]);
  });

  it("records restarted on startup", () => {
    const { runId } = makeRun();
    emit("preview.requested", { previewId: "old", runId, kind: "web", commands: [["npm", "run", "dev"]], key: "c".repeat(64), install: false, target: "npm run dev" }, maint);
    emit("preview.started", { previewId: "old", port: 40000 }, maint);
    service.recoverOnStartup();
    service.recoverOnStartup();
    const stopped = of("old", "preview.stopped");
    expect(stopped.map((e) => e.payload)).toEqual([{ previewId: "old", reason: "restarted" }]);
    expect(stopped[0]!.actor).toEqual({ kind: "system", id: "preview" });
    expect(getPreview(db, "old")!.state).toBe("stopped");
  });
});

describe("iOS", () => {
  function iosRun(): { runId: string; wt: string } {
    const r = makeRun(maint, { offer: false });
    mkdirSync(join(r.wt, "Trips.xcodeproj"), { recursive: true });
    writeFileSync(join(r.wt, "Trips.xcodeproj", "project.pbxproj"), "// project");
    emit("preview.offered", { runId: r.runId, kind: "ios", target: "Trips.xcodeproj" }, { kind: "agent", id: r.runId });
    return r;
  }
  const native = (script: Record<string, unknown>, calls: string[]) =>
    make({
      platform: "darwin",
      tools: fakeTools(script, calls),
      resolveNative: (tool) => ({ file: process.execPath, args: [FAKE, tool.endsWith("gradlew") ? "gradlew" : tool] }),
    });

  it("builds and opens the app with five real stages, skipping the boot of a booted device and leaving it running", async () => {
    const calls: string[] = [];
    const ios = native({}, calls);
    const { runId } = iosRun();
    const plan = await ios.plan(maint, runId, "ios");
    expect(plan.target).toEqual({ source: "marker", label: "Trips.xcodeproj" });
    expect(plan.commands.some((c) => c.join(" ").includes("simctl boot"))).toBe(false);
    const { view } = await ios.start(maint, runId, { kind: "ios", key: plan.key });
    await vi.waitFor(() => expect(of(view.id, "preview.ready").length + of(view.id, "preview.failed").length).toBe(1), { timeout: 15_000 });
    expect(of(view.id, "preview.failed").map((e) => e.payload)).toEqual([]);
    expect(of(view.id, "preview.progress").map((e) => (e.payload as { done: number[] }).done)).toEqual([
      [1], [1, 2], [1, 2, 3], [1, 2, 3, 4], [1, 2, 3, 4, 5],
    ]);
    expect(of(view.id, "preview.ready")[0]!.payload).toEqual({ previewId: view.id });
    expect(calls).toEqual(expect.arrayContaining([`xcrun simctl install ${UDID} ${join(dataDir, "projects", projectId, "builds", runId, "Build", "Products", "Debug-iphonesimulator", "Trips.app")}`, `xcrun simctl launch ${UDID} com.example.trips`]));

    const shots = await ios.screenshot(maint, view.id);
    const again = await ios.screenshot(maint, view.id);
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ device: "iPhone 16", width: 1, height: 1, bytes: PNG_1X1.length, runId, previewId: view.id });
    expect(again[0]!.sha256).toBe(shots[0]!.sha256);
    const artifacts = join(dataDir, "projects", projectId, "artifacts");
    expect(readdirSync(artifacts)).toEqual([`${shots[0]!.sha256}.png`]);
    expect(of(view.id, "preview.screenshot").map((e) => e.payload)).toEqual([
      { previewId: view.id, runId, device: "iPhone 16", sha256: shots[0]!.sha256, bytes: PNG_1X1.length, width: 1, height: 1 },
      { previewId: view.id, runId, device: "iPhone 16", sha256: shots[0]!.sha256, bytes: PNG_1X1.length, width: 1, height: 1 },
    ]);

    await ios.stop(maint, view.id, "person");
    expect(calls).toContain(`xcrun simctl terminate ${UDID} com.example.trips`);
    expect(calls.some((c) => c.includes("simctl shutdown"))).toBe(false);
  });

  it("shuts the simulator down when The Terminal booted it", async () => {
    const calls: string[] = [];
    const devices = {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [{ udid: UDID, name: "iPhone 16", state: "Shutdown", isAvailable: true }],
    };
    const ios = native({ devices }, calls);
    const { runId } = iosRun();
    const plan = await ios.plan(maint, runId, "ios");
    const { view } = await ios.start(maint, runId, { kind: "ios", key: plan.key });
    await waitFor(view.id, "preview.ready");
    expect(calls).toContain(`xcrun simctl boot ${UDID}`);
    await ios.stop(maint, view.id, "person");
    expect(calls).toContain(`xcrun simctl shutdown ${UDID}`);
  });

  it("gives quitting the app a few seconds at most when the server shuts down", async () => {
    const script: Record<string, unknown> = {};
    const calls: string[] = [];
    const ios = native(script, calls);
    const { runId } = iosRun();
    const { view } = await ios.start(maint, runId, { kind: "ios", key: (await ios.plan(maint, runId, "ios")).key });
    await waitFor(view.id, "preview.ready");
    script.hang = ["xcrun simctl terminate"];
    const t0 = Date.now();
    await ios.shutdown();
    expect(Date.now() - t0).toBeLessThan(8_000);
    expect(calls).toContain(`xcrun simctl terminate ${UDID} com.example.trips`);
    expect(of(view.id, "preview.stopped").map((e) => e.payload)).toEqual([{ previewId: view.id, reason: "shutdown" }]);
  });

  it("fails with build_failed and the build's tail when the build fails", async () => {
    const ios = make({
      platform: "darwin",
      tools: fakeTools({}),
      resolveNative: () => ({ file: process.execPath, args: ["-e", "console.log('error: no such module'); process.exit(65)", "--"] }),
    });
    const { runId } = iosRun();
    const { view } = await ios.start(maint, runId, { kind: "ios", key: (await ios.plan(maint, runId, "ios")).key });
    await waitFor(view.id, "preview.failed");
    expect(of(view.id, "preview.failed")[0]!.payload).toEqual({ previewId: view.id, reason: "build_failed", tail: ["error: no such module"] });
  });
});

describe("Android", () => {
  const PHONE = "R58M123TESTKEY";
  /** A run whose working copy holds one Android app module and the Gradle wrapper, with an SDK in the home folder. */
  function androidRun(): { runId: string; wt: string } {
    const r = makeRun(maint, { offer: false });
    writeFileSync(join(r.wt, "gradlew"), "#!/bin/sh\n");
    writeFileSync(join(r.wt, "settings.gradle"), "include ':app'\n");
    mkdirSync(join(r.wt, "app"), { recursive: true });
    writeFileSync(join(r.wt, "app", "build.gradle"), "plugins { id 'com.android.application' }\n");
    mkdirSync(join(dataDir, "Android", "Sdk"), { recursive: true });
    emit("preview.offered", { runId: r.runId, kind: "android", target: "app" }, { kind: "agent", id: r.runId });
    return r;
  }
  function native(script: Record<string, unknown>, calls: string[]): PreviewService {
    const full = { avds: ["Pixel_9_API_35"], emulatorState: join(dataDir, "emulator.state"), ...script };
    siteEnv = { THETERMINAL_FAKE_NATIVE: JSON.stringify(full) };
    return make({
      platform: "linux",
      tools: fakeTools(full, calls),
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
      resolveNative: (tool) => ({ file: process.execPath, args: [FAKE, tool.endsWith("gradlew") ? "gradlew" : tool] }),
    });
  }
  const adbCalls = (calls: string[]) => calls.filter((c) => c.startsWith("adb ") && c !== "adb version" && c !== "adb devices");

  it("boots an emulator when only a real phone is plugged in, and never touches the phone", async () => {
    const calls: string[] = [];
    const log = join(dataDir, "native.log");
    const android = native({ adbDevices: [`${PHONE}\tdevice`], log }, calls);
    const { runId } = androidRun();
    const { view } = await android.start(maint, runId, { kind: "android", key: (await android.plan(maint, runId, "android")).key });
    await vi.waitFor(() => expect(of(view.id, "preview.ready").length + of(view.id, "preview.failed").length).toBe(1), { timeout: 15_000 });
    expect(of(view.id, "preview.failed").map((e) => e.payload)).toEqual([]);
    await android.screenshot(maint, view.id);
    await android.stop(maint, view.id, "person");
    const adb = adbCalls(calls);
    expect(adb).toEqual(expect.arrayContaining([
      expect.stringMatching(/^adb -s emulator-5556 install -r /),
      "adb -s emulator-5556 shell monkey -p com.example.trips 1",
      "adb -s emulator-5556 shell am force-stop com.example.trips",
      "adb -s emulator-5556 emu kill",
    ]));
    expect(adb.every((c) => c.startsWith("adb -s emulator-5556 "))).toBe(true);
    expect(calls.some((c) => c.includes(PHONE))).toBe(false);
    const screencap = readFileSync(log, "utf8").split("\n").filter((l) => l.includes("screencap"));
    expect(screencap.map((l) => (JSON.parse(l) as { args: string[] }).args.slice(0, 3))).toEqual([["-s", "emulator-5556", "exec-out"]]);
  });

  it("uses an emulator that is already running, beside a real phone, and leaves it running", async () => {
    const calls: string[] = [];
    const android = native({ adbDevices: [`${PHONE}\tdevice`, "emulator-5554\tdevice"] }, calls);
    const { runId } = androidRun();
    const { view } = await android.start(maint, runId, { kind: "android", key: (await android.plan(maint, runId, "android")).key });
    await vi.waitFor(() => expect(of(view.id, "preview.ready").length + of(view.id, "preview.failed").length).toBe(1), { timeout: 15_000 });
    expect(of(view.id, "preview.failed").map((e) => e.payload)).toEqual([]);
    await android.stop(maint, view.id, "person");
    const adb = adbCalls(calls);
    expect(adb.length).toBeGreaterThan(0);
    expect(adb.every((c) => c.startsWith("adb -s emulator-5554 "))).toBe(true);
    expect(adb).toContain("adb -s emulator-5554 shell am force-stop com.example.trips");
    expect(adb.some((c) => c.includes("emu kill"))).toBe(false);
    expect(existsSync(join(dataDir, "emulator.state"))).toBe(false); // no emulator was started
  });
});

describe("screenshots", () => {
  it("needs the desktop app for a website", async () => {
    const { runId } = makeRun();
    const { view } = await service.start(maint, runId, { kind: "web", key: (await service.plan(maint, runId, "web")).key });
    await waitFor(view.id, "preview.ready");
    await refused(() => service.screenshot(maint, view.id), ScreenshotsUnavailableError);
  });

  it("stores what the desktop app captured, skips what is not a PNG, counts them on the card, and rebuilds the same", async () => {
    const card = new BoardService(db, ledger).addCard(owner, projectId, { title: "Site", stage: "build" });
    const capture = vi.fn(async () => [
      { device: "iphone16", png: pngOf(393, 852, "a") },
      { device: "pixel9", png: pngOf(412, 915, "b") },
      { device: "laptop", png: Buffer.from("not a png") },
    ]);
    const desk = make({ capture });
    const { runId } = makeRun(maint, { cardId: card.id });
    const { view } = await desk.start(maint, runId, { kind: "web", key: (await desk.plan(maint, runId, "web")).key });
    await waitFor(view.id, "preview.ready");
    const shots = await desk.screenshot(maint, view.id);
    expect(capture).toHaveBeenCalledWith(view.id);
    expect(shots.map((s) => [s.device, s.width, s.height])).toEqual([["iphone16", 393, 852], ["pixel9", 412, 915]]);
    expect(countCardScreenshots(db, card.id)).toBe(2);

    const before = [getPreview(db, view.id), listScreenshots(db, runId), latestOffer(db, runId, "web")];
    rebuildAllProjections(db, ledger);
    expect([getPreview(db, view.id), listScreenshots(db, runId), latestOffer(db, runId, "web")]).toEqual(before);
  });
});
