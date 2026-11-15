import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { LedgerEntry, ShareLink, ShareSnapshotRecord } from "@theterminal/shared";
import { openDatabase } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { commitEvent } from "../../src/events/commit.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { createServer, type RunningServer } from "../../src/server/server.js";

const NO_BUNDLED = { claude: () => null, codex: () => null, gemini: () => null };
const running: RunningServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (running.length) await running.pop()!.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(dataDir?: string) {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "tt-share-links-"));
  if (!dataDir) dirs.push(dir);
  const s = await createServer({
    dataDir: dir, port: 0, sharePort: 0, which: () => null, bundled: NO_BUNDLED, secrets: new MemorySecretStore(),
  });
  running.push(s);
  return { s, dataDir: dir };
}
const stop = async (s: RunningServer) => {
  running.splice(running.indexOf(s), 1);
  await s.close();
};

const base = (s: RunningServer) => `http://127.0.0.1:${s.port}`;
const send = (s: RunningServer, method: string, path: string, body?: unknown, authed = true) =>
  fetch(base(s) + path, {
    method,
    headers: {
      ...(authed && { authorization: `Bearer ${s.token}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await res).json() as Promise<T>;
const status = async (s: RunningServer) => (await json<{ shareLinks: number }>(send(s, "GET", "/api/status"))).shareLinks;
const links = (s: RunningServer, q = "") => json<ShareLink[]>(send(s, "GET", `/api/share/links${q}`));
const shareEntries = async (s: RunningServer) =>
  (await json<LedgerEntry[]>(send(s, "GET", "/api/ledger"))).filter((e) => /^share\.(link_created|revoked|expired|stopped)$/.test(e.type));

async function confirmedSnapshot(s: RunningServer) {
  const { id } = await json<{ id: string }>(send(s, "POST", "/api/projects", { name: "Book Club", pitch: "Reading lists for a club" }));
  const p = await json<{ previewId: string; contentHash: string; html: string }>(send(s, "POST", `/api/projects/${id}/share/preview`, {}));
  const res = await send(s, "POST", `/api/projects/${id}/share/confirm`, { previewId: p.previewId, contentHash: p.contentHash });
  expect(res.status).toBe(201);
  return { projectId: id, record: (await res.json()) as ShareSnapshotRecord, html: p.html };
}

async function createLink(s: RunningServer, shareId: string, body: unknown = { address: "127.0.0.1", ttlMinutes: 60 }) {
  return send(s, "POST", `/api/share/snapshots/${shareId}/links`, body);
}

/** A raw request, so the Host header is exactly what the test says (fetch will not send a forged one). */
function raw(port: number, method: string, path: string, host: string, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method, headers: { host, connection: "close", ...(token && { authorization: `Bearer ${token}` }) } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("share link API", { timeout: 30_000 }, () => {
  it("offers this computer first, and only IPv4 addresses", async () => {
    const { s } = await start();
    const res = await send(s, "GET", "/api/share/addresses");
    expect(res.status).toBe(200);
    const addresses = (await res.json()) as { address: string; scope: string; label: string }[];
    expect(addresses[0]).toEqual({ address: "127.0.0.1", scope: "this_computer", label: "This computer only" });
    for (const a of addresses.slice(1)) {
      expect(a.address).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
      expect(a).toEqual({ address: a.address, scope: "local_network", label: `Local network (${a.address})` });
    }
  });

  it("creates a link that serves the page without a session, counts it live, lists it without the token, and revokes it", async () => {
    const { s } = await start();
    const { projectId, record, html } = await confirmedSnapshot(s);
    expect(await status(s)).toBe(0);

    let res = await createLink(s, record.id);
    expect(res.status).toBe(201);
    const { link, url } = (await res.json()) as { link: ShareLink; url: string };
    expect(Object.keys(link).sort()).toEqual(["createdAt", "endedAt", "expiresAt", "id", "port", "projectId", "scope", "shareId", "state"]);
    expect(link).toMatchObject({ shareId: record.id, projectId, scope: "this_computer", state: "active", endedAt: null });
    const token = new URL(url).pathname.slice(1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new URL(url).host).toBe(`127.0.0.1:${link.port}`);

    const page = await fetch(url); // no cookie, no bearer
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(html);
    expect(await status(s)).toBe(1);

    const all = await links(s);
    expect(all).toEqual([link]);
    expect(await links(s, `?projectId=${projectId}`)).toEqual([link]);
    expect(await links(s, "?projectId=other")).toEqual([]);
    expect(JSON.stringify(all)).not.toContain(token);
    expect(JSON.stringify(await json(send(s, "GET", "/api/ledger")))).not.toContain(token);

    res = await createLink(s, record.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "share_link_active" });

    res = await send(s, "DELETE", `/api/share/links/${link.id}`);
    expect(res.status).toBe(204);
    expect(await status(s)).toBe(0);
    await expect(fetch(url).then((r) => r.status)).rejects.toThrow();
    expect((await links(s))[0]!.state).toBe("revoked");
    expect((await shareEntries(s)).at(-1)!.payload).toEqual({ linkId: link.id, reason: "owner" });

    res = await send(s, "DELETE", `/api/share/links/${link.id}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "link_not_active" });
    expect((await send(s, "DELETE", "/api/share/links/nope")).status).toBe(409);
  });

  it("refuses an address it does not offer, a bad duration or body, an unknown snapshot and a tampered file, opening nothing", async () => {
    const { s, dataDir } = await start();
    const { projectId, record } = await confirmedSnapshot(s);
    const refusals: [unknown, number, unknown][] = [
      [{ address: "0.0.0.0", ttlMinutes: 60 }, 400, { error: "invalid_input" }],
      [{ address: "192.0.2.1", ttlMinutes: 60 }, 400, { error: "invalid_input" }],
      [{ address: "127.0.0.1", ttlMinutes: 5 }, 400, undefined],
      [{ address: "127.0.0.1" }, 400, undefined],
      [{ address: "127.0.0.1", ttlMinutes: 60, port: 80 }, 400, undefined],
      [null, 400, undefined],
    ];
    for (const [body, code, error] of refusals) {
      const res = await createLink(s, record.id, body);
      expect(res.status, JSON.stringify(body)).toBe(code);
      if (error) expect(await res.json()).toEqual(error);
    }
    expect((await send(s, "POST", `/api/share/snapshots/${record.id}/links`)).status).toBe(400); // no body at all
    expect((await createLink(s, "nope")).status).toBe(404);

    appendFileSync(join(dataDir, "projects", projectId, "share", `${record.id}.html`), "<!-- -->");
    const res = await createLink(s, record.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "snapshot_tampered" });

    expect(await status(s)).toBe(0);
    expect(await links(s)).toEqual([]);
    expect(await shareEntries(s)).toEqual([]);
    expect((await send(s, "GET", "/api/share/links?projectId=")).status).toBe(400);
    expect((await send(s, "GET", "/api/share/links?state=active")).status).toBe(400);
  });

  it("every link route is the Owner's: a session and the app's host are required", async () => {
    const { s } = await start();
    const { record } = await confirmedSnapshot(s);
    const { link } = await json<{ link: ShareLink }>(createLink(s, record.id));
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/share/addresses"],
      ["POST", `/api/share/snapshots/${record.id}/links`, { address: "127.0.0.1", ttlMinutes: 60 }],
      ["GET", "/api/share/links"],
      ["DELETE", `/api/share/links/${link.id}`],
    ];
    for (const [method, path, body] of routes) {
      const res = await send(s, method, path, body, false);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await raw(s.port, method, path, "evil.test", s.token), `${method} ${path} with a foreign host`).toBe(403);
    }
    expect(await status(s)).toBe(1);
    expect((await links(s))[0]!.state).toBe("active");
  });

  it("closes cleanly with a live link, which the next start finds stopped for shutdown", async () => {
    const { s, dataDir } = await start();
    const { record } = await confirmedSnapshot(s);
    const { link, url } = await json<{ link: ShareLink; url: string }>(createLink(s, record.id));
    expect((await fetch(url)).status).toBe(200);
    await stop(s);
    await expect(fetch(url).then((r) => r.status)).rejects.toThrow();

    const { s: b } = await start(dataDir);
    expect(await status(b)).toBe(0);
    expect(await links(b)).toEqual([expect.objectContaining({ id: link.id, state: "stopped" })]);
    expect((await shareEntries(b)).at(-1)).toMatchObject({ type: "share.stopped", payload: { linkId: link.id, reason: "shutdown" } });
  });

  it("on start, records a link the last process left active as stopped for restart, and serves nothing", async () => {
    const { s, dataDir } = await start();
    const { projectId, record } = await confirmedSnapshot(s);
    await stop(s);
    // The last process died with a link live: its share.link_created has no end.
    const db = openDatabase(join(dataDir, "ledger.db"));
    commitEvent(db, new Ledger(db), () => ({
      event: {
        projectId, actor: { kind: "human", id: "owner" }, type: "share.link_created",
        payload: { linkId: "crashed", shareId: record.id, tokenDigest: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z", port: 4400, scope: "this_computer" },
      },
      result: () => undefined,
    }));
    db.close();

    const { s: b } = await start(dataDir);
    expect(await status(b)).toBe(0);
    expect(await links(b)).toEqual([expect.objectContaining({ id: "crashed", state: "stopped" })]);
    expect((await shareEntries(b)).at(-1)).toMatchObject({ type: "share.stopped", payload: { linkId: "crashed", reason: "restart" } });
    // The project is free for a new link.
    expect((await createLink(b, record.id)).status).toBe(201);
  });

  it("after a read-only restart, a link the ledger still calls active is not listed live, counted, revocable or replaced", async () => {
    const { s, dataDir } = await start();
    const { record } = await confirmedSnapshot(s);
    const { link } = await json<{ link: ShareLink }>(createLink(s, record.id));
    await stop(s); // records share.stopped { reason: "shutdown" }
    // Break the chain at that last entry: the projections are rebuilt before it, so the link reads active again.
    const db = new Database(join(dataDir, "ledger.db"));
    db.exec("DROP TRIGGER IF EXISTS ledger_no_update; DROP TRIGGER IF EXISTS ledger_no_delete;");
    const last = db.prepare("SELECT seq FROM ledger ORDER BY seq DESC LIMIT 1").get() as { seq: number };
    db.prepare("UPDATE ledger SET payload = ? WHERE seq = ?").run(JSON.stringify({ linkId: link.id, reason: "restart" }), last.seq);
    const row = db.prepare("SELECT state FROM share_links WHERE id = ?").get(link.id) as { state: string };
    db.close();
    expect(row.state).toBe("stopped");

    const { s: b, dataDir: same } = await start(dataDir);
    expect(same).toBe(dataDir);
    expect(b.integrity.ok).toBe(false);
    const check = new Database(join(dataDir, "ledger.db"), { readonly: true });
    expect((check.prepare("SELECT state FROM share_links WHERE id = ?").get(link.id) as { state: string }).state).toBe("active");
    check.close();

    expect(await status(b)).toBe(0);
    expect(await links(b)).toEqual([{ ...link, state: "stopped" }]);
    let res = await send(b, "DELETE", `/api/share/links/${link.id}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "link_not_active" });
    res = await createLink(b, record.id);
    expect(res.status).toBe(423);
    expect(await res.json()).toEqual({ error: "ledger_read_only" });
    expect(await status(b)).toBe(0);
  });
});
