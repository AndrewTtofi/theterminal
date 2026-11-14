import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
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

  it("falls back to the next port when the requested one is taken", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const p = (blocker.address() as net.AddressInfo).port;
    try {
      const s = await start({ dataDir: tmp(), port: p });
      expect(s.port).toBe(p + 1);
      expect(s.url).toContain(`:${p + 1}/`);
      // auth must follow the real bound port
      const res = await fetch(base(s) + "/api/health", { headers: auth(s) });
      expect(res.status).toBe(200);
    } finally {
      blocker.close();
    }
  });

  it("starts under a non-ASCII data dir", async () => {
    const dataDir = join(tmp(), "Ανδρέας test dir");
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

    it("registers nothing for / without uiDir", async () => {
      const s = await start({ dataDir: tmp(), port: 0 });
      expect((await fetch(base(s) + "/")).status).toBe(401);
    });
  });
});
