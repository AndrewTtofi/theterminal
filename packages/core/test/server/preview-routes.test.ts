import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICES, OWNER_ID, type Actor, type NativeTools, type PreviewPlan, type PreviewView, type Screenshot } from "@theterminal/shared";
import { redact, truncate } from "../../src/agents/redact.js";
import { WorktreeManager } from "../../src/agents/worktrees.js";
import { BoardService } from "../../src/board/board-service.js";
import { openDatabase, type Db } from "../../src/db.js";
import { commitEvent } from "../../src/events/commit.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { storeScreenshot } from "../../src/preview/screenshots.js";
import { PreviewService, type PreviewDeps } from "../../src/preview/service.js";
import { SessionStore } from "../../src/people/sessions.js";
import { registerAuth } from "../../src/server/auth.js";
import { registerHomeRoutes } from "../../src/server/home-routes.js";
import type { PreviewHost } from "../../src/server/preview-host.js";
import { registerPreviewRoutes } from "../../src/server/preview-routes.js";
import { sendError } from "../../src/server/routes.js";
import { UI_CSP } from "../../src/server/static-ui.js";
import { registerStaticUi } from "../../src/server/static-ui.js";
import { PNG_1X1, pngOf } from "../fixtures/png.js";
import { asPrincipal, fakeAuth, onRemote } from "../fixtures/principal.js";

vi.setConfig({ testTimeout: process.platform === "win32" ? 60_000 : 20_000 });

const SITE = fileURLToPath(new URL("../fixtures/fake-site.mjs", import.meta.url));
const SECRET = "sk-ant-TESTKEY-0000000000";

const owner: Actor = { kind: "human", id: OWNER_ID };
const OWNER = asPrincipal(OWNER_ID, "owner");
const MAINTAINER = asPrincipal("m1", "maintainer");
const OTHER_MAINTAINER = asPrincipal("m2", "maintainer");
const REVIEWER = asPrincipal("r1", "reviewer");
const VIEWER = asPrincipal("v1", "viewer");

const TOOLS: NativeTools = {
  platform: "darwin",
  ios: { supported: true, xcode: "Xcode 17.0", simulators: [], missing: ["simulator"] },
  android: { supported: true, sdk: false, avds: [], missing: ["android_sdk"] },
};

let dataDir: string;
let uiDir: string;
let db: Db;
let ledger: Ledger;
let projectId: string;
let previews: PreviewService;
let app: FastifyInstance;
let siteEnv: Record<string, string>;
let host: PreviewHost | undefined;
let viewsCalls: Parameters<PreviewHost["views"]>[0][];

const spawn = ((file: string, args: string[], o: { env: NodeJS.ProcessEnv }) =>
  nodeSpawn(file, args, { ...o, env: { ...o.env, ...siteEnv } })) as unknown as typeof nodeSpawn;

const resolveWeb: PreviewDeps["resolveWeb"] = (cmd) => {
  if (cmd.join(" ") === "npm run dev") return { file: process.execPath, args: [SITE] };
  throw new Error("unexpected command");
};

async function build(o: { host?: PreviewHost } = {}) {
  previews = new PreviewService({
    db, ledger, dataDir, worktrees: new WorktreeManager(dataDir),
    clean: (_runId, s, max) => truncate(redact(s, [SECRET]), max),
    settling: () => false,
    platform: process.platform,
    homedir: dataDir,
    spawn,
    resolveWeb,
    ...(o.host !== undefined && { capture: (id: string) => o.host!.capture(id) }),
  });
  app = Fastify();
  fakeAuth(app);
  app.setErrorHandler((err, _req, reply) => sendError(err, reply, app.log));
  registerPreviewRoutes(app, {
    db, dataDir, previews, nativeTools: async () => TOOLS, uiDir, ...(o.host !== undefined && { previewHost: o.host }),
  });
  registerHomeRoutes(app, { db, clean: (s) => s });
  registerStaticUi(app, uiDir);
  await app.ready();
}

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "tt-preview-routes-")));
  uiDir = join(dataDir, "..", `${dataDir.split(/[\\/]/).pop()}-ui`);
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, "index.html"), "<html>ui</html>");
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  projectId = new BoardService(db, ledger).createProject(owner, { name: "Demo" }).id;
  siteEnv = {};
  viewsCalls = [];
  host = {
    views: async (m) => {
      viewsCalls.push(m);
      return true;
    },
    capture: async () => [{ device: "iphone16", png: PNG_1X1 }],
  };
});

afterEach(async () => {
  await previews?.shutdown();
  await app?.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(uiDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const emit = (type: string, payload: Record<string, unknown>, actor: Actor) =>
  commitEvent(db, ledger, () => ({ event: { projectId, actor, type, payload } as never, result: () => undefined }));

let runCount = 0;
/** A run started by `by` with a website offer and a working copy holding package.json and node_modules. */
function makeRun(by: string = "m1"): string {
  const runId = `run${++runCount}`;
  const rel = `projects/${projectId}/worktrees/${runId}`;
  const wt = join(dataDir, ...rel.split("/"));
  mkdirSync(join(wt, "node_modules"), { recursive: true });
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "site", scripts: { dev: "node site.mjs" } }));
  emit("agent.started", { runId, adapter: "fake", authMode: "none", prompt: "build the site", cardId: null, worktree: rel }, { kind: "human", id: by });
  emit("preview.offered", { runId, kind: "web", command: "npm run dev", port: 5173 }, { kind: "agent", id: runId });
  return runId;
}

/** A website preview recorded as ready on `port`, without a process. */
function readyPreview(runId: string, port: number, previewId = `pv-${runId}`): string {
  const by: Actor = { kind: "human", id: "m1" };
  emit("preview.requested", {
    previewId, runId, kind: "web", commands: [["npm", "run", "dev"]], key: "a".repeat(64), install: false, target: "npm run dev",
  }, by);
  emit("preview.started", { previewId, port }, by);
  emit("preview.ready", { previewId, origin: `http://127.0.0.1:${port}`, frameable: true, exposed: false }, by);
  return previewId;
}

const PREVIEW_ROUTES = (runId: string, previewId: string): [string, string, unknown?][] => [
  ["GET", `/api/runs/${runId}/preview/plan?kind=web`],
  ["POST", `/api/runs/${runId}/preview`, { kind: "web", key: "0".repeat(64) }],
  ["GET", `/api/previews/${previewId}`],
  ["POST", `/api/previews/${previewId}/stop`, { reason: "person" }],
  ["POST", `/api/previews/${previewId}/seen`, {}],
  ["POST", `/api/previews/${previewId}/screenshots`, {}],
  ["GET", "/api/host/capabilities"],
  ["POST", "/api/host/preview-views", { previewId, action: "show", devices: [] }],
  ["GET", "/api/host/native-tools"],
  ["GET", `/preview/${previewId}`],
];

describe("the local listener only", () => {
  it("every preview and host route gives 403 local_only to the Owner on the remote listener", async () => {
    await build({ host });
    const runId = makeRun();
    const previewId = readyPreview(runId, 5999);
    for (const [method, url, payload] of PREVIEW_ROUTES(runId, previewId)) {
      const res = await app.inject({ method: method as "GET", url, headers: { ...OWNER, ...onRemote }, ...(payload !== undefined && { payload: payload as object }) });
      expect(res.statusCode, url).toBe(403);
      expect(res.json(), url).toEqual({ error: "local_only" });
    }
  });
});

describe("plans and starts", () => {
  it("the Owner gets the plan; a maintainer on another person's run 403 preview_not_allowed; a reviewer 403 required maintainer", async () => {
    await build();
    const runId = makeRun("m1");
    const plan = await app.inject({ method: "GET", url: `/api/runs/${runId}/preview/plan?kind=web`, headers: OWNER });
    expect(plan.statusCode).toBe(200);
    expect(plan.json<PreviewPlan>()).toMatchObject({ kind: "web", commands: [["npm", "run", "dev"]], confirmedEarlier: false });
    const other = await app.inject({ method: "GET", url: `/api/runs/${runId}/preview/plan?kind=web`, headers: OTHER_MAINTAINER });
    expect(other.statusCode).toBe(403);
    expect(other.json()).toEqual({ error: "preview_not_allowed" });
    const reviewer = await app.inject({ method: "GET", url: `/api/runs/${runId}/preview/plan?kind=web`, headers: REVIEWER });
    expect(reviewer.statusCode).toBe(403);
    expect(reviewer.json()).toEqual({ error: "forbidden", required: "maintainer" });
    const own = await app.inject({ method: "GET", url: `/api/runs/${runId}/preview/plan?kind=web`, headers: MAINTAINER });
    expect(own.statusCode).toBe(200);
    const bad = await app.inject({ method: "GET", url: `/api/runs/${runId}/preview/plan?kind=desktop`, headers: OWNER });
    expect(bad.statusCode).toBe(400);
  });

  it("a run without an offer gives 404 no_preview_offer; an unknown run not_found", async () => {
    await build();
    const runId = makeRun();
    db.prepare("DELETE FROM preview_offers WHERE run_id = ?").run(runId);
    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}/preview/plan?kind=web`, headers: OWNER });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "no_preview_offer" });
    expect((await app.inject({ method: "GET", url: "/api/runs/nope/preview/plan?kind=web", headers: OWNER })).json()).toEqual({ error: "not_found" });
  });

  it("a script that is not in package.json gives 400 preview_refused with the reason", async () => {
    await build();
    const runId = makeRun();
    emit("preview.offered", { runId, kind: "web", command: "npm run start", port: 5173 }, { kind: "agent", id: runId });
    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}/preview/plan?kind=web`, headers: OWNER });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "preview_refused", reason: "script_missing" });
  });

  it("a stale key gets preview_changed", async () => {
    await build();
    const runId = makeRun();
    const before = ledger.headSeq();
    const res = await app.inject({ method: "POST", url: `/api/runs/${runId}/preview`, headers: OWNER, payload: { kind: "web", key: "0".repeat(64) } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "preview_changed" });
    expect(ledger.headSeq()).toBe(before);
  });

  it("a start with the plan's key is 201 starting; the same again is 200 with the same preview; a reviewer may watch it and say it is seen", async () => {
    await build();
    const runId = makeRun("m1");
    const { key } = (await app.inject({ method: "GET", url: `/api/runs/${runId}/preview/plan?kind=web`, headers: MAINTAINER })).json<PreviewPlan>();
    const first = await app.inject({ method: "POST", url: `/api/runs/${runId}/preview`, headers: MAINTAINER, payload: { kind: "web", key } });
    expect(first.statusCode).toBe(201);
    const view = first.json<PreviewView>();
    expect(view).toMatchObject({ runId, kind: "web", state: "starting" });
    const again = await app.inject({ method: "POST", url: `/api/runs/${runId}/preview`, headers: MAINTAINER, payload: { kind: "web", key } });
    expect(again.statusCode).toBe(200);
    expect(again.json<PreviewView>().id).toBe(view.id);
    const watched = await app.inject({ method: "GET", url: `/api/previews/${view.id}`, headers: REVIEWER });
    expect(watched.statusCode).toBe(200);
    expect(watched.json<PreviewView>().id).toBe(view.id);
    expect((await app.inject({ method: "POST", url: `/api/previews/${view.id}/seen`, headers: REVIEWER, payload: {} })).statusCode).toBe(204);
    const stopReviewer = await app.inject({ method: "POST", url: `/api/previews/${view.id}/stop`, headers: REVIEWER, payload: { reason: "person" } });
    expect(stopReviewer.statusCode).toBe(403);
    const stopOther = await app.inject({ method: "POST", url: `/api/previews/${view.id}/stop`, headers: OTHER_MAINTAINER, payload: { reason: "person" } });
    expect(stopOther.json()).toEqual({ error: "preview_not_allowed" });
    const stop = await app.inject({ method: "POST", url: `/api/previews/${view.id}/stop`, headers: MAINTAINER, payload: { reason: "tab_closed" } });
    expect(stop.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/previews/${view.id}`, headers: REVIEWER })).json<PreviewView>().state).toBe("stopped");
    expect((await app.inject({ method: "GET", url: "/api/previews/nope", headers: REVIEWER })).json()).toEqual({ error: "not_found" });
  });

  it("Home shows a run's offers and its live preview", async () => {
    await build();
    const runId = makeRun();
    const previewId = readyPreview(runId, 5999);
    const home = (await app.inject({ method: "GET", url: "/api/home", headers: VIEWER })).json<{ working: { run: { id: string }; offers: string[]; livePreviewId: string | null }[] }>();
    expect(home.working).toEqual([expect.objectContaining({ offers: ["web"], livePreviewId: previewId })]);
  });
});

describe("the host's device views", () => {
  it("without a host: 404 preview_host_unavailable, and the capability says no", async () => {
    await build();
    const runId = makeRun();
    const previewId = readyPreview(runId, 5999);
    const res = await app.inject({
      method: "POST", url: "/api/host/preview-views", headers: REVIEWER,
      payload: { previewId, action: "show", devices: [{ device: "iphone16", rotated: false, x: 0, y: 0, width: 393, height: 852 }] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "preview_host_unavailable" });
    expect((await app.inject({ method: "GET", url: "/api/host/capabilities", headers: REVIEWER })).json()).toEqual({ previewViews: false });
  });

  it("with a host: passes the recorded origin and each device's viewport, scale, mobile and user agent; a rotated iPad is 1180×820", async () => {
    await build({ host });
    expect((await app.inject({ method: "GET", url: "/api/host/capabilities", headers: REVIEWER })).json()).toEqual({ previewViews: true });
    const runId = makeRun();
    const previewId = readyPreview(runId, 5999);
    const res = await app.inject({
      method: "POST", url: "/api/host/preview-views", headers: REVIEWER,
      payload: {
        previewId, action: "show",
        devices: [
          { device: "iphone16", rotated: false, x: 10, y: 20, width: 393, height: 852 },
          { device: "ipad", rotated: true, x: 420, y: 20, width: 590, height: 410 },
        ],
      },
    });
    expect(res.statusCode).toBe(204);
    expect(viewsCalls).toEqual([{
      previewId, origin: "http://127.0.0.1:5999", action: "show",
      views: [
        {
          device: "iphone16", x: 10, y: 20, width: 393, height: 852, viewport: { width: 393, height: 852 },
          scale: DEVICES.iphone16.scale, mobile: true, userAgent: DEVICES.iphone16.userAgent,
        },
        {
          device: "ipad", x: 420, y: 20, width: 590, height: 410, viewport: { width: 1180, height: 820 },
          scale: DEVICES.ipad.scale, mobile: true, userAgent: DEVICES.ipad.userAgent,
        },
      ],
    }]);
  });

  it("refuses more than four devices, an unknown device, and a preview that is not a ready website", async () => {
    await build({ host });
    const runId = makeRun();
    const previewId = readyPreview(runId, 5999);
    const d = { device: "laptop", rotated: false, x: 0, y: 0, width: 100, height: 100 };
    const five = await app.inject({ method: "POST", url: "/api/host/preview-views", headers: REVIEWER, payload: { previewId, action: "show", devices: [d, d, d, d, d] } });
    expect(five.statusCode).toBe(400);
    const unknown = await app.inject({
      method: "POST", url: "/api/host/preview-views", headers: REVIEWER, payload: { previewId, action: "show", devices: [{ ...d, device: "nokia" }] },
    });
    expect(unknown.statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: "/api/host/preview-views", headers: REVIEWER, payload: { previewId: "nope", action: "show", devices: [d] } });
    expect(missing.json()).toEqual({ error: "not_found" });
    emit("preview.stopped", { previewId, reason: "person" }, { kind: "human", id: "m1" });
    const stopped = await app.inject({ method: "POST", url: "/api/host/preview-views", headers: REVIEWER, payload: { previewId, action: "show", devices: [d] } });
    expect(stopped.json()).toEqual({ error: "not_found" });
    // Closing the views of an ended preview is always allowed.
    const close = await app.inject({ method: "POST", url: "/api/host/preview-views", headers: REVIEWER, payload: { previewId, action: "close", devices: [] } });
    expect(close.statusCode).toBe(204);
    expect(viewsCalls.at(-1)).toMatchObject({ previewId, action: "close", views: [] });
    expect((await app.inject({ method: "POST", url: "/api/host/preview-views", headers: VIEWER, payload: { previewId, action: "close", devices: [] } })).statusCode).toBe(403);
  });
});

describe("the preview page", () => {
  it("a ready preview's page has frame-src for its origin and frame-ancestors 'self'; the main page keeps UI_CSP exactly", async () => {
    await build();
    const runId = makeRun();
    const previewId = readyPreview(runId, 5999);
    const page = await app.inject({ method: "GET", url: `/preview/${previewId}`, headers: REVIEWER });
    expect(page.statusCode).toBe(200);
    expect(page.body).toBe("<html>ui</html>");
    const csp = page.headers["content-security-policy"] as string;
    expect(csp).toContain("frame-src http://127.0.0.1:5999");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
    expect((await app.inject({ method: "GET", url: "/" })).headers["content-security-policy"]).toBe(UI_CSP);
    expect((await app.inject({ method: "GET", url: `/preview/${previewId}`, headers: VIEWER })).statusCode).toBe(403);
  });

  it("an unknown or ended preview's page is 404", async () => {
    await build();
    const runId = makeRun();
    const previewId = readyPreview(runId, 5999);
    expect((await app.inject({ method: "GET", url: "/preview/nope", headers: REVIEWER })).statusCode).toBe(404);
    emit("preview.stopped", { previewId, reason: "person" }, { kind: "human", id: "m1" });
    const ended = await app.inject({ method: "GET", url: `/preview/${previewId}`, headers: REVIEWER });
    expect(ended.statusCode).toBe(404);
    expect(ended.json()).toEqual({ error: "not_found" });
  });

  it("a request from the preview's origin gets bad_origin", async () => {
    const sessions = new SessionStore(db);
    const guarded = Fastify();
    registerAuth(guarded, { token: "zq-TESTKEY-token", port: () => 4321, hostRule: () => null, sessions, person: () => null, listenerOf: () => "local" });
    registerHomeRoutes(guarded, { db, clean: (s) => s });
    await guarded.ready();
    try {
      const runId = makeRun();
      readyPreview(runId, 5999);
      const headers = { host: "127.0.0.1:4321", authorization: "Bearer zq-TESTKEY-token" };
      expect((await guarded.inject({ method: "GET", url: "/api/home", headers })).statusCode).toBe(200);
      const res = await guarded.inject({ method: "GET", url: "/api/home", headers: { ...headers, origin: "http://127.0.0.1:5999" } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "bad_origin" });
    } finally {
      await guarded.close();
    }
  });
});

describe("screenshots", () => {
  it("lists a run's screenshots for a viewer, and serves a recorded pair's bytes with the four headers; another run's pair is 404", async () => {
    await build();
    const runId = makeRun();
    const otherRun = makeRun();
    const previewId = readyPreview(runId, 5999);
    const stored = storeScreenshot(dataDir, projectId, PNG_1X1);
    emit("preview.screenshot", {
      previewId, runId, device: "iPhone 16", sha256: stored.sha256, bytes: stored.bytes, width: stored.width, height: stored.height,
    }, { kind: "human", id: "m1" });
    const list = await app.inject({ method: "GET", url: `/api/runs/${runId}/screenshots`, headers: VIEWER });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ screenshots: Screenshot[] }>().screenshots).toEqual([expect.objectContaining({ sha256: stored.sha256, runId, device: "iPhone 16" })]);
    expect((await app.inject({ method: "GET", url: "/api/runs/nope/screenshots", headers: VIEWER })).statusCode).toBe(404);

    const wrong = await app.inject({ method: "GET", url: `/api/screenshots/${stored.sha256}?runId=${otherRun}`, headers: VIEWER });
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json()).toEqual({ error: "not_found" });
    const res = await app.inject({ method: "GET", url: `/api/screenshots/${stored.sha256}?runId=${runId}`, headers: VIEWER });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG_1X1)).toBe(true);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(res.headers["cache-control"]).toBe("private, max-age=86400");
    expect((await app.inject({ method: "GET", url: `/api/screenshots/not-a-sha?runId=${runId}`, headers: VIEWER })).statusCode).toBe(400);
  });

  it("taking screenshots: a website without the desktop app is 409 screenshots_unavailable; with it, 201 and the PNGs recorded", async () => {
    await build();
    const runId = makeRun("m1");
    const { key } = (await app.inject({ method: "GET", url: `/api/runs/${runId}/preview/plan?kind=web`, headers: MAINTAINER })).json<PreviewPlan>();
    const view = (await app.inject({ method: "POST", url: `/api/runs/${runId}/preview`, headers: MAINTAINER, payload: { kind: "web", key } })).json<PreviewView>();
    const none = await app.inject({ method: "POST", url: `/api/previews/${view.id}/screenshots`, headers: MAINTAINER, payload: {} });
    expect(none.statusCode).toBe(409);
    expect(none.json()).toEqual({ error: "screenshots_unavailable" });
    await previews.shutdown();
    await app.close();

    await build({ host: { ...host!, capture: async () => [{ device: "iphone16", png: pngOf(393, 852) }] } });
    const run2 = makeRun("m1");
    const plan2 = (await app.inject({ method: "GET", url: `/api/runs/${run2}/preview/plan?kind=web`, headers: MAINTAINER })).json<PreviewPlan>();
    const view2 = (await app.inject({ method: "POST", url: `/api/runs/${run2}/preview`, headers: MAINTAINER, payload: { kind: "web", key: plan2.key } })).json<PreviewView>();
    const reviewer = await app.inject({ method: "POST", url: `/api/previews/${view2.id}/screenshots`, headers: REVIEWER, payload: {} });
    expect(reviewer.statusCode).toBe(403);
    const shot = await app.inject({ method: "POST", url: `/api/previews/${view2.id}/screenshots`, headers: MAINTAINER, payload: {} });
    expect(shot.statusCode).toBe(201);
    expect(shot.json<{ screenshots: Screenshot[] }>().screenshots).toEqual([expect.objectContaining({ runId: run2, width: 393, height: 852 })]);
  });
});

describe("native tools", () => {
  it("are the Owner's alone", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/api/host/native-tools", headers: OWNER });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(TOOLS);
    const maint = await app.inject({ method: "GET", url: "/api/host/native-tools", headers: MAINTAINER });
    expect(maint.json()).toEqual({ error: "forbidden", required: "owner" });
  });
});

describe("no-secrets: a preview whose site prints a key and fails", () => {
  it("no response body, ledger entry or log line holds the key or the data folder's path", async () => {
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" "))),
    );
    try {
      siteEnv = { FAKE_SITE_PRINT: `starting\nthe key is ${SECRET}\n`, FAKE_SITE_EXIT: "1" };
      await build();
      const bodies: string[] = [];
      const call = async (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: object) => {
        const res = await app.inject({ method, url, headers, ...(payload !== undefined && { payload }) });
        bodies.push(res.body);
        return res;
      };
      const runId = makeRun("m1");
      const { key } = (await call("GET", `/api/runs/${runId}/preview/plan?kind=web`, MAINTAINER)).json<PreviewPlan>();
      const view = (await call("POST", `/api/runs/${runId}/preview`, MAINTAINER, { kind: "web", key })).json<PreviewView>();
      await vi.waitFor(async () => {
        const v = (await call("GET", `/api/previews/${view.id}`, REVIEWER)).json<PreviewView>();
        expect(v.state).toBe("failed");
      }, { timeout: 15_000, interval: 50 });
      const failed = (await call("GET", `/api/previews/${view.id}`, REVIEWER)).json<PreviewView>();
      expect(failed.error).toBe("exited");
      expect(failed.tail.join("\n")).toContain("[REDACTED]");
      await call("GET", "/api/home", VIEWER);
      await call("GET", `/api/runs/${runId}/screenshots`, VIEWER);
      await call("POST", `/api/runs/${runId}/preview`, MAINTAINER, { kind: "web", key: "0".repeat(64) });
      const leaks = [
        ...bodies.filter((b) => b.includes(SECRET)).map((b) => `response: ${b.slice(0, 80)}`),
        ...bodies.filter((b) => b.includes(dataDir)).map((b) => `path: ${b.slice(0, 80)}`),
        ...logged.filter((l) => l.includes(SECRET)).map(() => "log"),
        ...ledger.list({ limit: 5000 }).filter((e) => JSON.stringify(e).includes(SECRET)).map((e) => `ledger ${e.type}`),
      ];
      expect(leaks).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
