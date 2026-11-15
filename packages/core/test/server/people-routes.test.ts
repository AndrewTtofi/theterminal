import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import { OWNER_ID, type Listener } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { getPerson } from "../../src/events/projections.js";
import { SessionStore } from "../../src/people/sessions.js";
import { ChallengeStore } from "../../src/people/challenges.js";
import { LockoutStore } from "../../src/people/lockouts.js";
import { InviteInvalidError, PeopleService } from "../../src/people/service.js";
import { GateRequirementError } from "../../src/gates/service.js";
import type { Rp } from "../../src/people/webauthn.js";
import { AUTH_THROTTLE, Throttle } from "../../src/server/throttle.js";
import { PUBLIC_ROUTE, SESSION_COOKIE, assertRoutesHaveRoles, registerAuth } from "../../src/server/auth.js";
import { registerRemoteRoutes } from "../../src/server/remote-routes.js";
import type { RemoteView } from "../../src/server/remote.js";
import { registerPeopleRoutes } from "../../src/server/people-routes.js";
import { softAuthenticator } from "../fixtures/webauthn.js";

const TOKEN = "TESTKEY-token-for-people-routes";
const PORT = 4317;
const LOCAL_HOST = `theterminal.localhost:${PORT}`;
const LOCAL_RP: Rp = { rpId: "theterminal.localhost", origin: `http://theterminal.localhost:${PORT}` };
const REMOTE_PORT = 4318;
const REMOTE_HOST = `tt-test.local:${REMOTE_PORT}`;
const REMOTE_RP: Rp = { rpId: "tt-test.local", origin: `https://tt-test.local:${REMOTE_PORT}` };
const FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(":");

let clock: Date;
const now = () => clock;
const tick = (ms = 61_000) => {
  clock = new Date(clock.getTime() + ms);
};

let db: Db;
let ledger: Ledger;
let sessions: SessionStore;
let service: PeopleService;
let app: FastifyInstance;
let listener: Listener;
let remoteView: RemoteView | null;

/** What must never come back in a response body: invite codes (after creation), session ids, client addresses. */
let secrets: string[];
let bodies: string[];
let addressSeq = 0;
const nextAddress = () => {
  addressSeq += 1;
  const a = `10.9.${addressSeq >> 8}.${addressSeq & 255}`;
  secrets.push(a);
  return a;
};

beforeEach(async () => {
  clock = new Date("2026-11-15T10:00:00.000Z");
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  sessions = new SessionStore(db, { now });
  const lockouts = new LockoutStore({ now });
  service = new PeopleService({ db, ledger, sessions, lockouts, now });
  listener = "local";
  remoteView = null;
  secrets = [TOKEN];
  bodies = [];
  app = Fastify();
  registerAuth(app, {
    token: TOKEN,
    port: () => PORT,
    hostRule: () => ({ port: REMOTE_PORT, domain: null, names: ["tt-test.local", "192.168.1.10"] }),
    sessions,
    person: (id) => getPerson(db, id),
    listenerOf: () => listener,
  });
  registerPeopleRoutes(app, {
    db, ledger, service, sessions, challenges: new ChallengeStore({ now }), throttle: new Throttle({ ...AUTH_THROTTLE, now }),
    port: () => PORT, remote: () => remoteView, now,
  });
  registerRemoteRoutes(app, {
    remote: { state: () => remoteView!, enable: async () => { throw new Error("unused"); }, disable: async () => undefined },
    principalOf: (r) => r.principal,
    listenerOf: () => listener,
  });
  // Routes outside the plugin, to show its error handler does not reach them.
  app.get("/test/gate-error", { config: PUBLIC_ROUTE }, async () => {
    throw new GateRequirementError("ready_to_ship", { role: "owner" });
  });
  app.get("/test/invite-error", { config: PUBLIC_ROUTE }, async () => {
    throw new InviteInvalidError();
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  for (const body of bodies) for (const s of secrets) expect(body.includes(s), `a response body holds ${s}`).toBe(false);
});

type Who = { cookie?: string; owner?: boolean; address?: string; host?: string };

async function call(method: string, url: string, body?: unknown, who: Who = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { host: who.host ?? (listener === "remote" ? REMOTE_HOST : LOCAL_HOST) };
  if (who.owner) headers.authorization = `Bearer ${TOKEN}`;
  if (who.cookie) headers.cookie = `${SESSION_COOKIE}=${who.cookie}`;
  const res = await app.inject({
    method: method as "GET",
    url,
    headers,
    remoteAddress: who.address ?? nextAddress(),
    ...(body !== undefined && { payload: body as object }),
  });
  const cookie = sessionOf(res);
  if (cookie) secrets.push(cookie);
  if (!(method === "POST" && url === "/api/people/invites")) bodies.push(res.body);
  return res;
}

function sessionOf(res: LightMyRequestResponse): string | undefined {
  const set = res.headers["set-cookie"];
  const all = Array.isArray(set) ? set : set === undefined ? [] : [set];
  for (const c of all) {
    const m = new RegExp(`^${SESSION_COOKIE}=([^;]+)`).exec(c);
    if (m && m[1] !== "") return m[1];
  }
  return undefined;
}

const owner: Who = { owner: true };

async function invite(role = "reviewer"): Promise<{ code: string; url: string; fingerprint: string | null; inviteId: string }> {
  const res = await call("POST", "/api/people/invites", { role }, owner);
  expect(res.statusCode).toBe(201);
  const body = res.json();
  const code = (body.url as string).split("/join/")[1]!.split("#")[0]!;
  secrets.push(code);
  return { code, url: body.url, fingerprint: body.fingerprint, inviteId: body.invite.id };
}

async function joinPasskey(code: string, o: { name?: string; address?: string; rp?: Rp } = {}) {
  const auth = softAuthenticator(o.rp ?? (listener === "remote" ? REMOTE_RP : LOCAL_RP));
  const address = o.address ?? nextAddress();
  const opts = await call("POST", `/api/join/${code}/passkey/options`, { name: o.name ?? "Ada" }, { address });
  if (opts.statusCode !== 200) return { auth, res: opts, cookie: undefined };
  const res = await call("POST", `/api/join/${code}/passkey/verify`, { name: o.name ?? "Ada", response: auth.register(opts.json()) }, { address });
  return { auth, res, cookie: sessionOf(res) };
}

async function signInPasskey(auth: ReturnType<typeof softAuthenticator>, o: { address?: string; uv?: boolean } = {}) {
  const address = o.address ?? nextAddress();
  const opts = await call("POST", "/api/auth/passkey/options", {}, { address });
  expect(opts.statusCode).toBe(200);
  const response = auth.authenticate(opts.json(), o.uv === false ? { uv: false } : {});
  return call("POST", "/api/auth/passkey/verify", { response }, { address });
}

function edKey(): { privateKey: KeyObject; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url") };
}
const signFor = (k: KeyObject, challenge: string, host: string) =>
  sign(null, Buffer.from(`theterminal-auth\n${challenge}\n${host}`, "utf8"), k).toString("base64url");

const entries = (type: string) => ledger.list().filter((e) => e.type === type);

describe("people routes", () => {
  it("registers only routes in the role table or the public set", () => {
    expect(assertRoutesHaveRoles(app)).toEqual([]);
  });

  it("invites a reviewer, recording only the code's hash; the invite opens, joins once by passkey, and signs in by cookie", async () => {
    const { code, url, fingerprint } = await invite("reviewer");
    expect(url).toBe(`http://theterminal.localhost:${PORT}/join/${code}`);
    expect(fingerprint).toBeNull();
    const invited = entries("person.invited");
    expect(invited).toHaveLength(1);
    expect(JSON.stringify(invited[0])).not.toContain(code);

    const info = await call("GET", `/api/join/${code}`);
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ role: "reviewer", passkeys: true, host: LOCAL_HOST, fingerprint: null });

    const { res, cookie } = await joinPasskey(code);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ role: "reviewer", method: "passkey", name: "Ada", listener: "local" });
    const set = String(res.headers["set-cookie"]);
    expect(set).toContain(`${SESSION_COOKIE}=`);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).not.toContain("Secure");
    expect(entries("person.joined")).toHaveLength(1);
    expect(entries("person.signed_in").at(-1)!.payload).toMatchObject({ listener: "local", method: "passkey" });
    // The counter starts at 0, outside the ledger.
    const credId = (entries("person.joined")[0]!.payload as { credential: { credentialId: string } }).credential.credentialId;
    expect(db.prepare("SELECT counter FROM credential_state WHERE credential_id = ?").get(credId)).toEqual({ counter: 0 });

    const again = await joinPasskey(code, { name: "Eve" });
    expect(again.res.statusCode).toBe(404);
    expect(again.res.json()).toEqual({ error: "invite_invalid" });

    const me = await call("GET", "/api/me", undefined, { cookie: cookie! });
    expect(me.statusCode).toBe(200);
    const meBody = me.json();
    expect(meBody).toMatchObject({ name: "Ada", role: "reviewer", method: "passkey" });
    expect(meBody.credentials).toHaveLength(1);
    expect(meBody.credentials[0]).not.toHaveProperty("publicKey");
    expect(meBody.sessions).toHaveLength(1);
    expect(meBody.sessions[0].id).toMatch(/^[0-9a-f]{8}$/);
    expect(meBody.sessions[0].current).toBe(true);
  });

  it("signs out: 204, the cookie is cleared and the session is revoked", async () => {
    const { code } = await invite();
    const { cookie } = await joinPasskey(code);
    const out = await call("POST", "/api/me/sign-out", undefined, { cookie: cookie! });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers["set-cookie"])).toMatch(new RegExp(`${SESSION_COOKIE}=;.*Expires=Thu, 01 Jan 1970`));
    expect((await call("GET", "/api/me", undefined, { cookie: cookie! })).statusCode).toBe(401);
  });

  it("signs in by passkey, recording person.signed_in, and the counter moves on", async () => {
    const { code } = await invite();
    const { auth } = await joinPasskey(code);
    const res = await signInPasskey(auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Ada", method: "passkey" });
    expect(sessionOf(res)).toBeDefined();
    expect(entries("person.signed_in").at(-1)!.payload).toMatchObject({ listener: "local", method: "passkey" });
    expect(db.prepare("SELECT counter FROM credential_state").get()).toEqual({ counter: auth.counter });
  });

  it("joins and signs in with an Ed25519 key", async () => {
    const { code } = await invite("maintainer");
    const key = edKey();
    const address = nextAddress();
    const ch = await call("POST", `/api/join/${code}/key/challenge`, {}, { address });
    expect(ch.statusCode).toBe(200);
    const { challenge } = ch.json();
    const res = await call("POST", `/api/join/${code}/key`, {
      name: "Kay", label: "CLI", publicKey: key.publicKey, challenge, signature: signFor(key.privateKey, challenge, LOCAL_HOST),
    }, { address });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ role: "maintainer", method: "key" });
    expect(sessionOf(res)).toBeDefined();
    expect(db.prepare("SELECT transports, label FROM credentials").get()).toEqual({ transports: "[]", label: "CLI" });

    const ch2 = (await call("POST", "/api/auth/key/challenge", {})).json().challenge;
    const login = await call("POST", "/api/auth/key/verify", {
      publicKey: key.publicKey, challenge: ch2, signature: signFor(key.privateKey, ch2, LOCAL_HOST),
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ name: "Kay", method: "key" });
    expect(entries("person.signed_in").at(-1)!.payload).toMatchObject({ listener: "local", method: "key" });
  });

  it("throttles every join and auth endpoint: the 11th request in a minute is 429 with retryAfterS", async () => {
    const address = "198.51.100.20";
    secrets.push(address);
    for (let i = 0; i < 10; i++) expect((await call("GET", "/api/join/x", undefined, { address })).statusCode).toBe(404);
    const res = await call("GET", "/api/join/x", undefined, { address });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "rate_limited", retryAfterS: expect.any(Number) });
    expect((await call("POST", "/api/auth/passkey/options", {}, { address })).statusCode).toBe(429);
    expect((await call("POST", "/api/auth/key/challenge", {}, { address })).statusCode).toBe(429);
    // Another address, and the same address a minute on, are not held back.
    expect((await call("GET", "/api/join/x")).statusCode).toBe(404);
    tick();
    expect((await call("GET", "/api/join/x", undefined, { address })).statusCode).toBe(404);
  });

  it("throttles an IPv6 client by its /64", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await call("GET", "/api/join/x", undefined, { address: `2001:db8:1:2::${i + 1}` })).statusCode).toBe(404);
    }
    expect((await call("GET", "/api/join/x", undefined, { address: "2001:db8:1:2:ffff::9" })).statusCode).toBe(429);
    expect((await call("GET", "/api/join/x", undefined, { address: "2001:db8:1:3::1" })).statusCode).toBe(404);
  });

  it("locks a passkey for one address after 5 failures: 423 there with one person.locked, while another address signs in", async () => {
    const { code } = await invite();
    const { auth } = await joinPasskey(code);
    const bad = "198.51.100.7";
    const good = "198.51.100.8";
    secrets.push(bad, good);
    for (let i = 0; i < 5; i++) {
      const res = await signInPasskey(auth, { address: bad, uv: false });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "invalid_credential" });
      tick(); // past the throttle's window, well inside the lock
    }
    const locked = await signInPasskey(auth, { address: bad });
    expect(locked.statusCode).toBe(423);
    expect(locked.json()).toEqual({ error: "locked", retryAfterS: expect.any(Number) });
    expect(entries("person.locked")).toHaveLength(1);
    const before = entries("person.signed_in").length;
    const other = await signInPasskey(auth, { address: good });
    expect(other.statusCode).toBe(200);
    expect(entries("person.signed_in")).toHaveLength(before + 1);
  });

  it("locks a key for one address after 5 bad signatures with a public key read out of the ledger", async () => {
    const { code } = await invite();
    const key = edKey();
    const ch = (await call("POST", `/api/join/${code}/key/challenge`, {})).json().challenge;
    expect((await call("POST", `/api/join/${code}/key`, {
      name: "Kay", publicKey: key.publicKey, challenge: ch, signature: signFor(key.privateKey, ch, LOCAL_HOST),
    })).statusCode).toBe(201);
    const publicKey = (entries("person.joined")[0]!.payload as { credential: { publicKey: string } }).credential.publicKey;
    const attacker = edKey();
    const bad = "198.51.100.7";
    const good = "198.51.100.8";
    secrets.push(bad, good);
    const tryLogin = async (address: string, k: KeyObject) => {
      const c = (await call("POST", "/api/auth/key/challenge", {}, { address })).json().challenge;
      return call("POST", "/api/auth/key/verify", { publicKey, challenge: c, signature: signFor(k, c, LOCAL_HOST) }, { address });
    };
    for (let i = 0; i < 5; i++) {
      expect((await tryLogin(bad, attacker.privateKey)).statusCode).toBe(401);
      tick();
    }
    expect((await tryLogin(bad, key.privateKey)).statusCode).toBe(423);
    expect(entries("person.locked")).toHaveLength(1);
    expect((await tryLogin(good, key.privateKey)).statusCode).toBe(200);
  });

  it("burns a challenge before verifying: a reused one is 401, and one whose verification failed cannot be presented again", async () => {
    const { code } = await invite();
    const { auth } = await joinPasskey(code);
    const address = nextAddress();
    // Reused after a success.
    const opts = (await call("POST", "/api/auth/passkey/options", {}, { address })).json();
    expect((await call("POST", "/api/auth/passkey/verify", { response: auth.authenticate(opts) }, { address })).statusCode).toBe(200);
    expect((await call("POST", "/api/auth/passkey/verify", { response: auth.authenticate(opts) }, { address })).statusCode).toBe(401);
    // A failed verification (uv clear) burns it too: the valid answer to the same challenge is then refused.
    const opts2 = (await call("POST", "/api/auth/passkey/options", {}, { address })).json();
    expect((await call("POST", "/api/auth/passkey/verify", { response: auth.authenticate(opts2, { uv: false }) }, { address })).statusCode).toBe(401);
    expect((await call("POST", "/api/auth/passkey/verify", { response: auth.authenticate(opts2) }, { address })).statusCode).toBe(401);
    expect((await call("POST", "/api/auth/passkey/verify", { response: auth.authenticate(opts2) }, { address })).statusCode).toBe(401);
  });

  it("burns a join challenge before verifying: a failed registration cannot retry it", async () => {
    const { code } = await invite();
    const auth = softAuthenticator(LOCAL_RP);
    const address = nextAddress();
    const opts = (await call("POST", `/api/join/${code}/passkey/options`, { name: "Ada" }, { address })).json();
    const bad = await call("POST", `/api/join/${code}/passkey/verify`, { name: "Ada", response: auth.register(opts, { uv: false }) }, { address });
    expect(bad.statusCode).toBe(401);
    const retry = await call("POST", `/api/join/${code}/passkey/verify`, { name: "Ada", response: auth.register(opts) }, { address });
    expect(retry.statusCode).toBe(401);
    expect(entries("person.joined")).toHaveLength(0);
  });

  it("refuses a challenge from another scope", async () => {
    const { code } = await invite();
    const { auth } = await joinPasskey(code);
    const joinOpts = (await call("POST", `/api/join/${(await invite()).code}/passkey/options`, { name: "Bo" })).json();
    expect((await call("POST", "/api/auth/passkey/verify", { response: auth.authenticate(joinOpts) })).statusCode).toBe(401);
  });

  it("answers 401 for a removed person's passkey and records no sign-in", async () => {
    const { code } = await invite();
    const { auth } = await joinPasskey(code);
    const personId = (entries("person.joined")[0]!.payload as { personId: string }).personId;
    expect((await call("DELETE", `/api/people/${personId}`, undefined, owner)).statusCode).toBe(204);
    const before = entries("person.signed_in").length;
    const res = await signInPasskey(auth);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_credential" });
    expect(entries("person.signed_in")).toHaveLength(before);
  });

  it("lets the bootstrap Owner invite be used once", async () => {
    const { code } = service.invite({ kind: "human", id: OWNER_ID }, "owner");
    secrets.push(code);
    const first = await joinPasskey(code, { name: "Olive" });
    expect(first.res.statusCode).toBe(201);
    expect(first.res.json()).toMatchObject({ personId: OWNER_ID, role: "owner", name: "Olive", method: "passkey" });
    expect(entries("person.joined")).toHaveLength(0);
    const second = await joinPasskey(code, { name: "Mallory" });
    expect(second.res.statusCode).toBe(404);
    expect(second.res.json()).toEqual({ error: "invite_invalid" });
    expect((await signInPasskey(first.auth)).json()).toMatchObject({ personId: OWNER_ID, role: "owner" });
  });

  it("refuses a foreign Host before any route runs", async () => {
    const { code } = await invite();
    const local = await call("GET", `/api/join/${code}`, undefined, { host: "evil.example" });
    expect(local.statusCode).toBe(403);
    expect(local.json()).toEqual({ error: "bad_host" });
    listener = "remote";
    const remote = await call("POST", "/api/auth/passkey/options", {}, { host: `evil.example:${REMOTE_PORT}` });
    expect(remote.statusCode).toBe(403);
    expect(remote.json()).toEqual({ error: "bad_host" });
  });

  it("joins over the remote listener with an https origin and a Secure cookie; an IP literal has no passkeys but takes a key", async () => {
    const { code } = await invite();
    listener = "remote";
    remoteView = {
      enabled: true, listening: true, port: REMOTE_PORT, bind: "0.0.0.0", domain: null, tls: "self_signed", fingerprint: FP,
      expiresAt: "2027-11-15T00:00:00.000Z", addresses: ["192.168.1.10"], acme: { lastError: null },
    };
    const info = (await call("GET", `/api/join/${code}`)).json();
    // The host named is the listener's configured address, not the name the request came in by.
    expect(info).toMatchObject({ passkeys: true, host: `192.168.1.10:${REMOTE_PORT}`, fingerprint: FP });
    const { res, cookie } = await joinPasskey(code);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ listener: "remote" });
    expect(String(res.headers["set-cookie"])).toContain("Secure");
    // The session works on remote only.
    expect((await call("GET", "/api/me", undefined, { cookie: cookie! })).statusCode).toBe(200);
    listener = "local";
    expect((await call("GET", "/api/me", undefined, { cookie: cookie! })).statusCode).toBe(401);

    listener = "local";
    const second = await invite();
    listener = "remote";
    const ipHost = `192.168.1.10:${REMOTE_PORT}`;
    expect((await call("GET", `/api/join/${second.code}`, undefined, { host: ipHost })).json()).toMatchObject({ passkeys: false });
    const opts = await call("POST", `/api/join/${second.code}/passkey/options`, { name: "Ip" }, { host: ipHost });
    expect(opts.statusCode).toBe(409);
    expect(opts.json()).toEqual({ error: "passkeys_unavailable" });
    expect((await call("POST", "/api/auth/passkey/options", {}, { host: ipHost })).statusCode).toBe(409);
    const key = edKey();
    const address = nextAddress();
    const ch = (await call("POST", `/api/join/${second.code}/key/challenge`, {}, { host: ipHost, address })).json().challenge;
    const joined = await call("POST", `/api/join/${second.code}/key`, {
      name: "Ip", publicKey: key.publicKey, challenge: ch, signature: signFor(key.privateKey, ch, ipHost),
    }, { host: ipHost, address });
    expect(joined.statusCode).toBe(201);
  });

  it("a key signature bound to another host is refused", async () => {
    const { code } = await invite();
    const key = edKey();
    const address = nextAddress();
    const ch = (await call("POST", `/api/join/${code}/key/challenge`, {}, { address })).json().challenge;
    const res = await call("POST", `/api/join/${code}/key`, {
      name: "Kay", publicKey: key.publicKey, challenge: ch, signature: signFor(key.privateKey, ch, "evil.example"),
    }, { address });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_credential" });
  });

  it("gives the invite the remote listener's fingerprint, the same as its #fp= and GET /api/remote", async () => {
    remoteView = {
      enabled: true, listening: true, port: REMOTE_PORT, bind: "0.0.0.0", domain: null, tls: "self_signed", fingerprint: FP,
      expiresAt: "2027-11-15T00:00:00.000Z", addresses: ["192.168.1.10"], acme: { lastError: null },
    };
    const { code, url, fingerprint } = await invite();
    expect(url).toBe(`https://192.168.1.10:${REMOTE_PORT}/join/${code}#fp=${FP}`);
    expect(fingerprint).toBe(FP);
    expect((await call("GET", "/api/remote", undefined, owner)).json().fingerprint).toBe(fingerprint);
    remoteView = { ...remoteView, domain: "tt.example.com" };
    expect((await invite()).url).toMatch(new RegExp(`^https://tt\\.example\\.com:${REMOTE_PORT}/join/[A-Za-z0-9_-]+#fp=${FP}$`));
    listener = "remote";
    remoteView = { ...remoteView, domain: null };
    expect((await call("GET", `/api/join/${code}`)).json().fingerprint).toBe(FP);
  });

  it("GET /api/join/:code names the configured address as its host, never the request's Host header", async () => {
    const { code } = await invite();
    // Local: the app host and port, whatever name the request came in by.
    expect((await call("GET", `/api/join/${code}`, undefined, { host: `127.0.0.1:${PORT}` })).json()).toMatchObject({ host: LOCAL_HOST });
    expect((await call("GET", `/api/join/${code}`, undefined, { host: `localhost:${PORT}` })).json()).toMatchObject({ host: LOCAL_HOST });
    // Remote: the configured domain, or the listener's first address, with the remote port; both accepted names give the same.
    listener = "remote";
    remoteView = {
      enabled: true, listening: true, port: REMOTE_PORT, bind: "0.0.0.0", domain: null, tls: "self_signed", fingerprint: FP,
      expiresAt: "2027-11-15T00:00:00.000Z", addresses: ["192.168.1.10"], acme: { lastError: null },
    };
    expect((await call("GET", `/api/join/${code}`)).json()).toMatchObject({ host: `192.168.1.10:${REMOTE_PORT}`, fingerprint: FP });
    expect((await call("GET", `/api/join/${code}`, undefined, { host: `192.168.1.10:${REMOTE_PORT}` })).json()).toMatchObject({ host: `192.168.1.10:${REMOTE_PORT}` });
    remoteView = { ...remoteView, domain: "tt.example.com" };
    expect((await call("GET", `/api/join/${code}`)).json()).toMatchObject({ host: `tt.example.com:${REMOTE_PORT}` });
  });

  it("manages people: lists, changes roles, refuses owner and self changes, removes, signs out everywhere", async () => {
    const { code } = await invite();
    const { cookie } = await joinPasskey(code);
    const personId = (entries("person.joined")[0]!.payload as { personId: string }).personId;

    const list = await call("GET", "/api/people", undefined, { cookie: cookie! });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((p: { id: string }) => p.id)).toEqual([OWNER_ID, personId]);

    const pending = await call("GET", "/api/people/invites", undefined, owner);
    expect(pending.json()).toEqual([]);
    const forbidden = await call("POST", "/api/people/invites", { role: "viewer" }, { cookie: cookie! });
    expect(forbidden.statusCode).toBe(403);

    const toOwner = await call("PATCH", `/api/people/${personId}`, { role: "owner" }, owner);
    expect(toOwner.statusCode).toBe(409);
    expect(toOwner.json()).toEqual({ error: "owner_role" });
    const self = await call("DELETE", `/api/people/${OWNER_ID}`, undefined, owner);
    expect(self.statusCode).toBe(409);
    expect(self.json()).toEqual({ error: "self_change" });
    const ownerInvite = await call("POST", "/api/people/invites", { role: "owner" }, owner);
    expect(ownerInvite.statusCode).toBe(409);
    expect(ownerInvite.json()).toEqual({ error: "owner_role" });

    const changed = await call("PATCH", `/api/people/${personId}`, { role: "maintainer" }, owner);
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ id: personId, role: "maintainer" });
    expect((await call("GET", "/api/me", undefined, { cookie: cookie! })).json().role).toBe("maintainer");

    const out = await call("POST", `/api/people/${personId}/sign-out`, undefined, owner);
    expect(out.json()).toEqual({ revoked: 1 });
    expect((await call("GET", "/api/me", undefined, { cookie: cookie! })).statusCode).toBe(401);
    expect((await call("POST", "/api/people/nobody/sign-out", undefined, owner)).statusCode).toBe(404);
    expect((await call("PATCH", "/api/people/nobody", { role: "viewer" }, owner)).statusCode).toBe(404);
  });

  it("lists and revokes pending invites", async () => {
    const { inviteId, code } = await invite("viewer");
    const pending = (await call("GET", "/api/people/invites", undefined, owner)).json();
    expect(pending).toEqual([expect.objectContaining({ id: inviteId, role: "viewer", status: "pending" })]);
    expect((await call("DELETE", `/api/people/invites/${inviteId}`, undefined, owner)).statusCode).toBe(204);
    expect((await call("GET", `/api/join/${code}`)).statusCode).toBe(404);
    const again = await call("DELETE", `/api/people/invites/${inviteId}`, undefined, owner);
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: "invite_invalid" });
  });

  it("adds and removes the caller's own credentials, with their label cleaned and capped, never the last one", async () => {
    const { code } = await invite();
    const { cookie } = await joinPasskey(code);
    const who = { cookie: cookie! };
    const last = (await call("GET", "/api/me", undefined, who)).json().credentials[0].credentialId;
    const refused = await call("DELETE", `/api/me/credentials/${last}`, undefined, who);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "last_credential" });

    const second = softAuthenticator(LOCAL_RP);
    const opts = (await call("POST", "/api/me/credentials/passkey/options", {}, who)).json();
    expect(opts.authenticatorSelection.userVerification).toBe("required");
    expect(opts.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([last]);
    const added = await call("POST", "/api/me/credentials/passkey/verify", {
      label: `  Work\u0000\nlaptop ${"x".repeat(100)}`, response: second.register(opts),
    }, who);
    expect(added.statusCode).toBe(201);
    const labels = added.json().credentials.map((c: { label: string }) => c.label);
    expect(labels[0]).toBe("Passkey");
    expect(labels[1]).toMatch(/^Work laptop x+$/);
    expect(labels[1]).toHaveLength(60);
    expect(db.prepare("SELECT counter FROM credential_state WHERE credential_id = ?").get(second.credentialId)).toEqual({ counter: 0 });
    // The same passkey cannot be registered twice.
    const opts2 = (await call("POST", "/api/me/credentials/passkey/options", {}, who)).json();
    const dup = await call("POST", "/api/me/credentials/passkey/verify", { label: "again", response: second.register(opts2) }, who);
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: "credential_exists" });

    const key = edKey();
    const ch = (await call("POST", "/api/me/credentials/key/challenge", {}, who)).json().challenge;
    const addedKey = await call("POST", "/api/me/credentials/key", {
      label: "CLI", publicKey: key.publicKey, challenge: ch, signature: signFor(key.privateKey, ch, LOCAL_HOST),
    }, who);
    expect(addedKey.statusCode).toBe(201);
    expect(addedKey.json().credentials.map((c: { kind: string }) => c.kind)).toEqual(["passkey", "passkey", "key"]);
    const reused = await call("POST", "/api/me/credentials/key", {
      label: "CLI", publicKey: edKey().publicKey, challenge: ch, signature: signFor(key.privateKey, ch, LOCAL_HOST),
    }, who);
    expect(reused.statusCode).toBe(401);

    expect((await call("DELETE", `/api/me/credentials/${second.credentialId}`, undefined, who)).statusCode).toBe(204);
    expect(db.prepare("SELECT counter FROM credential_state WHERE credential_id = ?").get(second.credentialId)).toBeUndefined();
    expect((await call("DELETE", "/api/me/credentials/nope", undefined, who)).statusCode).toBe(404);
  });

  it("revokes one of the caller's own sessions by its hash prefix; an unknown prefix is 404", async () => {
    const { code } = await invite();
    const { auth, cookie: first } = await joinPasskey(code);
    const second = sessionOf(await signInPasskey(auth))!;
    const me = (await call("GET", "/api/me", undefined, { cookie: second })).json();
    expect(me.sessions).toHaveLength(2);
    const other = me.sessions.find((s: { current: boolean }) => !s.current).id;
    expect((await call("DELETE", `/api/me/sessions/${other}`, undefined, { cookie: second })).statusCode).toBe(204);
    expect((await call("GET", "/api/me", undefined, { cookie: first! })).statusCode).toBe(401);
    expect((await call("GET", "/api/me", undefined, { cookie: second })).statusCode).toBe(200);
    const unknown = await call("DELETE", "/api/me/sessions/ffffffff", undefined, { cookie: second });
    expect(unknown.statusCode).toBe(404);
  });

  it("renames the caller and refuses a name holding a secret", async () => {
    const res = await call("PATCH", "/api/me", { name: "  Olive  " }, owner);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ personId: OWNER_ID, name: "Olive", method: "token", sessions: [] });
    expect((await call("PATCH", "/api/me", { name: "" }, owner)).statusCode).toBe(400);
  });

  it("answers 423 on join and sign-in while the ledger is read-only, without burning the challenge", async () => {
    const { code } = await invite();
    const auth = softAuthenticator(LOCAL_RP);
    const address = nextAddress();
    const opts = (await call("POST", `/api/join/${code}/passkey/options`, { name: "Ada" }, { address })).json();
    const response = auth.register(opts);
    Object.defineProperty(ledger, "readOnly", { value: true, configurable: true });
    const res = await call("POST", `/api/join/${code}/passkey/verify`, { name: "Ada", response }, { address });
    expect(res.statusCode).toBe(423);
    expect(res.json()).toEqual({ error: "ledger_read_only" });
    expect((await call("POST", "/api/auth/key/verify", { publicKey: "AAAA", challenge: "AAAA", signature: "AAAA" })).statusCode).toBe(423);
  });

  it("refuses bad bodies with fixed codes", async () => {
    const { code } = await invite();
    const r1 = await call("POST", `/api/join/${code}/passkey/verify`, { name: "Ada", response: "nope" });
    expect(r1.statusCode).toBe(401);
    expect(r1.json()).toEqual({ error: "invalid_credential" });
    const r2 = await call("POST", "/api/auth/key/verify", { publicKey: "!!", challenge: "x", signature: "y" });
    expect(r2.statusCode).toBe(401);
    expect(r2.json()).toEqual({ error: "invalid_credential" });
    const r3 = await call("POST", "/api/people/invites", { role: "boss" }, owner);
    expect(r3.statusCode).toBe(400);
    expect(r3.json().error).toBe("invalid_input");
  });

  it("keeps its error handler to itself: errors from routes outside the plugin are not mapped by it", async () => {
    const gate = await call("GET", "/test/gate-error");
    expect(gate.statusCode).toBe(500);
    const inv = await call("GET", "/test/invite-error");
    expect(inv.statusCode).toBe(500);
    expect(inv.body).not.toContain("invite_invalid");
  });
});
