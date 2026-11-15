import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { registerStoryRoutes } from "../../src/server/story-routes.js";
import type { CardStory, LedgerEntry } from "@theterminal/shared";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { TOKEN_COOKIE } from "../../src/server/auth.js";
import { createServer, type RunningServer } from "../../src/server/server.js";

const NO_BUNDLED = { claude: () => null, codex: () => null, gemini: () => null };
const running: RunningServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (running.length) await running.pop()!.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), "tt-story-"));
  dirs.push(dataDir);
  const s = await createServer({ dataDir, port: 0, which: () => null, bundled: NO_BUNDLED, secrets: new MemorySecretStore() });
  running.push(s);
  return s;
}

const base = (s: RunningServer) => `http://127.0.0.1:${s.port}`;
const send = (s: RunningServer, method: string, path: string, body?: unknown, auth: "bearer" | "cookie" | "none" = "bearer") =>
  fetch(base(s) + path, {
    method,
    headers: {
      ...(auth === "bearer" && { authorization: `Bearer ${s.token}` }),
      ...(auth === "cookie" && { cookie: `${TOKEN_COOKIE}=${s.token}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await res).json() as Promise<T>;
const lines = (text: string) => text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);

/** Two projects, with a card in the first. */
async function seed(s: RunningServer) {
  const club = (await json<{ id: string }>(send(s, "POST", "/api/projects", { name: "Book Club" }))).id;
  const garden = (await json<{ id: string }>(send(s, "POST", "/api/projects", { name: "Garden Log" }))).id;
  const card = (await json<{ id: string }>(send(s, "POST", `/api/projects/${club}/cards`, { title: "Reading list", stage: "plan" }))).id;
  return { club, garden, card };
}

describe("story and export routes", { timeout: 15000 }, () => {
  it("GET /api/cards/:id/story is the card's story; an unknown card is 404", async () => {
    const s = await start();
    const { card } = await seed(s);
    const res = await send(s, "GET", `/api/cards/${card}/story`);
    expect(res.status).toBe(200);
    const story = (await res.json()) as CardStory;
    expect(story.card).toMatchObject({ id: card, title: "Reading list" });
    expect(story.entries.map((e) => e.type)).toEqual(["card.created"]);
    expect(story).toMatchObject({ runs: [], actions: [], gateDecisions: [], costUsd: null, integrity: { ok: true }, unreadable: [] });

    const missing = await send(s, "GET", "/api/cards/no-such-card/story");
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain("no-such-card");
  });

  it("exports one project as NDJSON: a verified header, then each entry with its headline", async () => {
    const s = await start();
    const { club } = await seed(s);
    const res = await send(s, "GET", `/api/ledger/export?projectId=${club}`, undefined, "cookie");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/x-ndjson/);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="theterminal-ledger-${club}.ndjson"`);

    const [header, ...body] = lines(await res.text());
    const rest = body.slice(0, -1);
    expect(body.at(-1)).toEqual({ kind: "end", lastSeq: 3, gaps: 0 });
    const stored = await json<LedgerEntry[]>(send(s, "GET", `/api/ledger?projectId=${club}`));
    expect(header).toMatchObject({ kind: "header", projectId: club, headSeq: 3, integrity: { ok: true, count: 3 } });
    expect(new Date(header!.exportedAt as string).toISOString()).toBe(header!.exportedAt);
    expect(rest).toHaveLength(stored.length);
    expect(rest.map((l) => l.seq)).toEqual(stored.map((e) => e.seq));
    // Exactly the stored entry, plus its kind and headline.
    for (const [i, line] of rest.entries()) {
      const { kind, headline, ...entry } = line;
      expect(kind).toBe("entry");
      expect(typeof headline).toBe("string");
      expect(entry).toEqual(stored[i]);
    }
    expect(rest[0]!.headline).toBe('Owner created the project "Book Club"');
    expect(rest.some((l) => l.projectId !== club)).toBe(false);
  });

  it("without projectId exports every project's entries", async () => {
    const s = await start();
    await seed(s);
    const res = await send(s, "GET", "/api/ledger/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="theterminal-ledger-all.ndjson"');
    const [header, ...body] = lines(await res.text());
    const rest = body.slice(0, -1);
    expect(body.at(-1)).toEqual({ kind: "end", lastSeq: 3, gaps: 0 });
    expect(header).toMatchObject({ kind: "header", projectId: null, headSeq: 3, integrity: { ok: true, count: 3 } });
    expect(rest.map((l) => l.headline)).toEqual([
      'Owner created the project "Book Club"',
      'Owner created the project "Garden Log"',
      expect.stringContaining("Reading list"),
    ]);
  });

  it("an unknown project is 404, without echoing the id or naming it in a header", async () => {
    const s = await start();
    await seed(s);
    const res = await send(s, "GET", `/api/ledger/export?projectId=${encodeURIComponent('x"; filename="evil')}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await res.text()).not.toContain("evil");
  });

  it("both routes answer 401 without the cookie or token", async () => {
    const s = await start();
    const { club, card } = await seed(s);
    for (const path of [`/api/cards/${card}/story`, `/api/ledger/export?projectId=${club}`, "/api/ledger/export"]) {
      expect((await send(s, "GET", path, undefined, "none")).status).toBe(401);
    }
  });
});

describe("export streaming", { timeout: 20000 }, () => {
  it("a client that disconnects mid-export does not break the server", async () => {
    const db = openDatabase(":memory:");
    const ledger = new Ledger(db);
    const actor = { kind: "human", id: "owner" } as const;
    db.transaction(() => {
      for (let i = 0; i < 5000; i++) {
        ledger.appendInTransaction({
          projectId: null, actor, type: "project.created", payload: { projectId: `p${i}`, name: `Club ${i}`, pitch: "x".repeat(200) },
        });
      }
    }).immediate();
    const app = Fastify();
    registerStoryRoutes(app, { db, ledger });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/ledger/export`;
      const abort = new AbortController();
      const res = await fetch(url, { signal: abort.signal });
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      abort.abort();
      await reader.read().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));

      // The server still answers, and a whole export still ends with its trailer.
      const text = await (await fetch(url)).text();
      const all = lines(text);
      expect(all).toHaveLength(5000 + 2);
      expect(all.at(-1)).toEqual({ kind: "end", lastSeq: 5000, gaps: 0 });
    } finally {
      await app.close();
      db.close();
    }
  });
});
