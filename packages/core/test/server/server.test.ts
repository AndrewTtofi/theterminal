import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import Database from "better-sqlite3";
import WebSocket from "ws";
import { createServer, type RunningServer } from "../../src/server/server.js";

const running: RunningServer[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.close().catch(() => undefined);
});
const start = async (o: Parameters<typeof createServer>[0]) => {
  const s = await createServer(o);
  running.push(s);
  return s;
};
const stop = async (s: RunningServer) => {
  running.splice(running.indexOf(s), 1);
  await s.close();
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
const rawGet = (port: number, path: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });

describe("createServer", () => {
  it("persists data and the token across restarts", async () => {
    const dataDir = tmp();
    const a = await start({ dataDir, port: 0 });
    const res = await post(a, "/api/projects", { name: "P", pitch: "pitch" });
    expect(res.status).toBe(201);
    const token = a.token;
    expect(a.url).toBe(`http://127.0.0.1:${a.port}/?token=${token}`);
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

    const db = new Database(join(dataDir, "ledger.db"));
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
    const db = new Database(join(dataDir, "ledger.db"));
    db.exec("DROP TRIGGER IF EXISTS ledger_no_update; DROP TRIGGER IF EXISTS ledger_no_delete;");
    fn(db);
    db.close();
  };
  const seedProjectWithCard = async (dataDir: string) => {
    const a = await start({ dataDir, port: 0 });
    const project = await (await post(a, "/api/projects", { name: "P", pitch: "x" })).json();
    const card = await (await post(a, `/api/projects/${project.id}/cards`, { title: "C", stage: "plan" })).json();
    await stop(a);
    return { projectId: project.id as string, cardId: card.id as string };
  };
  const getBoard = async (s: RunningServer, projectId: string) =>
    (await fetch(`${base(s)}/api/projects/${projectId}/board`, { headers: auth(s) })).json();

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
    const { projectId } = await seedProjectWithCard(dataDir);
    tamper(dataDir, (db) =>
      db.prepare("UPDATE ledger SET payload = ? WHERE seq = 2").run(
        JSON.stringify({ cardId: "evil", title: "Evil", stage: "ship" }),
      ),
    );

    const b = await start({ dataDir, port: 0 });
    expect(b.integrity).toEqual({ ok: false, brokenAtSeq: 2 });
    const board = await getBoard(b, projectId);
    expect(Object.values(board.columns).flat()).toEqual([]);
  });

  it("serves entries before an unparseable payload over HTTP and WS", async () => {
    const dataDir = tmp();
    const { projectId } = await seedProjectWithCard(dataDir);
    tamper(dataDir, (db) => db.prepare("UPDATE ledger SET payload = ? WHERE seq = 2").run("{not json"));

    const b = await start({ dataDir, port: 0 });
    expect(b.integrity).toEqual({ ok: false, brokenAtSeq: 2 });
    const res = await fetch(`${base(b)}/api/ledger?projectId=${projectId}`, { headers: auth(b) });
    expect(res.status).toBe(200);
    expect((await res.json()).map((e: { seq: number }) => e.seq)).toEqual([1]);
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
    await expect(createServer({ dataDir: join(root, "data"), uiDir: root, port: 0 })).rejects.toThrow(
      /data directory .* inside the UI directory/i,
    );
    await expect(createServer({ dataDir: root, uiDir: root, port: 0 })).rejects.toThrow(
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

      const boot = await fetch(`${base(s)}/?token=${s.token}`, { redirect: "manual" });
      expect(boot.status).toBe(302);
      expect(boot.headers.get("set-cookie")).toContain("tt_token=");
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
