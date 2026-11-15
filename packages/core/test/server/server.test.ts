import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import Database from "better-sqlite3";
import WebSocket from "ws";
import { createServer, selectFetch, selectSecretStore, selectSts, type RunningServer } from "../../src/server/server.js";
import { fakeSts, realSts } from "../../src/connections/cloud/aws.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { ChunkedSecretStore } from "../../src/secrets/store.js";
import { FileSecretStore, KeyInsideDataDirError } from "../../src/secrets/file-store.js";
import { RemoteStartError } from "../../src/server/remote.js";
import { LINKING_ACK, LINK_DEFAULT_PORT } from "@theterminal/shared";
import { openDatabase } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { LinkService } from "../../src/link/service.js";
import { fakeDiscovery } from "../../src/link/discovery.js";
import { LinkListener } from "../../src/link/listener.js";
import { LinkClient, RemoteRefusedError } from "../../src/link/client.js";
import { commitEvent } from "../../src/events/commit.js";
import { getSetting } from "../../src/events/projections.js";
import { LinkIdentity } from "../../src/link/identity.js";
import { registerLinkProtocolRoutes } from "../../src/link/protocol-routes.js";
import { rawTlsGet, tcpAccepts } from "../link/helpers.js";

const running: RunningServer[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.close().catch(() => undefined);
});
// A memory store unless the test brings its own: a server loads its link identity from the store at start, and a
// test must never write one into the real keychain. The in-process discovery, so linking never sends multicast.
const start = async (o: Parameters<typeof createServer>[0]) => {
  const s = await createServer({ secrets: new MemorySecretStore(), discovery: fakeDiscovery(), ...o });
  running.push(s);
  return s;
};
const stop = async (s: RunningServer) => {
  running.splice(running.indexOf(s), 1);
  await s.close();
};
/**
 * Opens the server's db for out-of-band edits, first proving the server let go of it: with no busy wait, an exclusive
 * lock fails at once (SQLITE_BUSY) while any other connection is still open, instead of silently waiting it out.
 */
const openReleased = (dataDir: string) => {
  const db = new Database(join(dataDir, "ledger.db"), { timeout: 0 });
  try {
    db.pragma("locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE; COMMIT");
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
};
const tmp = (name = "tt-") => mkdtempSync(join(tmpdir(), name));
const auth = (s: RunningServer) => ({ authorization: `Bearer ${s.token}` });
const base = (s: RunningServer) => `http://127.0.0.1:${s.port}`;
const post = (s: RunningServer, path: string, body: unknown) =>
  fetch(base(s) + path, {
    method: "POST",
    headers: { ...auth(s), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Raw GET so the path is sent exactly as written (fetch would normalise "/../"). */
const rawGet = (port: number, path: string, host = `127.0.0.1:${port}`) =>
  new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });

// Most tests here start a server, stop it and start another on the same files: several SQLite opens, fsyncs and
// WAL/SHM file creations and deletions each. On a loaded Windows runner, where file operations are scanned and
// retried, that has taken over 5 s (the default). openReleased shows no lock is left behind to wait on, so this is
// slowness alone: these get a longer, still bounded, timeout.
describe("createServer", { timeout: 30_000 }, () => {
  it("checks project names and card titles with the server's own secrets and data folder", async () => {
    const dataDir = tmp();
    const s = await start({ dataDir, port: 0 });
    const named = await post(s, "/api/projects", { name: `Club ${s.token}` });
    expect(named.status).toBe(400);
    expect(await named.json()).toEqual({ error: "secret_in_text" });
    const p = (await (await post(s, "/api/projects", { name: "Club" })).json()) as { id: string };
    const titled = await post(s, `/api/projects/${p.id}/cards`, { title: `token ${s.token}`, stage: "plan" });
    expect(titled.status).toBe(400);
    expect(await titled.json()).toEqual({ error: "secret_in_text" });
    const card = await post(s, `/api/projects/${p.id}/cards`, { title: `Read ${join(dataDir, "notes.md")}`, stage: "plan" });
    const { title } = (await card.json()) as { title: string };
    expect(title).toMatch(/^Read <data>/);
    expect(title).not.toContain(dataDir);
  });

  it("persists data and the token across restarts", async () => {
    const dataDir = tmp();
    const a = await start({ dataDir, port: 0 });
    const res = await post(a, "/api/projects", { name: "P", pitch: "pitch" });
    expect(res.status).toBe(201);
    const token = a.token;
    expect(a.url).toBe(`http://theterminal.localhost:${a.port}/?token=${token}`);
    expect(a.loopbackUrl).toBe(`http://127.0.0.1:${a.port}/`);
    await stop(a);

    const b = await start({ dataDir, port: 0 });
    expect(b.token).toBe(token);
    const list = await (await fetch(base(b) + "/api/projects", { headers: auth(b) })).json();
    expect(list).toHaveLength(1);
  });

  it("writes the token file with mode 0600, trims it, and regenerates an empty one", async () => {
    const dataDir = tmp();
    const a = await start({ dataDir, port: 0 });
    if (process.platform !== "win32") expect(statSync(join(dataDir, "token")).mode & 0o777).toBe(0o600);
    await stop(a);

    writeFileSync(join(dataDir, "token"), "  abc123\n");
    const b = await start({ dataDir, port: 0 });
    expect(b.token).toBe("abc123");
    await stop(b);

    writeFileSync(join(dataDir, "token"), "\n");
    const c = await start({ dataDir, port: 0 });
    expect(c.token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dataDir, "token"), "utf8").trim()).toBe(c.token);
  });

  it("goes read-only when the ledger is tampered with", async () => {
    const dataDir = tmp();
    const a = await start({ dataDir, port: 0 });
    await post(a, "/api/projects", { name: "P", pitch: "x" });
    await stop(a);

    const db = openReleased(dataDir);
    db.exec("DROP TRIGGER ledger_no_update; DROP TRIGGER ledger_no_delete;");
    db.prepare("UPDATE ledger SET payload = ? WHERE seq = 1").run('{"tampered":true}');
    db.close();

    const b = await start({ dataDir, port: 0 });
    expect(b.integrity.ok).toBe(false);
    const health = await (await fetch(base(b) + "/api/health", { headers: auth(b) })).json();
    expect(health.integrity).toBe("broken");
    expect(health.brokenAtSeq).toBe(1);
    const res = await post(b, "/api/projects", { name: "Q", pitch: "y" });
    expect(res.status).toBe(423);
  });

  /** Open the server's db directly, triggers dropped, for out-of-band edits. */
  const tamper = (dataDir: string, fn: (db: Database.Database) => void) => {
    const db = openReleased(dataDir);
    db.exec("DROP TRIGGER IF EXISTS ledger_no_update; DROP TRIGGER IF EXISTS ledger_no_delete;");
    fn(db);
    db.close();
  };
  const seedProjectWithCard = async (dataDir: string) => {
    const a = await start({ dataDir, port: 0 });
    const project = await (await post(a, "/api/projects", { name: "P", pitch: "x" })).json();
    const card = await (await post(a, `/api/projects/${project.id}/cards`, { title: "C", stage: "plan" })).json();
    await stop(a);
    // The server records this computer's link identity first, so the project's entries do not start at seq 1.
    const db = new Database(join(dataDir, "ledger.db"), { readonly: true });
    const seqOf = (type: string) => (db.prepare("SELECT seq FROM ledger WHERE type = ?").get(type) as { seq: number }).seq;
    const projectSeq = seqOf("project.created");
    const cardSeq = seqOf("card.created");
    db.close();
    return { projectId: project.id as string, cardId: card.id as string, projectSeq, cardSeq };
  };
  const getBoard = async (s: RunningServer, projectId: string) =>
    (await fetch(`${base(s)}/api/projects/${projectId}/board`, { headers: auth(s) })).json();

  it("close() lets go of the database at once, so it can be reopened exclusively with no wait", async () => {
    const dataDir = tmp();
    const a = await start({ dataDir, port: 0 });
    expect(() => openReleased(dataDir)).toThrow(expect.objectContaining({ code: "SQLITE_BUSY" })); // the probe works
    await post(a, "/api/projects", { name: "P", pitch: "x" });
    await stop(a);
    openReleased(dataDir).close();
  });

  it("rebuilds projections at startup, undoing direct edits to the cards table", async () => {
    const dataDir = tmp();
    const { projectId, cardId } = await seedProjectWithCard(dataDir);
    tamper(dataDir, (db) => {
      db.prepare("UPDATE cards SET stage = 'ship'").run();
      db.prepare(
        `INSERT INTO cards (id, project_id, title, stage, status, created_at, updated_at)
         VALUES ('ghost', ?, 'Ghost', 'build', 'todo', 'x', 'x')`,
      ).run(projectId);
    });

    const b = await start({ dataDir, port: 0 });
    expect(b.integrity.ok).toBe(true);
    const board = await getBoard(b, projectId);
    expect(board.columns.plan.map((c: { id: string }) => c.id)).toEqual([cardId]);
    expect(board.columns.ship).toEqual([]);
    expect(board.columns.build).toEqual([]);
  });

  it("drops the card of a deleted tail entry at startup", async () => {
    const dataDir = tmp();
    const { projectId } = await seedProjectWithCard(dataDir);
    tamper(dataDir, (db) => db.prepare("DELETE FROM ledger WHERE seq = (SELECT MAX(seq) FROM ledger)").run());

    const b = await start({ dataDir, port: 0 });
    expect(b.integrity.ok).toBe(true);
    const board = await getBoard(b, projectId);
    expect(board.columns.plan).toEqual([]);
  });

  it("on a broken chain, projects only the entries before the break", async () => {
    const dataDir = tmp();
    const { projectId, cardSeq } = await seedProjectWithCard(dataDir);
    tamper(dataDir, (db) =>
      db.prepare("UPDATE ledger SET payload = ? WHERE seq = ?").run(
        JSON.stringify({ cardId: "evil", title: "Evil", stage: "ship" }),
        cardSeq,
      ),
    );

    const b = await start({ dataDir, port: 0 });
    expect(b.integrity).toEqual({ ok: false, brokenAtSeq: cardSeq });
    const board = await getBoard(b, projectId);
    expect(Object.values(board.columns).flat()).toEqual([]);
  });

  it("serves entries before an unparseable payload over HTTP and WS", async () => {
    const dataDir = tmp();
    const { projectId, projectSeq, cardSeq } = await seedProjectWithCard(dataDir);
    tamper(dataDir, (db) => db.prepare("UPDATE ledger SET payload = ? WHERE seq = ?").run("{not json", cardSeq));

    const b = await start({ dataDir, port: 0 });
    expect(b.integrity).toEqual({ ok: false, brokenAtSeq: cardSeq });
    const res = await fetch(`${base(b)}/api/ledger?projectId=${projectId}`, { headers: auth(b) });
    expect(res.status).toBe(200);
    expect((await res.json()).map((e: { seq: number }) => e.seq)).toEqual([projectSeq]);
    expect((await getBoard(b, projectId)).project.name).toBe("P");

    const ws = new WebSocket(`ws://127.0.0.1:${b.port}/api/events`, { headers: auth(b) });
    ws.on("error", () => undefined);
    const first = await new Promise<{ seq: number }>((resolve, reject) => {
      ws.once("message", (d) => resolve(JSON.parse(String(d))));
      ws.once("close", (code) => reject(new Error(`closed ${code}`)));
    });
    expect(first.seq).toBe(1);
    ws.terminate();
  });

  it("refuses to start when dataDir is inside or equal to uiDir", async () => {
    const root = tmp();
    writeFileSync(join(root, "index.html"), "<html>ui</html>");
    await expect(createServer({ dataDir: join(root, "data"), uiDir: root, port: 0, secrets: new MemorySecretStore() })).rejects.toThrow(
      /data directory .* inside the UI directory/i,
    );
    await expect(createServer({ dataDir: root, uiDir: root, port: 0, secrets: new MemorySecretStore() })).rejects.toThrow(
      /data directory .* inside the UI directory/i,
    );
    expect(existsSync(join(root, "data", "token"))).toBe(false);
    expect(existsSync(join(root, "token"))).toBe(false);
    expect(existsSync(join(root, "ledger.db"))).toBe(false);
  });

  it("falls back to the next port when the requested one is taken", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const p = (blocker.address() as net.AddressInfo).port;
    try {
      const s = await start({ dataDir: tmp(), port: p });
      // p+1 may itself be taken by another process; any port in the fallback range will do
      expect(s.port).toBeGreaterThan(p);
      expect(s.port).toBeLessThanOrEqual(p + 20);
      expect(s.url).toContain(`:${s.port}/`);
      // auth must follow the real bound port
      const res = await fetch(base(s) + "/api/health", { headers: auth(s) });
      expect(res.status).toBe(200);
    } finally {
      blocker.close();
    }
  });

  it("starts under a non-ASCII data dir", async () => {
    const dataDir = join(tmp(), "Δοκιμή ünïcödé dir");
    const a = await start({ dataDir, port: 0 });
    await post(a, "/api/projects", { name: "P", pitch: "x" });
    await stop(a);
    const b = await start({ dataDir, port: 0 });
    const list = await (await fetch(base(b) + "/api/projects", { headers: auth(b) })).json();
    expect(list).toHaveLength(1);
  });

  it("starts only with every route in the role table, and the hook is wired: the Owner by token, HEAD as GET, no proxy trust", async () => {
    // Starting at all means assertRoutesHaveRoles(app) returned [] for every route this server registers.
    const s = await start({ dataDir: tmp(), port: 0 });
    const health = await fetch(base(s) + "/api/health", { headers: { ...auth(s), "x-forwarded-for": "203.0.113.9" } });
    expect(health.status).toBe(200);
    const head = await fetch(base(s) + "/api/projects", { method: "HEAD", headers: auth(s) });
    expect(head.status).toBe(200);
    const anonymous = await fetch(base(s) + "/api/projects");
    expect(anonymous.status).toBe(401);
    const unknown = await fetch(base(s) + "/api/nope", { headers: auth(s) });
    expect(unknown.status).toBe(404);
    // The ledger holds nothing about the Owner yet: the token still names them, with the virtual Owner's name.
    const status = await (await fetch(base(s) + "/api/status", { headers: auth(s) })).json();
    expect(status).toBeTypeOf("object");
  });

  it("answers GET /api/presence with who is on the event stream", async () => {
    const s = await start({ dataDir: tmp(), port: 0 });
    expect(await (await fetch(base(s) + "/api/presence", { headers: auth(s) })).json()).toEqual([]);
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/events`, { headers: auth(s) });
    ws.on("error", () => undefined);
    // Entries (with seq) come first; the presence frame (no seq) follows the backlog.
    const frame = await new Promise<{ type: string; people: { personId: string }[] }>((resolve) =>
      ws.on("message", (d) => {
        const m = JSON.parse(String(d));
        if (!("seq" in m)) resolve(m);
      }),
    );
    expect(frame.type).toBe("presence");
    expect(frame.people.map((p) => p.personId)).toEqual(["owner"]);
    const listed = (await (await fetch(base(s) + "/api/presence", { headers: auth(s) })).json()) as { personId: string; role: string }[];
    expect(listed).toMatchObject([{ personId: "owner", role: "owner" }]);
    ws.terminate();
  });

  it("serves the people routes: the Owner by token reads Me and invites, the join page is public", async () => {
    const s = await start({ dataDir: tmp(), port: 0 });
    const me = await fetch(base(s) + "/api/me", { headers: auth(s) });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ personId: "owner", role: "owner", method: "token", listener: "local" });
    const created = await post(s, "/api/people/invites", { role: "viewer" });
    expect(created.status).toBe(201);
    const { url, fingerprint } = (await created.json()) as { url: string; fingerprint: string | null };
    expect(url).toMatch(new RegExp(`^http://theterminal\\.localhost:${s.port}/join/[A-Za-z0-9_-]{22}$`));
    expect(fingerprint).toBeNull();
    const join = await fetch(base(s) + "/api/join/" + url.split("/join/")[1]);
    expect(await join.json()).toMatchObject({ role: "viewer", passkeys: false });
  });

  it("closes promptly with a WebSocket client connected", async () => {
    const s = await start({ dataDir: tmp(), port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/events`, { headers: auth(s) });
    await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
    ws.on("error", () => undefined);
    await stop(s);
  });

  describe("static UI", () => {
    const setup = async () => {
      const root = tmp();
      const uiDir = join(root, "ui");
      mkdirSync(join(uiDir, "assets"), { recursive: true });
      writeFileSync(join(uiDir, "index.html"), "<html>ui</html>");
      writeFileSync(join(uiDir, "assets", "app.js"), "console.log(1)");
      const dataDir = join(root, "data");
      const s = await start({ dataDir, uiDir, port: 0 });
      return { s, dataDir };
    };

    it("serves index and assets without a token, and bootstraps the cookie on /", async () => {
      const { s } = await setup();
      const index = await fetch(base(s) + "/");
      expect(index.status).toBe(200);
      expect(await index.text()).toContain("ui");
      expect(await (await fetch(base(s) + "/assets/app.js")).text()).toBe("console.log(1)");

      const loopback = await rawGet(s.port, `/?token=${s.token}`);
      expect(loopback.status).toBe(302);
      expect(loopback.headers.location).toBe(s.url);
      expect(loopback.headers["set-cookie"]).toBeUndefined();
      const boot = await rawGet(s.port, `/?token=${s.token}`, `theterminal.localhost:${s.port}`);
      expect(boot.status).toBe(302);
      expect(String(boot.headers["set-cookie"])).toContain("tt_token=");
      expect((await fetch(`${base(s)}/?token=wrong`, { redirect: "manual" })).status).toBe(401);
      expect((await fetch(base(s) + "/api/projects")).status).toBe(401);
    });

    it("never serves files outside uiDir", async () => {
      const { s, dataDir } = await setup();
      const secret = readFileSync(join(dataDir, "token"), "utf8");
      for (const path of [
        "/../data/token",
        "/../token",
        "/%2e%2e/data/token",
        "/%2e%2e%2fdata%2ftoken",
        "/..%2fdata%2ftoken",
        "/assets/../../data/token",
        "/assets/%2e%2e/%2e%2e/data/token",
        "/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
        "/..%5cdata%5ctoken",
      ]) {
        const res = await rawGet(s.port, path);
        expect(res.body, path).not.toContain(secret);
        expect(res.status, path).not.toBe(200);
      }
    });

    it("refuses dotfiles, token files and database files inside uiDir", async () => {
      const root = tmp();
      const uiDir = join(root, "ui");
      mkdirSync(join(uiDir, ".git"), { recursive: true });
      writeFileSync(join(uiDir, "index.html"), "<html>ui</html>");
      for (const f of [".env", ".git/config", "token", "TOKEN", "ledger.db", "ledger.db-wal", "ledger.db-shm", "x.DB"]) {
        writeFileSync(join(uiDir, f), "secret");
      }
      const s = await start({ dataDir: join(root, "data"), uiDir, port: 0 });
      for (const path of ["/.env", "/.git/config", "/token", "/TOKEN", "/ledger.db", "/ledger.db-wal", "/ledger.db-shm", "/x.DB"]) {
        const res = await rawGet(s.port, path);
        expect(res.status, path).toBe(404);
        expect(res.body, path).not.toContain("secret");
      }
      expect((await rawGet(s.port, "/")).status).toBe(200);
    });

    it("registers nothing for / without uiDir", async () => {
      const s = await start({ dataDir: tmp(), port: 0 });
      expect((await fetch(base(s) + "/")).status).toBe(401);
    });
  });
});

describe("the file secret store", () => {
  const dirs = () => {
    const root = mkdtempSync(join(tmpdir(), "tt-file-store-"));
    return { dataDir: join(root, "data"), keyFile: join(root, "key", "secret.key") };
  };

  it("is chosen only by the flags, never by the environment", () => {
    expect(selectSecretStore({ THETERMINAL_SECRET_STORE: "file" }).kind).toBe("keychain");
    expect(selectSecretStore({ ...{ THETERMINAL_FAKE_AGENT: "1" }, THETERMINAL_SECRET_STORE: "file" }).kind).toBe("keychain");
    const { dataDir, keyFile } = dirs();
    const chosen = selectSecretStore({ VITEST: "true" }, undefined, { store: "file", keyFile, dataDir });
    expect(chosen.kind).toBe("file");
    expect(chosen.store).toBeInstanceOf(FileSecretStore);
    expect(selectSecretStore({}, undefined, { store: "keychain", keyFile, dataDir }).kind).toBe("keychain");
  });

  it("refuses a key file inside the data folder unless allowed", () => {
    const { dataDir } = dirs();
    const keyFile = join(dataDir, "secret.key");
    expect(() => selectSecretStore({}, undefined, { store: "file", keyFile, dataDir })).toThrow(KeyInsideDataDirError);
    expect(() => selectSecretStore({}, undefined, { store: "file", keyFile, dataDir })).toThrow(
      "Refusing to start: the secret key file is inside the data directory",
    );
    expect(selectSecretStore({}, undefined, { store: "file", keyFile, dataDir, allowKeyInDataDir: true }).kind).toBe("file");
  });

  it("needs a key file and a data folder", () => {
    const { dataDir, keyFile } = dirs();
    expect(() => selectSecretStore({}, undefined, { store: "file", dataDir })).toThrow();
    expect(() => selectSecretStore({}, undefined, { store: "file", keyFile })).toThrow();
  });

  it("a server on the file store creates the key at startup and keeps secrets encrypted in the data folder", async () => {
    const { dataDir, keyFile } = dirs();
    const s = await createServer({ dataDir, port: 0, discovery: fakeDiscovery(), secretStore: "file", secretKeyFile: keyFile });
    running.push(s);
    expect(existsSync(keyFile)).toBe(true);
    expect(statSync(keyFile).size).toBe(32);
    if (process.platform !== "win32") expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dataDir, "secret.key"))).toBe(false);
  });

  it("a server refuses to start with the key file inside its data folder, and releases the lock", async () => {
    const { dataDir } = dirs();
    await expect(
      createServer({ dataDir, port: 0, discovery: fakeDiscovery(), secretStore: "file", secretKeyFile: join(dataDir, "k", "secret.key") }),
    ).rejects.toBeInstanceOf(KeyInsideDataDirError);
    expect(existsSync(join(dataDir, "server.lock"))).toBe(false);
    expect(existsSync(join(dataDir, "k", "secret.key"))).toBe(false);
  });
});

describe("the Owner bootstrap invite at startup", () => {
  it("is not issued while remote access is off, and the server never calls bootstrapInvite", async () => {
    const dataDir = tmp();
    const seen: string[] = [];
    await start({ dataDir, port: 0, bootstrapInvite: (u) => seen.push(u) });
    expect(seen).toEqual([]);
    expect(existsSync(join(dataDir, "bootstrap-invite"))).toBe(false);
  });

  it("refuses --remote until the remote listener is wired, before taking the data folder", async () => {
    const dataDir = tmp();
    await expect(start({ dataDir, port: 0, remote: { enabled: true, port: 0, bind: "127.0.0.1" } })).rejects.toBeInstanceOf(RemoteStartError);
    expect(existsSync(join(dataDir, "server.lock"))).toBe(false);
  });

  it("a leftover bootstrap file is removed at startup once the Owner has a credential", async () => {
    const dataDir = tmp();
    const s = await start({ dataDir, port: 0 });
    await stop(s);
    const db = openDatabase(join(dataDir, "ledger.db"));
    commitEvent(db, new Ledger(db), () => ({
      event: {
        projectId: null, actor: { kind: "human", id: "owner" }, type: "person.credential_added",
        payload: { personId: "owner", credential: { kind: "key", credentialId: "key-1", publicKey: "TESTKEY1", label: "Key" } },
      },
      result: () => undefined,
    }));
    db.close();
    writeFileSync(join(dataDir, "bootstrap-invite"), "https://192.0.2.10:4318/join/old#fp=AA\n");
    await start({ dataDir, port: 0 });
    expect(existsSync(join(dataDir, "bootstrap-invite"))).toBe(false);
  });
});

describe("test doubles for connections", () => {
  const FAKE = { THETERMINAL_FAKE_AGENT: "1" };

  const storeOf = (...args: Parameters<typeof selectSecretStore>) => selectSecretStore(...args).store;

  it("uses the memory secret store only when THETERMINAL_FAKE_AGENT=1 and THETERMINAL_SECRET_STORE=memory", () => {
    expect(storeOf({ ...FAKE, THETERMINAL_SECRET_STORE: "memory" })).toBeInstanceOf(MemorySecretStore);
    expect(selectSecretStore({ ...FAKE, THETERMINAL_SECRET_STORE: "memory" }).kind).toBe("memory");
    expect(storeOf({ THETERMINAL_SECRET_STORE: "memory" })).toBeInstanceOf(ChunkedSecretStore);
    expect(storeOf({ THETERMINAL_FAKE_AGENT: "0", THETERMINAL_SECRET_STORE: "memory" })).toBeInstanceOf(ChunkedSecretStore);
    expect(selectSecretStore(FAKE)).toMatchObject({ kind: "keychain", store: expect.any(ChunkedSecretStore) });
    const injected = new MemorySecretStore();
    expect(selectSecretStore({}, injected)).toEqual({ store: injected, kind: "memory" });
  });

  it("refuses to fall back to the real keychain under vitest: a test server must inject its store or set the flags", () => {
    expect(() => selectSecretStore({ VITEST: "true" })).toThrow(/keychain/);
    expect(() => selectSecretStore({ VITEST: "true", THETERMINAL_SECRET_STORE: "memory" })).toThrow(/keychain/);
    expect(storeOf({ VITEST: "true", ...FAKE, THETERMINAL_SECRET_STORE: "memory" })).toBeInstanceOf(MemorySecretStore);
    const injected = new MemorySecretStore();
    expect(storeOf({ VITEST: "true" }, injected)).toBe(injected);
  });

  it("uses the fake HTTP stub only when THETERMINAL_FAKE_AGENT=1 and THETERMINAL_FAKE_HTTP=1", async () => {
    expect(selectFetch({ THETERMINAL_FAKE_HTTP: "1" })).toBe(globalThis.fetch);
    expect(selectFetch(FAKE)).toBe(globalThis.fetch);
    const injected = (async () => new Response()) as unknown as typeof fetch;
    expect(selectFetch({ ...FAKE, THETERMINAL_FAKE_HTTP: "1" }, injected)).toBe(injected);

    const stub = selectFetch({ ...FAKE, THETERMINAL_FAKE_HTTP: "1" });
    expect(stub).not.toBe(globalThis.fetch);
    const ok = await stub("https://example.invalid/v1/models", { headers: { "x-api-key": "sk-ant-TESTKEY-0000000000" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({});
    const bearer = await stub("https://example.invalid/user", { headers: new Headers({ Authorization: "Bearer ghp_TESTKEY0000" }) });
    expect(bearer.status).toBe(200);
    expect((await stub("https://example.invalid/v1/models", { headers: { "x-api-key": "sk-ant-other" } })).status).toBe(401);
    expect((await stub("https://example.invalid/v1/models")).status).toBe(401);
  });
});

describe("test doubles for cloud connections", () => {
  const FAKE = { THETERMINAL_FAKE_AGENT: "1", THETERMINAL_FAKE_HTTP: "1" };
  const stub = selectFetch(FAKE);
  const form = (o: Record<string, string>) => ({
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString(),
  });
  const TOKEN = { access_token: "TESTKEY-access-token-0000000000", expires_in: 3600, token_type: "Bearer" };

  it("uses the fake STS caller only when THETERMINAL_FAKE_AGENT=1 and THETERMINAL_FAKE_HTTP=1", () => {
    expect(selectSts(FAKE)).toBe(fakeSts);
    expect(selectSts({ THETERMINAL_FAKE_HTTP: "1" })).toBe(realSts);
    expect(selectSts({ THETERMINAL_FAKE_AGENT: "1" })).toBe(realSts);
    expect(selectSts({ THETERMINAL_FAKE_AGENT: "0", THETERMINAL_FAKE_HTTP: "1" })).toBe(realSts);
    expect(selectSts({})).toBe(realSts);
    const injected = { ...fakeSts };
    expect(selectSts(FAKE, injected)).toBe(injected);
  });

  it("answers the Google token endpoint with a fake token when the body is a grant", async () => {
    const ok = await stub("https://oauth2.googleapis.com/token", form({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: "a.b.c" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(TOKEN);
    expect((await stub("https://oauth2.googleapis.com/token", form({ assertion: "a.b.c" }))).status).toBe(401);
  });

  it("answers the Azure token endpoint only for a TESTKEY client secret", async () => {
    const url = "https://login.microsoftonline.com/00000000-0000-0000-0000-00000000aaaa/oauth2/v2.0/token";
    const grant = { grant_type: "client_credentials", client_id: "x", scope: "https://management.azure.com/.default" };
    const ok = await stub(url, form({ ...grant, client_secret: "TESTKEY-azure-secret-0000000000" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(TOKEN);
    expect((await stub(url, form({ ...grant, client_secret: "another-secret-0000000000" }))).status).toBe(401);
    expect((await stub(url, form(grant))).status).toBe(401);
  });

  it("keeps the header rule for everything else, so a fake Bearer token reads the project or subscription", async () => {
    const auth = { headers: { authorization: "Bearer TESTKEY-access-token-0000000000" } };
    expect((await stub("https://management.azure.com/subscriptions/00000000-0000-0000-0000-00000000cccc?api-version=2022-12-01", auth)).status).toBe(200);
    expect((await stub("https://cloudresourcemanager.googleapis.com/v1/projects/tt-test-project", { headers: { authorization: "Bearer other" } })).status).toBe(401);
  });

  it("tests an Azure connection end to end through the fakes, recording no secret", async () => {
    const saved = { agent: process.env.THETERMINAL_FAKE_AGENT, http: process.env.THETERMINAL_FAKE_HTTP };
    process.env.THETERMINAL_FAKE_AGENT = "1";
    process.env.THETERMINAL_FAKE_HTTP = "1";
    try {
      const dataDir = tmp();
      const s = await start({ dataDir, port: 0, secrets: new MemorySecretStore() });
      const added = await post(s, "/api/connections", {
        kind: "cloud", provider: "azure", name: "Ops Azure",
        config: {
          tenantId: "00000000-0000-0000-0000-00000000aaaa", clientId: "00000000-0000-0000-0000-00000000bbbb",
          subscriptionId: "00000000-0000-0000-0000-00000000cccc",
        },
        secrets: { clientSecret: "TESTKEY-azure-secret-0000000000" },
      });
      expect(added.status).toBe(201);
      const { id } = (await added.json()) as { id: string };
      const res = await fetch(`${base(s)}/api/connections/${id}/test`, { method: "POST", headers: auth(s) });
      expect(await res.json()).toEqual({ ok: true, message: "Connected" });
      const db = new Database(join(dataDir, "ledger.db"), { readonly: true });
      const rows = db.prepare("SELECT payload FROM ledger WHERE type = 'connection.tested'").all() as { payload: string }[];
      const all = db.prepare("SELECT payload FROM ledger").all() as { payload: string }[];
      db.close();
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.payload)).toMatchObject({ connectionId: id, ok: true, message: "Connected" });
      for (const r of all) {
        expect(r.payload).not.toContain("TESTKEY-azure-secret");
        expect(r.payload).not.toContain("TESTKEY-access-token");
      }
    } finally {
      for (const [k, v] of [["THETERMINAL_FAKE_AGENT", saved.agent], ["THETERMINAL_FAKE_HTTP", saved.http]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("createServer link listener", { timeout: 30_000 }, () => {
  it("starts with linkBind on loopback, and listens for links only after the opt-in", async () => {
    const dataDir = tmp();
    const secrets = new MemorySecretStore();
    const s = await start({ dataDir, port: 0, secrets, linkBind: "127.0.0.1" });
    const health = await fetch(`${base(s)}/api/health`, { headers: auth(s) });
    expect(health.status).toBe(200);
    expect(await tcpAccepts(LINK_DEFAULT_PORT)).toBe(false);
    await stop(s);

    // The opt-in is recorded in this data folder (as POST /api/link/enable will), on a port of the test's own.
    const db = openDatabase(join(dataDir, "ledger.db"));
    const ledger = new Ledger(db);
    const link: LinkService = new LinkService({
      db, ledger, secrets, bind: "127.0.0.1", discovery: fakeDiscovery(),
      listener: (deps) => new LinkListener(deps),
      client: (identity) => new LinkClient({ identity }),
      registerProtocol: (app) => registerLinkProtocolRoutes(app, { link }),
    });
    await link.load();
    const port = await link.enableLinking({ kind: "human", id: "owner" }, LINKING_ACK, 0);
    await link.shutdown();
    db.close();
    expect(await tcpAccepts(port)).toBe(false);

    // A restart with the recorded opt-in starts the listener once every dependency exists.
    const again = await start({ dataDir, port: 0, secrets, linkBind: "127.0.0.1" });
    expect(await tcpAccepts(port)).toBe(true);
    expect(again.loopbackUrl).toBe(`http://127.0.0.1:${again.port}/`);
    expect((await fetch(`${base(again)}/api/health`, { headers: auth(again) })).status).toBe(200);
    // The link listener serves no workspace route, and the workspace server no link route.
    const stranger = await LinkIdentity.load({ secrets: new MemorySecretStore(), onCreated: () => undefined });
    expect((await rawTlsGet(port, "/api/health", stranger)).kind).toBe("closed");
    expect((await fetch(`${base(again)}/link/v1/hello`, { headers: auth(again) })).status).toBe(404);
    await stop(again);
    expect(await tcpAccepts(port)).toBe(false);
  });

  it("serves the remote-run routes to a paired machine once the listener starts", async () => {
    const dataDir = tmp();
    const secrets = new MemorySecretStore();
    await stop(await start({ dataDir, port: 0, secrets, linkBind: "127.0.0.1" }));
    const requester = await LinkIdentity.load({ secrets: new MemorySecretStore(), onCreated: () => undefined });
    const db = openDatabase(join(dataDir, "ledger.db"));
    const ledger = new Ledger(db);
    const link: LinkService = new LinkService({
      db, ledger, secrets, bind: "127.0.0.1", discovery: fakeDiscovery(),
      listener: (deps) => new LinkListener(deps),
      client: (identity) => new LinkClient({ identity }),
      registerProtocol: (app) => registerLinkProtocolRoutes(app, { link }),
    });
    await link.load();
    const port = await link.enableLinking({ kind: "human", id: "owner" }, LINKING_ACK, 0);
    await link.shutdown();
    commitEvent(db, ledger, () => ({
      event: {
        projectId: null, actor: { kind: "human", id: "owner" }, type: "machine.paired",
        payload: {
          machineId: requester.machineId, name: "Laptop", publicKey: requester.publicKeyBase64, fingerprint: requester.fingerprint,
          address: "127.0.0.1:1", role: "showed_code",
        },
      },
      result: () => undefined,
    }));
    const peer = { machineId: getSetting(db, "link.machineId")!, address: `127.0.0.1:${port}`, publicKeyDer: Buffer.from(getSetting(db, "link.publicKey")!, "base64") };
    db.close();

    const s = await start({ dataDir, port: 0, secrets, linkBind: "127.0.0.1" });
    const body = { v: 1, projectId: "p1", projectName: "Demo", adapter: "fake", prompt: "p", cardId: null, connectionIds: [] };
    const err = await new LinkClient({ identity: requester }).request(peer, "POST", "/link/v1/runs/run-1/start", body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteRefusedError);
    expect((err as RemoteRefusedError).code).toBe("no_repo");
    await stop(s);
  });

  it("records this computer's identity once in the ledger", async () => {
    const dataDir = tmp();
    const secrets = new MemorySecretStore();
    await stop(await start({ dataDir, port: 0, secrets, linkBind: "127.0.0.1" }));
    await stop(await start({ dataDir, port: 0, secrets, linkBind: "127.0.0.1" }));
    const db = new Database(join(dataDir, "ledger.db"), { readonly: true });
    const rows = db.prepare("SELECT payload FROM ledger WHERE type = 'machine.identity_created'").all() as { payload: string }[];
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).not.toContain("PRIVATE");
  });
});
