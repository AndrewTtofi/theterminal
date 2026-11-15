import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ROLES, type Role } from "@theterminal/shared";
import { openDatabase } from "../../src/db.js";
import { SessionStore } from "../../src/people/sessions.js";
import { ROUTE_ROLES, assertRoutesHaveRoles, registerAuth, requireRole } from "../../src/server/auth.js";
import { fakeDiscovery } from "../../src/link/discovery.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { createServer, type RunningServer } from "../../src/server/server.js";
import { COLLABORATORS, seedPeople } from "../fixtures/people.js";

const NO_BUNDLED = { claude: () => null, codex: () => null, gemini: () => null };
const running: RunningServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (running.length) await running.pop()!.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A server with a viewer, a reviewer and a maintainer signed in; the Owner holds the bearer token. */
async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), "tt-roles-"));
  dirs.push(dataDir);
  const cookies = seedPeople(dataDir);
  const s = await createServer({
    dataDir, port: 0, which: () => null, bundled: NO_BUNDLED, secrets: new MemorySecretStore(), discovery: fakeDiscovery(),
    linkBind: "127.0.0.1", linkPort: 0,
  });
  running.push(s);
  const as = (role: Role): Record<string, string> =>
    role === "owner" ? { authorization: `Bearer ${s.token}` } : { cookie: cookies[COLLABORATORS.find((p) => p.role === role)!.id]! };
  return { s, as };
}

const send = (s: RunningServer, method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  fetch(`http://127.0.0.1:${s.port}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

/** A route key as a request: the method and a path with placeholder ids (a bogus provider or gate is refused 400). */
function requestFor(key: string): { method: string; path: string } {
  const [method, pattern] = key.split(" ") as [string, string];
  const path = pattern.replace(/:[A-Za-z]+/g, (p) => (p === ":gateId" ? "go_live" : p === ":id" ? "x-id" : "x"));
  return { method, path };
}

/**
 * Keys ahead of their routes, by the task that lands them. Each is checked again as soon as its route exists; until
 * then the stale-key test skips it, and the role test only asserts the hook's 403 below the rank.
 */
const LANDING_LATER: Record<string, string> = {
  "GET /api/me": "T3b people routes",
  "PATCH /api/me": "T3b people routes",
  "POST /api/me/sign-out": "T3b people routes",
  "POST /api/me/credentials/passkey/options": "T3b people routes",
  "POST /api/me/credentials/passkey/verify": "T3b people routes",
  "POST /api/me/credentials/key/challenge": "T3b people routes",
  "POST /api/me/credentials/key": "T3b people routes",
  "DELETE /api/me/credentials/:id": "T3b people routes",
  "DELETE /api/me/sessions/:prefix": "T3b people routes",
  "GET /api/people": "T3b people routes",
  "GET /api/people/invites": "T3b people routes",
  "POST /api/people/invites": "T3b people routes",
  "DELETE /api/people/invites/:id": "T3b people routes",
  "PATCH /api/people/:id": "T3b people routes",
  "DELETE /api/people/:id": "T3b people routes",
  "POST /api/people/:id/sign-out": "T3b people routes",
  "GET /api/presence": "T8b events and presence",
  "GET /api/remote": "T6c remote listener wiring",
  "PUT /api/remote": "T6c remote listener wiring",
};
/** A WebSocket-only route: a plain GET is answered by the websocket plugin, not by a handler of ours. */
const WEBSOCKET_ONLY = new Set(["GET /api/events"]);

/** Fastify's own reply for a path no route matches, as distinct from a route of ours answering 404 `not_found`. */
const isUnmatched = (status: number, body: unknown) =>
  status === 404 && typeof body === "object" && body !== null && (body as { statusCode?: number }).statusCode === 404;

const below = (role: Role): Role | null => (role === "viewer" ? null : ROLES[ROLES.indexOf(role) - 1]!);
const ENTRIES = Object.entries(ROUTE_ROLES);

async function call(s: RunningServer, key: string, headers: Record<string, string>) {
  const { method, path } = requestFor(key);
  const res = await send(s, method, path, headers, method === "GET" || method === "DELETE" ? undefined : {});
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // a page or a stream: the status is what matters here
  }
  return { status: res.status, body };
}

describe("the role table and the routes", { timeout: 60_000 }, () => {
  it("every key in ROUTE_ROLES has a registered route (no stale entry), except those named as landing later", async () => {
    const { s, as } = await start();
    const stale: string[] = [];
    for (const [key] of ENTRIES) {
      if (key in LANDING_LATER || WEBSOCKET_ONLY.has(key)) continue;
      const { status, body } = await call(s, key, as("owner"));
      if (isUnmatched(status, body)) stale.push(key);
    }
    expect(stale).toEqual([]);
  });

  it("an unlisted route inside an encapsulated plugin is reported, so the server refuses to start", async () => {
    const db = openDatabase(":memory:");
    const app = Fastify();
    registerAuth(app, {
      token: "t", port: () => 1, hostRule: () => null, sessions: new SessionStore(db), person: () => null,
    });
    app.register(async (scope) => {
      scope.get("/api/plugin-unlisted", async () => "x");
      scope.get("/api/projects", async () => []); // listed: fine wherever it is registered
    });
    await app.ready();
    expect(assertRoutesHaveRoles(app)).toEqual(["GET /api/plugin-unlisted"]);
    await app.close();
    db.close();
  });

  it("one rank below the table's role answers 403 with the required role; the rank itself is not refused", async () => {
    const { s, as } = await start();
    const wrong: string[] = [];
    for (const [key, role] of ENTRIES) {
      // An unmatched path is Fastify's 404 whoever asks; the hook judges the role once the route exists.
      if (key in LANDING_LATER) continue;
      const lower = below(role);
      if (lower !== null) {
        const { status, body } = await call(s, key, as(lower));
        if (status !== 403 || JSON.stringify(body) !== JSON.stringify({ error: "forbidden", required: role })) {
          wrong.push(`${key}: ${lower} got ${status} ${JSON.stringify(body)}`);
        }
      } else {
        const anonymous = await call(s, key, {});
        if (anonymous.status !== 401) wrong.push(`${key}: nobody got ${anonymous.status}`);
      }
      if (WEBSOCKET_ONLY.has(key)) continue;
      const { status, body } = await call(s, key, as(role));
      if (status === 403 && JSON.stringify(body).includes('"forbidden"')) wrong.push(`${key}: ${role} got 403 ${JSON.stringify(body)}`);
    }
    expect(wrong).toEqual([]);
  });

  it("a viewer is refused 403 on every write", async () => {
    const { s, as } = await start();
    const allowed: string[] = [];
    for (const [key] of ENTRIES) {
      if (key.startsWith("GET ") || key in LANDING_LATER) continue;
      const { status } = await call(s, key, as("viewer"));
      if (status !== 403) allowed.push(`${key}: ${status}`);
    }
    expect(allowed).toEqual([]);
  });

  it("the route's own role check (requireRole) is a preHandler that names its role, so a route is guarded without the hook", async () => {
    const guard = requireRole("maintainer");
    expect((guard as unknown as { role: Role }).role).toBe("maintainer");
    const app = Fastify();
    app.decorateRequest("principal", null);
    app.get("/x", { preHandler: guard }, async () => "x");
    await app.ready();
    const res = await app.inject({ url: "/x" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
