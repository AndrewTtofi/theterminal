import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { narrate, type CardStory, type LedgerEntry } from "@theterminal/shared";
import { openDatabase } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { createServer, type RunningServer } from "../../src/server/server.js";
import { acceptMirroredLine } from "../../src/link/mirrored.js";
import { pairAndRequest, remoteRun } from "../link/remote-fixtures.js";

const NO_BUNDLED = { claude: () => null, codex: () => null, gemini: () => null };
const SECRET = "sk-ant-TESTKEY-0000000000";
const running: RunningServer[] = [];
const dirs: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  while (running.length) await running.pop()!.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const get = (s: RunningServer, path: string) =>
  fetch(`http://127.0.0.1:${s.port}${path}`, { headers: { authorization: `Bearer ${s.token}` } });
const post = async <T>(s: RunningServer, path: string, body: unknown): Promise<T> =>
  (await fetch(`http://127.0.0.1:${s.port}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })).json() as Promise<T>;

describe("a linked machine's entries leave this server through its own cleaner", { timeout: 20000 }, () => {
  it("redacts a mirrored payload in the ledger, the live stream, the story and the export, and in their narration", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tt-mirrored-"));
    dirs.push(dataDir);
    const s = await createServer({ dataDir, port: 0, which: () => null, bundled: NO_BUNDLED, secrets: new MemorySecretStore() });
    running.push(s);
    const projectId = (await post<{ id: string }>(s, "/api/projects", { name: "Book Club" })).id;
    const cardId = (await post<{ id: string }>(s, `/api/projects/${projectId}/cards`, { title: "Reading list", stage: "plan" })).id;

    // What a worker sent, committed on a second connection to the same ledger, as the remote-run service will.
    const db = openDatabase(join(dataDir, "ledger.db"));
    const ledger = new Ledger(db);
    const remote = await remoteRun("run-on-gpu-box", projectId);
    pairAndRequest(db, ledger, remote);
    // A built-in secret pattern, and this server's own session token: only this server's cleaner knows the second.
    const text = `I found ${SECRET} and ${s.token} in the config`;
    for (const e of [remote.started(cardId), remote.message(text), remote.requested("act-1", `echo ${s.token}`)]) {
      expect(acceptMirroredLine(db, ledger, remote.runId, remote.line(e)).ok).toBe(true);
    }
    expect(JSON.stringify(ledger.list())).toContain("TESTKEY"); // the stored entry is what the worker signed
    db.close();

    const leaks = (v: unknown) => {
      const t = JSON.stringify(v);
      return t.includes("TESTKEY") || t.includes(s.token);
    };
    const said = (entries: LedgerEntry[]) =>
      entries.filter((e) => e.type === "link.mirrored").map((e) => narrate(e)).map((n) => [n.headline, n.detail]);

    const listed = (await (await get(s, "/api/ledger")).json()) as LedgerEntry[];
    expect(listed.filter((e) => e.type === "link.mirrored")).toHaveLength(3);
    expect(leaks(listed)).toBe(false);
    expect(leaks(said(listed))).toBe(false);
    expect(said(listed)[1]![0]).toContain("[REDACTED]");

    const story = (await (await get(s, `/api/cards/${cardId}/story`)).json()) as CardStory;
    expect(story.entries.filter((e) => e.type === "link.mirrored")).toHaveLength(3);
    expect(leaks(story)).toBe(false);
    expect(leaks(said(story.entries))).toBe(false);

    const exported = await (await get(s, `/api/ledger/export?projectId=${projectId}`)).text();
    expect(exported).toContain("link.mirrored");
    expect(exported.includes("TESTKEY") || exported.includes(s.token)).toBe(false);

    // The run and its actions, as Needs-you, the run list and the run view show them.
    const pending = await (await get(s, "/api/pending-actions")).json();
    expect(pending).toEqual([expect.objectContaining({ id: "act-1", runId: remote.runId, summary: "Run: echo [REDACTED]" })]);
    for (const path of [`/api/projects/${projectId}/pending-actions`, `/api/projects/${projectId}/runs`, `/api/runs/${remote.runId}`]) {
      const body = await (await get(s, path)).json();
      expect(JSON.stringify(body)).toContain(remote.runId);
      expect(leaks(body)).toBe(false);
    }

    // Stopping or deciding for it here is refused: it runs on the other machine.
    const head = (await (await get(s, "/api/ledger?limit=500")).json() as LedgerEntry[]).at(-1)!.seq;
    const stop = await fetch(`http://127.0.0.1:${s.port}/api/runs/${remote.runId}/stop`, {
      method: "POST", headers: { authorization: `Bearer ${s.token}` },
    });
    expect(stop.status).toBe(409);
    expect(await stop.json()).toMatchObject({ error: "remote_run" });
    const decision = await fetch(`http://127.0.0.1:${s.port}/api/actions/act-1/decision`, {
      method: "POST", headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow", reason: "" }),
    });
    expect(decision.status).toBe(409);
    expect(await decision.json()).toMatchObject({ error: "remote_run" });
    expect((await (await get(s, "/api/ledger?limit=500")).json() as LedgerEntry[]).at(-1)!.seq).toBe(head);

    const messages: LedgerEntry[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/events?afterSeq=0`, { headers: { authorization: `Bearer ${s.token}` } });
    sockets.push(ws);
    ws.on("message", (d) => messages.push(JSON.parse(String(d)) as LedgerEntry));
    await vi.waitFor(() => expect(messages.filter((e) => e.type === "link.mirrored")).toHaveLength(3), { timeout: 5000 });
    expect(leaks(messages)).toBe(false);
  });
});
