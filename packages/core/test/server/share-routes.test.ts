import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SHARE_OPTIONS, SHARE_SECTIONS, type DailyDigest, type ShareSnapshot, type ShareSnapshotRecord } from "@theterminal/shared";
import { SHARE_HEADER_CSP } from "../../src/share/render.js";
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
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "tt-share-routes-"));
  if (!dataDir) dirs.push(dir);
  const s = await createServer({ dataDir: dir, port: 0, which: () => null, bundled: NO_BUNDLED, secrets: new MemorySecretStore() });
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

type PreviewBody = { previewId: string; contentHash: string; bytes: number; expiresAt: string; html: string; snapshot: ShareSnapshot };

async function project(s: RunningServer) {
  const { id } = await json<{ id: string }>(send(s, "POST", "/api/projects", { name: "Book Club", pitch: "Reading lists for a club" }));
  await send(s, "POST", `/api/projects/${id}/cards`, { title: "Login", stage: "plan" });
  return id;
}

async function confirmed(s: RunningServer, id: string) {
  const p = await json<PreviewBody>(send(s, "POST", `/api/projects/${id}/share/preview`, {}));
  const res = await send(s, "POST", `/api/projects/${id}/share/confirm`, { previewId: p.previewId, contentHash: p.contentHash });
  expect(res.status).toBe(201);
  return { p, record: (await res.json()) as ShareSnapshotRecord };
}

describe("share API", { timeout: 30_000 }, () => {
  it("previews with the default options, confirms, lists, serves and downloads the saved page", async () => {
    const { s } = await start();
    const id = await project(s);

    let res = await send(s, "POST", `/api/projects/${id}/share/preview`, {});
    expect(res.status).toBe(200);
    const p = (await res.json()) as PreviewBody;
    expect(Object.keys(p).sort()).toEqual(["bytes", "contentHash", "expiresAt", "html", "previewId", "snapshot"]);
    expect(p.contentHash).toBe(createHash("sha256").update(p.html).digest("hex"));
    expect(p.bytes).toBe(Buffer.byteLength(p.html));
    expect(p.snapshot.options).toEqual(DEFAULT_SHARE_OPTIONS);
    expect(p.snapshot.project.name).toBe("Book Club");

    res = await send(s, "POST", `/api/projects/${id}/share/preview`, { includePrompts: true, digestDays: 14 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as PreviewBody).snapshot.options).toEqual({ includePrompts: true, includeHardware: false, digestDays: 14 });

    expect(await json(send(s, "GET", `/api/projects/${id}/share/snapshots`))).toEqual([]);
    res = await send(s, "POST", `/api/projects/${id}/share/confirm`, { previewId: p.previewId, contentHash: p.contentHash });
    expect(res.status).toBe(201);
    const record = (await res.json()) as ShareSnapshotRecord;
    expect(record).toMatchObject({ id: p.previewId, projectId: id, contentHash: p.contentHash, bytes: p.bytes, sections: [...SHARE_SECTIONS] });
    expect(await json(send(s, "GET", `/api/projects/${id}/share/snapshots`))).toEqual([record]);

    res = await send(s, "GET", `/api/share/snapshots/${record.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(SHARE_HEADER_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await res.text()).toBe(p.html);

    res = await send(s, "GET", `/api/share/snapshots/${record.id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="theterminal-share-${record.id.slice(0, 8)}.html"`);
    expect(res.headers.get("content-security-policy")).toBe(SHARE_HEADER_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(p.html);

    // The UI's status bar reads the live link count; nothing is served yet.
    expect((await json<{ shareLinks: number }>(send(s, "GET", "/api/status"))).shareLinks).toBe(0);
  });

  it("refuses bad options, a wrong hash, an unknown preview, unknown snapshots and projects", async () => {
    const { s } = await start();
    const id = await project(s);

    let res = await send(s, "POST", `/api/projects/${id}/share/preview`, { digestDays: 9 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_input");
    res = await send(s, "POST", `/api/projects/${id}/share/preview`, { extra: true });
    expect(res.status).toBe(400);
    expect((await send(s, "POST", "/api/projects/nope/share/preview", {})).status).toBe(404);

    const p = await json<PreviewBody>(send(s, "POST", `/api/projects/${id}/share/preview`, {}));
    res = await send(s, "POST", `/api/projects/${id}/share/confirm`, { previewId: p.previewId, contentHash: "0".repeat(64) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "preview_stale" });
    res = await send(s, "POST", `/api/projects/${id}/share/confirm`, { previewId: "nope", contentHash: p.contentHash });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "preview_not_found" });
    res = await send(s, "POST", `/api/projects/${id}/share/confirm`, { previewId: p.previewId });
    expect(res.status).toBe(400);
    expect(await json(send(s, "GET", `/api/projects/${id}/share/snapshots`))).toEqual([]);

    res = await send(s, "GET", "/api/share/snapshots/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect((await send(s, "GET", "/api/share/snapshots/nope/download")).status).toBe(404);
  });

  it("refuses to serve a tampered or missing file", async () => {
    const { s, dataDir } = await start();
    const id = await project(s);
    const { record } = await confirmed(s, id);
    const file = join(dataDir, "projects", id, "share", `${record.id}.html`);

    appendFileSync(file, "<!-- -->");
    let res = await send(s, "GET", `/api/share/snapshots/${record.id}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "snapshot_tampered" });
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect((await send(s, "GET", `/api/share/snapshots/${record.id}/download`)).status).toBe(409);

    rmSync(file);
    res = await send(s, "GET", `/api/share/snapshots/${record.id}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "snapshot_missing" });
  });

  it("serves daily digests for 7, 14 or 30 days", async () => {
    const { s } = await start();
    const id = await project(s);
    let res = await send(s, "GET", `/api/projects/${id}/digests`);
    expect(res.status).toBe(200);
    const week = (await res.json()) as DailyDigest[];
    expect(week).toHaveLength(1);
    expect(week[0]!.counts.entries).toBe(2);
    res = await send(s, "GET", `/api/projects/${id}/digests?days=14`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(week);
    expect((await send(s, "GET", `/api/projects/${id}/digests?days=9`)).status).toBe(400);
    expect((await send(s, "GET", "/api/projects/nope/digests")).status).toBe(404);
  });

  it("on a read-only ledger, previews but refuses to confirm", async () => {
    const { s, dataDir } = await start();
    const id = await project(s);
    await stop(s);
    const db = new Database(join(dataDir, "ledger.db"));
    db.exec("DROP TRIGGER IF EXISTS ledger_no_update; DROP TRIGGER IF EXISTS ledger_no_delete;");
    db.prepare("UPDATE ledger SET payload = ? WHERE seq = 2").run(JSON.stringify({ cardId: "evil", title: "Evil", stage: "ship" }));
    db.close();

    const { s: b } = await start(dataDir);
    expect(b.integrity.ok).toBe(false);
    let res = await send(b, "POST", `/api/projects/${id}/share/preview`, {});
    expect(res.status).toBe(200);
    const p = (await res.json()) as PreviewBody;
    expect(p.snapshot.audit.ok).toBe(false);
    res = await send(b, "POST", `/api/projects/${id}/share/confirm`, { previewId: p.previewId, contentHash: p.contentHash });
    expect(res.status).toBe(423);
    expect(await res.json()).toEqual({ error: "ledger_read_only" });
  });

  it("every share route needs auth", async () => {
    const { s } = await start();
    const id = await project(s);
    const { record } = await confirmed(s, id);
    const routes: [string, string, unknown?][] = [
      ["POST", `/api/projects/${id}/share/preview`, {}],
      ["POST", `/api/projects/${id}/share/confirm`, { previewId: record.id, contentHash: record.contentHash }],
      ["GET", `/api/projects/${id}/share/snapshots`],
      ["GET", `/api/share/snapshots/${record.id}`],
      ["GET", `/api/share/snapshots/${record.id}/download`],
      ["GET", `/api/projects/${id}/digests?days=7`],
    ];
    for (const [method, path, body] of routes) {
      const res = await send(s, method, path, body, false);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await res.text()).not.toContain("<html");
    }
  });
});
