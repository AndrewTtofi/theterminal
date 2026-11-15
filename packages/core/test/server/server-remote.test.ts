import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { CERT_FINGERPRINT, OWNER_ID, type LedgerEntry } from "@theterminal/shared";
import { openDatabase } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { commitEvent } from "../../src/events/commit.js";
import { fakeDiscovery } from "../../src/link/discovery.js";
import { SessionStore } from "../../src/people/sessions.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { SESSION_COOKIE, TOKEN_COOKIE } from "../../src/server/auth.js";
import { createServer, type RunningServer } from "../../src/server/server.js";
import { freePort, pinnedRequest } from "../fixtures/remote-harness.js";
import { seedPeople } from "../fixtures/people.js";

const NO_BUNDLED = { claude: () => null, codex: () => null, gemini: () => null };
const running: RunningServer[] = [];
const dirs: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const ws of sockets.splice(0)) ws.terminate();
  while (running.length) await running.pop()!.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Seeded = { dataDir: string; cookies: { localViewer: string; remoteViewer: string; remoteMaintainer: string } };

/**
 * A data folder with a viewer and a maintainer who hold remote sessions (and the viewer a local one too), and, when
 * asked, a key credential for the Owner, all written before any server opens it.
 */
function seed(opts: { ownerCredential?: boolean } = {}): Seeded {
  const dataDir = mkdtempSync(join(tmpdir(), "tt-srv-remote-"));
  dirs.push(dataDir);
  const local = seedPeople(dataDir);
  const db = openDatabase(join(dataDir, "ledger.db"));
  try {
    if (opts.ownerCredential) {
      commitEvent(db, new Ledger(db), () => ({
        event: {
          projectId: null, actor: { kind: "human", id: OWNER_ID }, type: "person.credential_added",
          payload: { personId: OWNER_ID, credential: { kind: "key", credentialId: "key-owner", publicKey: "TESTKEY-owner", label: "CLI" } },
        },
        result: () => undefined,
      }));
    }
    const sessions = new SessionStore(db);
    return {
      dataDir,
      cookies: {
        localViewer: local["p-viewer"]!,
        remoteViewer: `${SESSION_COOKIE}=${sessions.create("p-viewer", "remote", "passkey").id}`,
        remoteMaintainer: `${SESSION_COOKIE}=${sessions.create("p-maintainer", "remote", "passkey").id}`,
      },
    };
  } finally {
    db.close();
  }
}

const ON = { enabled: true, port: 0, bind: "127.0.0.1" };

async function start(dataDir: string, extra: Partial<Parameters<typeof createServer>[0]> = {}, secrets = new MemorySecretStore()) {
  const s = await createServer({
    dataDir, port: 0, which: () => null, bundled: NO_BUNDLED, secrets, discovery: fakeDiscovery(), linkBind: "127.0.0.1", linkPort: 0, ...extra,
  });
  running.push(s);
  return s;
}

const stop = async (s: RunningServer) => {
  running.splice(running.indexOf(s), 1);
  await s.close();
};

const remotePort = (s: RunningServer): number => Number(new URL(s.remoteUrl!).port);
const owner = (s: RunningServer) => ({ authorization: `Bearer ${s.token}` });
const local = (s: RunningServer, path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${s.port}${path}`, init);
const localJson = (s: RunningServer, method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  local(s, path, {
    method, headers: { ...headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

async function remoteEntries(s: RunningServer): Promise<LedgerEntry[]> {
  const all = (await (await local(s, "/api/ledger?limit=500", { headers: owner(s) })).json()) as LedgerEntry[];
  return all.filter((e) => e.type.startsWith("remote."));
}

/** The certificate the TLS listener really serves. */
function servedFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      const fp = sock.getPeerCertificate().fingerprint256;
      sock.destroy();
      resolve(fp);
    });
    sock.on("error", reject);
  });
}

/** A plain-HTTP request written to the TLS port: whatever came back before the socket closed. */
function plainToTlsPort(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    let data = "";
    sock.on("connect", () => sock.write(`GET /healthz HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nconnection: close\r\n\r\n`));
    sock.on("data", (c) => (data += String(c)));
    sock.on("error", () => undefined);
    sock.on("close", () => resolve(data));
    setTimeout(() => {
      sock.destroy();
      reject(new Error("timeout"));
    }, 5000).unref();
  });
}

function connectRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(true));
  });
}

/** A WebSocket to /api/events over TLS: 101 with the open socket, or the refusal's status. */
function eventsOverTls(port: number, headers: Record<string, string>): Promise<{ status: number; ws: WebSocket; closed: Promise<{ code: number; reason: string }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/api/events`, { headers, rejectUnauthorized: false });
    sockets.push(ws);
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (code, reason) => r({ code, reason: String(reason) })));
    ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode ?? 0, ws, closed }));
    ws.on("open", () => resolve({ status: 101, ws, closed }));
    ws.on("error", reject);
  });
}

/** One plain request to the local listener, with raw control over the headers. */
function plainLocal(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the remote listener on the real server", { timeout: 30_000 }, () => {
  it("starts from the CLI's flags with no Owner credential yet: remoteUrl, the pinned fingerprint, the system actor's entries", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tt-srv-remote-"));
    dirs.push(dataDir);
    const s = await start(dataDir, { remote: ON });
    expect(s.remoteUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/$/);
    expect(s.fingerprint).toMatch(CERT_FINGERPRINT);
    const port = remotePort(s);
    expect(await servedFingerprint(port)).toBe(s.fingerprint);

    const health = await pinnedRequest(port, s.fingerprint!, { path: "/healthz" });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true });
    await expect(pinnedRequest(port, "AA:" + s.fingerprint!.slice(3), { path: "/healthz" })).rejects.toThrow("fingerprint mismatch");
    // No plain fallback: a plain-HTTP request to the TLS port gets no HTTP response.
    expect(await plainToTlsPort(port)).not.toContain("HTTP/");

    const entries = await remoteEntries(s);
    expect(entries.map((e) => e.type)).toEqual(["remote.certificate_changed", "remote.enabled"]);
    expect(entries[1]!.seq).toBe(entries[0]!.seq + 1);
    expect(entries[1]!.actor).toEqual({ kind: "system", id: "cli" });
    expect(entries[1]!.payload).toMatchObject({ port, bind: "127.0.0.1", tls: "self_signed", fingerprint: s.fingerprint });
  });

  it("over TLS the token is refused, a remote session works there alone, and the event socket needs an https Origin", async () => {
    const { dataDir, cookies } = seed();
    const s = await start(dataDir, { remote: ON });
    const port = remotePort(s);
    const fp = s.fingerprint!;

    const bearer = await pinnedRequest(port, fp, { path: "/api/me", headers: owner(s) });
    expect(bearer.status).toBe(401);
    expect(JSON.parse(bearer.body)).toEqual({ error: "unauthorized" });
    expect((await pinnedRequest(port, fp, { path: "/api/me", headers: { cookie: `${TOKEN_COOKIE}=${s.token}` } })).status).toBe(401);
    const token = await pinnedRequest(port, fp, { path: `/?token=${s.token}` });
    expect(token.status).toBe(401);
    expect(token.headers.location).toBeUndefined();
    expect(token.headers["set-cookie"]).toBeUndefined();

    const me = await pinnedRequest(port, fp, { path: "/api/me", headers: { cookie: cookies.remoteViewer } });
    expect(me.status).toBe(200);
    expect(JSON.parse(me.body)).toMatchObject({ personId: "p-viewer", role: "viewer" });
    expect((await pinnedRequest(port, fp, { path: "/api/me", headers: { cookie: cookies.localViewer } })).status).toBe(401);
    expect((await plainLocal(s.port, "/api/me", { cookie: cookies.remoteViewer })).status).toBe(401);
    expect((await plainLocal(s.port, "/api/me", { cookie: cookies.localViewer })).status).toBe(200);

    const evil = await pinnedRequest(port, fp, { path: "/api/me", host: `evil.example.org:${port}`, headers: { cookie: cookies.remoteViewer } });
    expect(evil.status).toBe(403);
    expect(JSON.parse(evil.body)).toEqual({ error: "bad_host" });
    expect((await pinnedRequest(port, fp, { path: "/healthz", host: `evil.example.org:${port}` })).status).toBe(200);

    const good = await eventsOverTls(port, { origin: `https://127.0.0.1:${port}`, cookie: cookies.remoteViewer });
    expect(good.status).toBe(101);
    const bad = await eventsOverTls(port, { origin: `http://127.0.0.1:${port}`, cookie: cookies.remoteViewer });
    expect(bad.status).toBe(403);
    const anonymous = await eventsOverTls(port, { origin: `https://127.0.0.1:${port}` });
    expect(anonymous.status).toBe(401);
  });

  it("/api/status.remote: the Owner sees the label, a collaborator sees nothing of it; GET /api/remote trims for non-owners", async () => {
    const { dataDir, cookies } = seed();
    const s = await start(dataDir, { remote: ON });
    const port = remotePort(s);
    const owners = (await (await local(s, "/api/status", { headers: owner(s) })).json()) as { remote: unknown };
    expect(owners.remote).toEqual({ enabled: true, listening: true, label: `127.0.0.1:${port}` });
    const viewers = (await (await local(s, "/api/status", { headers: { cookie: cookies.localViewer } })).json()) as Record<string, unknown>;
    expect(viewers).not.toHaveProperty("remote");
    expect(JSON.stringify(viewers)).not.toContain(String(port));

    const theirs = await pinnedRequest(port, s.fingerprint!, { path: "/api/remote", headers: { cookie: cookies.remoteViewer } });
    expect(JSON.parse(theirs.body)).toEqual({ enabled: true, listening: true });
    const mine = (await (await local(s, "/api/remote", { headers: owner(s) })).json()) as Record<string, unknown>;
    expect(mine).toMatchObject({ enabled: true, listening: true, port, bind: "127.0.0.1", fingerprint: s.fingerprint, addresses: ["127.0.0.1"] });
  });

  it("an invite points at the remote listener's real address with the served fingerprint", async () => {
    const { dataDir } = seed();
    const s = await start(dataDir, { remote: ON });
    const port = remotePort(s);
    const res = await localJson(s, "POST", "/api/people/invites", owner(s), { role: "viewer" });
    expect(res.status).toBe(201);
    const { url, fingerprint } = (await res.json()) as { url: string; fingerprint: string };
    expect(fingerprint).toBe(s.fingerprint);
    expect(url).toMatch(new RegExp(`^https://127\\.0\\.0\\.1:${port}/join/[A-Za-z0-9_-]+#fp=${s.fingerprint!.replace(/:/g, "\\:")}$`));
    expect(url).not.toContain("0.0.0.0");
    const code = /\/join\/([^#]+)#/.exec(url)![1]!;
    const over = await pinnedRequest(port, s.fingerprint!, { path: `/api/join/${code}` });
    expect(JSON.parse(over.body)).toMatchObject({ role: "viewer", fingerprint: s.fingerprint });
    expect(((await (await local(s, `/api/join/${code}`)).json()) as { fingerprint: unknown }).fingerprint).toBeNull();
  });

  it("the Owner turns remote off locally; turning it on again needs their credential, and then reuses the certificate", async () => {
    const { dataDir } = seed({ ownerCredential: true });
    const s = await start(dataDir, { remote: ON });
    const port = remotePort(s);
    const fp = s.fingerprint!;
    const off = await localJson(s, "PUT", "/api/remote", owner(s), { enabled: false });
    expect(off.status).toBe(200);
    expect(await connectRefused(port)).toBe(true);
    expect(s.remoteUrl).toBeNull();
    expect(s.fingerprint).toBeNull();
    const status = (await (await local(s, "/api/status", { headers: owner(s) })).json()) as { remote: unknown };
    expect(status.remote).toEqual({ enabled: false, listening: false, label: "off" });
    expect((await remoteEntries(s)).at(-1)).toMatchObject({ type: "remote.disabled", actor: { kind: "human", id: OWNER_ID } });

    const on = await localJson(s, "PUT", "/api/remote", owner(s), { enabled: true, port: await freePort(), bind: "127.0.0.1" });
    expect(on.status).toBe(200);
    expect(s.fingerprint).toBe(fp); // the certificate is reused
    expect((await remoteEntries(s)).filter((e) => e.type === "remote.certificate_changed")).toHaveLength(1);
    expect(await servedFingerprint(remotePort(s))).toBe(fp);
  });

  it("without an Owner credential the UI switch is refused 409, through the one OwnerCredentialRequiredError", async () => {
    const { dataDir } = seed();
    const s = await start(dataDir);
    expect(s.remoteUrl).toBeNull();
    const on = await localJson(s, "PUT", "/api/remote", owner(s), { enabled: true, port: await freePort(), bind: "127.0.0.1" });
    expect(on.status).toBe(409);
    expect(await on.json()).toEqual({ error: "owner_credential_required" });
    expect(await remoteEntries(s)).toEqual([]);
  });

  it("a restart without the flag listens again on the recorded port with the same certificate", async () => {
    const { dataDir } = seed();
    const secrets = new MemorySecretStore();
    const a = await start(dataDir, { remote: ON }, secrets);
    const port = remotePort(a);
    const fp = a.fingerprint!;
    await stop(a);
    const b = await start(dataDir, {}, secrets);
    expect(b.remoteUrl).toBe(`https://127.0.0.1:${port}/`);
    expect(b.fingerprint).toBe(fp);
    expect(await servedFingerprint(port)).toBe(fp);
    expect((await remoteEntries(b)).filter((e) => e.type === "remote.certificate_changed")).toHaveLength(1);
  });

  it("a role change or a removal closes that person's open event sockets", async () => {
    const { dataDir, cookies } = seed();
    const s = await start(dataDir, { remote: ON });
    const port = remotePort(s);
    const viewer = await eventsOverTls(port, { origin: `https://127.0.0.1:${port}`, cookie: cookies.remoteViewer });
    const maintainer = await eventsOverTls(port, { origin: `https://127.0.0.1:${port}`, cookie: cookies.remoteMaintainer });
    expect([viewer.status, maintainer.status]).toEqual([101, 101]);

    expect((await localJson(s, "PATCH", "/api/people/p-viewer", owner(s), { role: "reviewer" })).status).toBe(200);
    expect(await viewer.closed).toEqual({ code: 1008, reason: "role changed" });
    expect(maintainer.ws.readyState).toBe(WebSocket.OPEN);

    expect((await localJson(s, "DELETE", "/api/people/p-maintainer", owner(s))).status).toBe(204);
    expect((await maintainer.closed).code).toBe(1008);
  });

  it("a bad flag fails the start; a busy port leaves the server up with remote off and a fixed line", async () => {
    const { dataDir } = seed();
    await expect(start(dataDir, { remote: { enabled: true, port: 0, bind: "not-an-address" } })).rejects.toMatchObject({ name: "RemoteInputError" });

    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const busy = (blocker.address() as net.AddressInfo).port;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const s = await start(dataDir, { remote: { enabled: true, port: busy, bind: "127.0.0.1" } });
      expect(s.remoteUrl).toBeNull();
      expect(s.fingerprint).toBeNull();
      expect(log).toHaveBeenCalledWith("remote access could not start (remote_start_failed), so it is now off");
      expect((await remoteEntries(s)).map((e) => e.type)).toEqual(["remote.certificate_changed", "remote.enabled", "remote.disabled"]);
      expect((await (await local(s, "/healthz")).json())).toEqual({ ok: true });
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });
});
