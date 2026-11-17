import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OWNER_ID, type Actor, type AgentRun, type CardComment, type CardInfo, type HomeRuns } from "@theterminal/shared";
import { AgentCards } from "../../src/board/agent-cards.js";
import { BoardService } from "../../src/board/board-service.js";
import { openDatabase, type Db } from "../../src/db.js";
import { commitEvent } from "../../src/events/commit.js";
import { GateService } from "../../src/gates/service.js";
import { RecordedText } from "../../src/intake/service.js";
import { Ledger } from "../../src/ledger/ledger.js";
import type { FakeStep } from "../../src/agents/fake-adapter.js";
import { fakeDiscovery } from "../../src/link/discovery.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { registerCardRoutes } from "../../src/server/card-routes.js";
import { registerHomeRoutes } from "../../src/server/home-routes.js";
import { sendError } from "../../src/server/routes.js";
import { createServer, type RunningServer } from "../../src/server/server.js";
import { asPrincipal, fakeAuth } from "../fixtures/principal.js";
import { localFetch } from "../fixtures/local-fetch.js";

const owner: Actor = { kind: "human", id: OWNER_ID };
const same = (s: string) => s;

let db: Db;
let ledger: Ledger;
let board: BoardService;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  const recorded = new RecordedText({ username: "clubuser" });
  board = new BoardService(db, ledger, { recorded });
  const gates = new GateService({ db, ledger, recorded });
  const cards = new AgentCards({ db, ledger, gates, board, recorded });
  app = Fastify();
  fakeAuth(app);
  app.setErrorHandler((err, _req, reply) => sendError(err, reply, app.log));
  registerCardRoutes(app, { db, cards, clean: same });
  registerHomeRoutes(app, { db, clean: same });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
});

const emit = (projectId: string, type: string, payload: Record<string, unknown>, actor: Actor = owner) =>
  commitEvent(db, ledger, () => ({ event: { projectId, actor, type, payload } as never, result: () => undefined }));

/** A project with a card and a run of that card. */
function setup(name = "Club") {
  const p = board.createProject(owner, { name });
  const card = board.addCard(owner, p.id, { title: "Fix the form", stage: "plan" });
  const runId = `run-${name}`;
  emit(p.id, "agent.started", { runId, adapter: "claude", authMode: "none", prompt: "go", cardId: card.id, worktree: `w/${runId}` });
  return { projectId: p.id, cardId: card.id, runId };
}

const MAINTAINER = asPrincipal("Mara", "maintainer");
const VIEWER = asPrincipal("Vic", "viewer");
const REVIEWER = asPrincipal("Rae", "reviewer");

describe("card notes", () => {
  it("a viewer may not leave a note: 403 required maintainer", async () => {
    const { cardId } = setup();
    const res = await app.inject({ method: "POST", url: `/api/cards/${cardId}/comments`, headers: VIEWER, payload: { text: "hi" } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden", required: "maintainer" });
  });

  it("a maintainer's note is 201, waiting, with the maintainer's name; a viewer lists it", async () => {
    const { cardId } = setup();
    const res = await app.inject({ method: "POST", url: `/api/cards/${cardId}/comments`, headers: MAINTAINER, payload: { text: "Use the blue button" } });
    expect(res.statusCode).toBe(201);
    const c = res.json<CardComment>();
    expect(c).toMatchObject({ cardId, state: "waiting", authorName: "Mara", role: "maintainer", text: "Use the blue button" });
    const list = await app.inject({ method: "GET", url: `/api/cards/${cardId}/comments`, headers: VIEWER });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ comments: CardComment[] }>().comments.map((x) => x.id)).toEqual([c.id]);
  });

  it("a note of 2,500 characters is stored as 2,000", async () => {
    const { cardId } = setup();
    const res = await app.inject({ method: "POST", url: `/api/cards/${cardId}/comments`, headers: MAINTAINER, payload: { text: "a".repeat(2500) } });
    expect(res.statusCode).toBe(201);
    expect(res.json<CardComment>().text).toHaveLength(2000);
  });

  it("a note holding a secret is 400 secret_in_text, and the text is not echoed", async () => {
    const { cardId } = setup();
    const secret = "ghp_TESTKEY0123456789abcdefghijklmnopqrst";
    const before = ledger.headSeq();
    const res = await app.inject({ method: "POST", url: `/api/cards/${cardId}/comments`, headers: MAINTAINER, payload: { text: `the token is ${secret}` } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "secret_in_text" });
    expect(res.body).not.toContain(secret);
    expect(ledger.headSeq()).toBe(before);
  });

  it("an empty note and an unknown card are refused", async () => {
    const { cardId } = setup();
    const empty = await app.inject({ method: "POST", url: `/api/cards/${cardId}/comments`, headers: MAINTAINER, payload: { text: "   " } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: "invalid_input" });
    const unknown = await app.inject({ method: "POST", url: "/api/cards/nope/comments", headers: MAINTAINER, payload: { text: "hi" } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "not_found" });
    expect((await app.inject({ method: "GET", url: "/api/cards/nope/comments", headers: VIEWER })).json()).toEqual({ error: "not_found" });
  });
});

describe("move requests", () => {
  it("declining without a request is 404 not_found", async () => {
    const { cardId } = setup();
    const res = await app.inject({ method: "POST", url: `/api/cards/${cardId}/move-request/decline`, headers: REVIEWER, payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("Home lists a move request of another project with its name; declining it is 204 and Home no longer lists it", async () => {
    const a = setup("Alpha");
    const b = setup("Beta");
    emit(b.projectId, "card.move_requested", { cardId: b.cardId, runId: b.runId, from: "plan", to: "design" }, { kind: "agent", id: b.runId });
    const home = (await app.inject({ method: "GET", url: `/api/home?projectId=${a.projectId}`, headers: VIEWER })).json<HomeRuns>();
    expect(home.moveRequests).toEqual([
      expect.objectContaining({ cardId: b.cardId, projectId: b.projectId, projectName: "Beta", title: "Fix the form", from: "plan", to: "design" }),
    ]);
    const viewer = await app.inject({ method: "POST", url: `/api/cards/${b.cardId}/move-request/decline`, headers: VIEWER, payload: {} });
    expect(viewer.statusCode).toBe(403);
    const res = await app.inject({ method: "POST", url: `/api/cards/${b.cardId}/move-request/decline`, headers: REVIEWER, payload: {} });
    expect(res.statusCode).toBe(204);
    const after = (await app.inject({ method: "GET", url: "/api/home", headers: VIEWER })).json<HomeRuns>();
    expect(after.moveRequests).toEqual([]);
  });
});

describe("card info", () => {
  it("lists each card of the project with its run, notes and pending move; an unknown project is 404", async () => {
    const { projectId, cardId, runId } = setup();
    await app.inject({ method: "POST", url: `/api/cards/${cardId}/comments`, headers: MAINTAINER, payload: { text: "hi" } });
    emit(projectId, "card.move_requested", { cardId, runId, from: "plan", to: "design" }, { kind: "agent", id: runId });
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/cards/info`, headers: VIEWER });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ cards: CardInfo[] }>().cards).toEqual([
      expect.objectContaining({ cardId, runId, comments: 1, commentsWaiting: 1, moveRequest: { to: "design" } }),
    ]);
    expect((await app.inject({ method: "GET", url: "/api/projects/nope/cards/info", headers: VIEWER })).statusCode).toBe(404);
  });
});

describe("the server wires the agents' cards into the runner", () => {
  const KEYS = ["THETERMINAL_FAKE_AGENT", "THETERMINAL_FAKE_SCRIPT"] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  let server: RunningServer | null = null;
  let dataDir = "";

  afterEach(async () => {
    await server?.close().catch(() => undefined);
    server = null;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("a run's [[card: …]] makes a card linked to it, and its [[preview: …]] shows as an offer on Home", { timeout: 60_000 }, async () => {
    const script: FakeStep[] = [{ message: "[[card: Fix the form]]" }, { message: "[[preview: npm run dev | port 5173]]" }];
    process.env.THETERMINAL_FAKE_AGENT = "1";
    process.env.THETERMINAL_FAKE_SCRIPT = JSON.stringify(script);
    dataDir = mkdtempSync(join(tmpdir(), "tt-cards-"));
    server = await createServer({
      dataDir, port: 0, which: () => null, bundled: { claude: () => null, codex: () => null, gemini: () => null },
      secrets: new MemorySecretStore(), discovery: fakeDiscovery(), linkBind: "127.0.0.1", linkPort: 0,
    });
    const s = server;
    const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await localFetch(`http://127.0.0.1:${s.port}${path}`, {
        method, headers: { authorization: `Bearer ${s.token}`, ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      return (await res.json()) as T;
    };
    const p = await call<{ id: string }>("POST", "/api/projects", { name: "Alpha" });
    const run = await call<AgentRun>("POST", `/api/projects/${p.id}/runs`, { adapter: "fake", prompt: "go" });
    await vi.waitFor(async () => {
      const { cards } = await call<{ cards: CardInfo[] }>("GET", `/api/projects/${p.id}/cards/info`);
      expect(cards).toEqual([expect.objectContaining({ runId: run.id })]);
      const home = await call<HomeRuns>("GET", "/api/home");
      const shown = [...home.working, ...home.finishedToday].find((h) => h.run.id === run.id);
      expect(shown?.offers).toEqual(["web"]);
    }, { timeout: 20_000, interval: 100 });
  });
});
