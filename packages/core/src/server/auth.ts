import { createHash, timingSafeEqual } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import cookie, { type CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { OWNER_ID, atLeast, type Actor, type Listener, type Person, type Principal, type Role } from "@theterminal/shared";
import type { SessionStore } from "../people/sessions.js";
import { checkRemoteHost, listenerOf as tlsListenerOf, type HostRule } from "./remote.js";

export const TOKEN_COOKIE = "tt_token";
export const SESSION_COOKIE = "tt_session";
/**
 * The workspace's own hostname. Browsers do not separate cookies by port, so the local cookies live on this host-only
 * name and are never sent to other local servers on 127.0.0.1 or localhost.
 */
export const APP_HOST = "theterminal.localhost";
/** Route config marking a route as reachable without signing in: `{ config: PUBLIC_ROUTE }`. */
export const PUBLIC_ROUTE = { public: true } as const;
type PublicConfig = { public?: boolean };

export type { Principal } from "@theterminal/shared";
/** One copy of the remote listener's rules: a TLS socket is the remote listener, and its Host rule lives there. */
export { listenerOf, remoteHostAllowed, type HostRule } from "./remote.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Who makes the request; null on a public route or before the hook ran. */
    principal: Principal | null;
    /** Which listener the request arrived on. */
    listener: Listener;
  }
}

export type AuthDeps = {
  token: string;
  /** The local listener's port, read per request (it is bound after the routes are registered). */
  port: () => number;
  /** The remote listener's Host rule, or null while there is no remote listener: every remote request is then refused. */
  hostRule: () => HostRule | null;
  sessions: SessionStore;
  /** The person behind a session, read on every request so a rename, role change or removal shows at once. */
  person: (id: string) => Person | null;
  /** Tests only: which listener a request is on. Default: the TLS check. */
  listenerOf?: (request: FastifyRequest) => Listener;
};

/** Routes reachable without signing in, by exact key (see `routeKey`). The ACME challenge is served by the plain :80 server. */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  "GET /",
  "GET /*",
  "GET /join/*",
  "GET /sign-in",
  "GET /healthz",
  "GET /api/join/:code",
  "POST /api/join/:code/passkey/options",
  "POST /api/join/:code/passkey/verify",
  "POST /api/join/:code/key/challenge",
  "POST /api/join/:code/key",
  "POST /api/auth/passkey/options",
  "POST /api/auth/passkey/verify",
  "POST /api/auth/key/challenge",
  "POST /api/auth/key/verify",
]);

const viewer = "viewer";
const reviewer = "reviewer";
const maintainer = "maintainer";
const owner = "owner";

/**
 * The minimum role for every route, by `routeKey`. There is no default: a route that is not here and not public is
 * refused at startup (`assertRoutesHaveRoles`) and, should one slip through, answers 500 on every request. HEAD
 * twins take their GET's entry.
 *
 * Only the Owner decides what leaves the machine (share preview, confirm and links) and holds credentials (connections,
 * link pairing, the other machine's connections); LAN addresses are the Owner's business. A viewer is read-only, so
 * file contents from agent worktrees and the ledger export with names need a reviewer.
 */
export const ROUTE_ROLES: Record<string, Role> = {
  // viewer: the board, the ledger, runs and their outcomes, status, their own account
  "GET /api/health": viewer,
  "GET /api/projects": viewer,
  "GET /api/projects/:id/board": viewer,
  "GET /api/cards/:id/gates": viewer,
  "GET /api/ledger": viewer,
  "GET /api/agents": viewer,
  "GET /api/projects/:id/runs": viewer,
  "GET /api/projects/:id/pending-actions": viewer,
  "GET /api/pending-actions": viewer,
  "GET /api/runs/:id": viewer,
  "GET /api/connections": viewer,
  "GET /api/status": viewer,
  "GET /api/capacity": viewer,
  "GET /api/projects/:id/intake": viewer,
  "GET /api/cards/:id/story": viewer,
  "GET /api/github/overview": viewer,
  "GET /api/events": viewer,
  "GET /api/me": viewer,
  "PATCH /api/me": viewer,
  "POST /api/me/sign-out": viewer,
  "POST /api/me/credentials/passkey/options": viewer,
  "POST /api/me/credentials/passkey/verify": viewer,
  "POST /api/me/credentials/key/challenge": viewer,
  "POST /api/me/credentials/key": viewer,
  "DELETE /api/me/credentials/:id": viewer,
  "DELETE /api/me/sessions/:prefix": viewer,
  "GET /api/people": viewer,
  "GET /api/presence": viewer,
  "GET /api/remote": viewer,
  "GET /api/projects/:id/share/snapshots": viewer,
  "GET /api/share/snapshots/:id": viewer,
  "GET /api/share/snapshots/:id/download": viewer,
  "GET /api/projects/:id/digests": viewer,
  "GET /api/share/links": viewer,
  // reviewer: decisions, gate moves, and the contents of agent worktrees
  "POST /api/cards/:id/move": reviewer,
  "POST /api/actions/:id/decision": reviewer,
  "POST /api/projects/:id/intake/decisions": reviewer,
  "POST /api/projects/:id/intake/complete": reviewer,
  "GET /api/ledger/export": reviewer,
  "GET /api/runs/:id/changes": reviewer,
  "GET /api/runs/:id/diff": reviewer,
  "GET /api/runs/:id/files": reviewer,
  "GET /api/runs/:id/file": reviewer,
  "GET /api/link/verify": reviewer,
  // maintainer: projects, cards, runs and intake
  "POST /api/projects": maintainer,
  "POST /api/projects/:id/cards": maintainer,
  "POST /api/cards/:id/status": maintainer,
  "POST /api/projects/:id/runs": maintainer,
  "POST /api/runs/:id/stop": maintainer,
  "POST /api/projects/:id/intake": maintainer,
  "POST /api/projects/:id/intake/answers": maintainer,
  "POST /api/projects/:id/intake/reopen": maintainer,
  // owner: credentials, machines, people, remote access, and what leaves this machine
  "POST /api/settings/provider-auth": owner,
  "POST /api/settings/claude-auth": owner,
  "GET /api/connections/catalog": owner,
  "POST /api/connections": owner,
  "GET /api/connections/:id": owner,
  "PATCH /api/connections/:id": owner,
  "DELETE /api/connections/:id": owner,
  "POST /api/connections/:id/test": owner,
  "GET /api/connections/signin-status": owner,
  "POST /api/connections/signin/:provider": owner,
  "GET /api/connections/signin/:id": owner,
  "DELETE /api/connections/signin/:id": owner,
  "POST /api/capacity/detect": owner,
  "POST /api/runs/:id/override/command": owner,
  "POST /api/runs/:id/override/discard": owner,
  "GET /api/people/invites": owner,
  "POST /api/people/invites": owner,
  "DELETE /api/people/invites/:id": owner,
  "PATCH /api/people/:id": owner,
  "DELETE /api/people/:id": owner,
  "POST /api/people/:id/sign-out": owner,
  "PUT /api/remote": owner,
  "PUT /api/projects/:id/gates/:gateId/requirement": owner,
  "GET /api/link": owner,
  "GET /api/link/machines": owner,
  "POST /api/link/name": owner,
  "POST /api/link/enable": owner,
  "POST /api/link/disable": owner,
  "POST /api/link/code": owner,
  "DELETE /api/link/code": owner,
  "POST /api/link/pair": owner,
  "DELETE /api/link/machines/:id": owner,
  "GET /api/link/machines/:id/capacity": owner,
  "POST /api/projects/:id/share/preview": owner,
  "POST /api/projects/:id/share/confirm": owner,
  "GET /api/share/addresses": owner,
  "POST /api/share/snapshots/:id/links": owner,
  "DELETE /api/share/links/:id": owner,
};

/** `<METHOD> <route pattern>`; HEAD is keyed as its GET (Fastify adds a HEAD twin to every GET route). */
export function routeKey(method: string, url: string): string {
  const m = method.toUpperCase();
  return `${m === "HEAD" ? "GET" : m} ${url}`;
}

/** The session cookie: never readable by scripts, never sent cross-site, and only over TLS on the remote listener. */
export function sessionCookieOptions(listener: Listener): CookieSerializeOptions {
  return { httpOnly: true, sameSite: "strict", path: "/", ...(listener === "remote" && { secure: true }) };
}

/**
 * The key a client's attempts are counted under (the auth throttle, challenges): the IPv4 address, or the /64 of an
 * IPv6 address, since one host usually holds a whole /64 and could otherwise rotate through it. An IPv4-mapped
 * address counts as its IPv4. Anything else is used as given.
 */
export function clientKey(ip: string): string {
  if (typeof ip !== "string") return "";
  if (isIPv4(ip)) return ip;
  const bare = ip.split("%")[0]!;
  if (!isIPv6(bare)) return ip.slice(0, 64);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped) return mapped[1]!;
  const [left = "", right = ""] = bare.split("::");
  const head = left === "" ? [] : left.split(":");
  const tail = right === "" ? [] : right.split(":");
  const groups = [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

const FORBIDDEN = (required: Role) => ({ error: "forbidden", required });

/** The role a `requireRole` preHandler checks, readable on the handler itself (tests compare it with the table). */
export type RoleGuard = preHandlerAsyncHookHandler & { readonly role: Role };

/**
 * A preHandler refusing anyone below `min` with 403 `{ error: "forbidden", required: min }` (401 with no principal).
 * Every route carries one: the hook's table decides first, and this check holds even on an app without the hook.
 */
export function requireRole(min: Role): RoleGuard {
  const guard: preHandlerAsyncHookHandler = async (request, reply) => {
    const p = request.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    if (!atLeast(p.role, min)) return reply.code(403).send(FORBIDDEN(min));
  };
  return Object.assign(guard, { role: min });
}

/** Route options with the role check: `app.get(url, needs("viewer"), handler)`. */
export function needs(min: Role): { preHandler: RoleGuard } {
  return { preHandler: requireRole(min) };
}

/** The signed-in person as the actor of what a route records. */
export function actorOf(request: FastifyRequest): Actor {
  const p = request.principal;
  if (!p) throw new Error("actorOf: the request has no principal");
  return { kind: "human", id: p.personId };
}

/** Every route key registered on an app the auth hook guards, collected as routes are added (HEAD twins too). */
const registries = new WeakMap<FastifyInstance, { keys: Set<string>; publicKeys: Set<string> }>();

/**
 * Startup check: every registered route (each method of a multi-method route; HEAD twins skipped, since they take
 * their GET's entry) is in ROUTE_ROLES, in PUBLIC_ROUTES or has `config.public`. Returns the keys that are in none,
 * so the server can refuse to start. Throws when `registerAuth` never ran on this app, so nothing is judged blind.
 */
export function assertRoutesHaveRoles(app: FastifyInstance): string[] {
  const registry = registries.get(app);
  if (!registry) throw new Error("assertRoutesHaveRoles: registerAuth was not called on this app");
  const missing: string[] = [];
  for (const key of registry.keys) {
    if (key.startsWith("HEAD ")) continue;
    if (ROUTE_ROLES[key] !== undefined || PUBLIC_ROUTES.has(key) || registry.publicKeys.has(key)) continue;
    missing.push(key);
  }
  return missing;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

function tokenMatches(expected: Buffer, given: unknown): boolean {
  return typeof given === "string" && timingSafeEqual(expected, digest(given));
}

const isPublicRoute = (key: string | null, config: unknown): boolean =>
  key !== null && (PUBLIC_ROUTES.has(key) || (config as PublicConfig | undefined)?.public === true);

/**
 * The guard on every request, for both listeners, in this order: the listener; the Host (local: the app hostname or
 * loopback with the local port; remote: the remote listener's rule, `/healthz` exempt); on remote, the token is
 * never compared (a bearer or `/?token=` is 401 before anything else); public routes pass with no principal; the
 * Origin (local: the same three hosts over http; remote: `https://<host>` only), on WebSocket upgrades too; the
 * principal (local: the token as the Owner; else the session cookie, bound to this listener, for a current person);
 * the route's minimum role, from the table, failing closed.
 */
export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const expected = digest(deps.token);
  const listenerOf = deps.listenerOf ?? tlsListenerOf;
  app.register(cookie);
  app.decorateRequest("principal", null);
  app.decorateRequest("listener", "local");

  const registry = { keys: new Set<string>(), publicKeys: new Set<string>() };
  registries.set(app, registry);
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) {
      const key = `${m.toUpperCase()} ${route.url}`;
      registry.keys.add(key);
      if ((route.config as PublicConfig | undefined)?.public === true) registry.publicKeys.add(key);
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    // Rejections on a WebSocket upgrade must also drop the socket, or it stays open forever.
    const reject = (code: number, body: Record<string, unknown>) => {
      if (request.headers.upgrade) {
        reply.header("connection", "close");
        reply.raw.once("finish", () => request.raw.socket.destroy());
      }
      return reply.code(code).send(body);
    };

    const listener = listenerOf(request);
    request.listener = listener;
    request.principal = null;
    const host = (request.headers.host ?? "").toLowerCase();
    const routeUrl = request.routeOptions.url;
    const key = routeUrl === undefined ? null : routeKey(request.method, routeUrl);
    const port = deps.port();
    const appHost = `${APP_HOST}:${port}`;

    if (listener === "remote") {
      const rule = deps.hostRule();
      if (rule === null || !checkRemoteHost(request, rule)) return reject(403, { error: "bad_host" });
      // The token belongs to the local listener alone: it is never compared here, and never traded for a cookie.
      if (request.headers.authorization !== undefined) return reject(401, { error: "unauthorized" });
      if (request.method === "GET" && routeUrl === "/" && new URL(request.url, "http://localhost").searchParams.has("token")) {
        return reject(401, { error: "unauthorized" });
      }
    } else {
      // Local: stops other websites (CSRF, DNS rebinding) and other local apps from reaching the workspace.
      if (host !== appHost && host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        return reject(403, { error: "bad_host" });
      }
      // Bootstrap: GET /?token= trades the token for an HttpOnly cookie. Honoured on "/" only, so the token never
      // has to appear in logs or referrers for any other path.
      if (request.method === "GET" && routeUrl === "/") {
        const given = new URL(request.url, "http://localhost").searchParams.get("token");
        if (given !== null) {
          if (!tokenMatches(expected, given)) return reject(401, { error: "unauthorized" });
          // Only the app hostname may receive the cookie; loopback hosts are bounced there.
          if (host !== appHost) return reply.redirect(`http://${appHost}/?token=${encodeURIComponent(given)}`, 302);
          return reply
            .setCookie(TOKEN_COOKIE, deps.token, { httpOnly: true, sameSite: "strict", path: "/" })
            .redirect("/", 302);
        }
      }
    }

    // Default-deny, keyed on the matched route (find-my-way matches the decoded path, so the raw URL cannot be trusted).
    if (isPublicRoute(key, request.routeOptions.config)) return;

    // SameSite ignores ports, so a page on another loopback port would carry our cookie; on remote only the page
    // served over this very host, over TLS, may call.
    const origin = request.headers.origin;
    if (origin !== undefined) {
      const o = origin.toLowerCase();
      const allowed =
        listener === "remote"
          ? o === `https://${host}`
          : o === `http://${appHost}` || o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
      if (!allowed) return reject(403, { error: "bad_origin" });
    }

    const cookies = app.parseCookie(request.headers.cookie ?? "");
    let principal: Principal | null = null;
    if (listener === "local") {
      const auth = request.headers.authorization;
      const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
      if (tokenMatches(expected, bearer) || tokenMatches(expected, cookies[TOKEN_COOKIE])) {
        principal = {
          personId: OWNER_ID, name: deps.person(OWNER_ID)?.name ?? "Owner", role: "owner", listener, method: "token", sessionId: null,
        };
      }
    }
    if (principal === null) {
      const sessionId = cookies[SESSION_COOKIE];
      const session = sessionId === undefined ? null : deps.sessions.lookup(sessionId, listener);
      const person = session === null ? null : deps.person(session.personId);
      if (session === null || person === null || person.removedAt !== null) return reject(401, { error: "unauthorized" });
      principal = { personId: person.id, name: person.name, role: person.role, listener, method: session.method, sessionId: session.id };
    }
    request.principal = principal;

    if (key === null) return; // no route matched: Fastify answers 404 to a signed-in caller
    const min = ROUTE_ROLES[key];
    if (min === undefined) return reject(500, { error: "internal" }); // fail closed: the startup check keeps the table complete
    if (!atLeast(principal.role, min)) return reject(403, FORBIDDEN(min));
  });
}
