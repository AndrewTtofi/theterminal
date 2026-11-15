import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import type { AgentRun, LedgerEntry } from "@theterminal/shared";
import { openDatabase } from "../../src/db.js";
import { commitEvent } from "../../src/events/commit.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { TOKEN_COOKIE } from "../../src/server/auth.js";
import { createServer, type RunningServer } from "../../src/server/server.js";

const NO_BUNDLED = { claude: () => null, codex: () => null, gemini: () => null };
const KEYS = ["THETERMINAL_FAKE_AGENT", "THETERMINAL_FAKE_SCRIPT"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const running: RunningServer[] = [];
const dirs: string[] = [];
const REASON = "the agent left the build broken";
const which = (cmd: string) => (cmd === "node" ? process.execPath : null);

afterEach(async () => {
  while (running.length) await running.pop()!.close().catch(() => undefined);
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const base = (s: RunningServer) => `http://127.0.0.1:${s.port}`;
const get = (s: RunningServer, path: string) => fetch(base(s) + path, { headers: { cookie: `${TOKEN_COOKIE}=${s.token}` } });
const post = (s: RunningServer, path: string, body: unknown, auth: "bearer" | "none" = "bearer") =>
  fetch(base(s) + path, {
    method: "POST",
    headers: { ...(auth === "bearer" && { authorization: `Bearer ${s.token}` }), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const ledgerOf = async (s: RunningServer) => (await (await get(s, "/api/ledger?limit=500")).json()) as LedgerEntry[];
const ofType = (entries: LedgerEntry[], type: string) => entries.filter((e) => e.type === type);
const runStatus = async (s: RunningServer, id: string) => ((await (await get(s, `/api/runs/${id}`)).json()) as { run: AgentRun }).run.status;

/** A server with the fake adapter and one run, finished unless the script makes it wait on a decision. */
async function start(script: unknown[] = [{ message: "done" }], dataDir?: string) {
  process.env.THETERMINAL_FAKE_AGENT = "1";
  process.env.THETERMINAL_FAKE_SCRIPT = JSON.stringify(script);
  if (dataDir === undefined) {
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), "tt-override-")));
    dirs.push(dataDir);
  }
  const s = await createServer({ dataDir, port: 0, which, bundled: NO_BUNDLED, secrets: new MemorySecretStore() });
  running.push(s);
  const project = (await (await post(s, "/api/projects", { name: "P" })).json()) as { id: string };
  const run = (await (await post(s, `/api/projects/${project.id}/runs`, { adapter: "fake", prompt: "go" })).json()) as AgentRun;
  return { s, run, wt: join(dataDir, run.worktree), dataDir };
}
async function finished() {
  const r = await start();
  await vi.waitFor(async () => expect(await runStatus(r.s, r.run.id)).not.toBe("running"), { timeout: 5000 });
  return r;
}

describe("override routes", { timeout: 20000 }, () => {
  it("201 with the override id, and both entries in the ledger", async () => {
    const { s, run } = await finished();
    const res = await post(s, `/api/runs/${run.id}/override/command`, { program: "node", args: ["-e", "console.log('hi')"], reason: REASON });
    expect(res.status).toBe(201);
    const { overrideId } = (await res.json()) as { overrideId: string };
    expect(typeof overrideId).toBe("string");
    await vi.waitFor(async () => expect(ofType(await ledgerOf(s), "override.completed")).toHaveLength(1), { timeout: 10_000 });
    const entries = await ledgerOf(s);
    expect(ofType(entries, "override.command")[0]!.payload).toMatchObject({ overrideId, runId: run.id, program: "node", cwd: "." });
    expect(ofType(entries, "override.completed")[0]!.payload).toMatchObject({ overrideId, ok: true, exitCode: 0, output: "hi\n" });
  });

  it("200 with the override id and the number of uncommitted files for a discard", async () => {
    const { s, run, wt } = await finished();
    writeFileSync(join(wt, "a.txt"), "x");
    writeFileSync(join(wt, "b.txt"), "y");
    const res = await post(s, `/api/runs/${run.id}/override/discard`, { reason: REASON });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { overrideId: string; files: number };
    expect(body).toEqual({ overrideId: expect.any(String), files: 2 });
    const entries = await ledgerOf(s);
    expect(ofType(entries, "override.discard")[0]!.payload).toMatchObject({ overrideId: body.overrideId, files: 2 });
    expect(ofType(entries, "override.completed")[0]!.payload).toMatchObject({ overrideId: body.overrideId, ok: true });
  });

  it("answers each refusal with its status and code, and records nothing", async () => {
    const { s, run, wt } = await finished();
    const inside = join(wt, "tool");
    writeFileSync(inside, "#!/bin/sh\n");
    chmodSync(inside, 0o755);
    const before = (await ledgerOf(s)).length;
    const command = (body: unknown) => post(s, `/api/runs/${run.id}/override/command`, body);
    const expectError = async (res: Response, status: number, error: string) => {
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    };
    await expectError(await command({ program: "nope-not-here", reason: REASON }), 400, "program_not_found");
    await expectError(await command({ program: inside, reason: REASON }), 400, "program_not_allowed");
    await expectError(await command({ program: "node", args: ["sk-ant-TESTKEY-0000000000"], reason: REASON }), 400, "secret_in_text");
    await expectError(await command({ program: "node", reason: "short" }), 400, "invalid_input");
    await expectError(await command({ program: "node", reason: REASON, shell: true }), 400, "invalid_input");
    await expectError(await command({ program: "node", reason: REASON, cwd: "../" }), 404, "not_found");
    await expectError(await post(s, `/api/runs/${run.id}/override/discard`, { reason: "short" }), 400, "invalid_input");
    await expectError(await post(s, "/api/runs/no-such-run/override/discard", { reason: REASON }), 404, "not_found");
    expect((await ledgerOf(s)).length).toBe(before);
  });

  it("409 override_busy while another override runs, and the run still answers", async () => {
    const { s, run } = await finished();
    const first = await post(s, `/api/runs/${run.id}/override/command`, { program: "node", args: ["-e", "setInterval(()=>{},1000)"], reason: REASON });
    expect(first.status).toBe(201);
    const busy = await post(s, `/api/runs/${run.id}/override/discard`, { reason: REASON });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "override_busy" });
    const res = await get(s, `/api/runs/${run.id}`);
    expect(res.status).toBe(200);
  });

  it("409 run_active while the run waits on a decision", async () => {
    const { s, run } = await start([
      { propose: { tool: "Write", kind: "file_write", summary: "write notes", input: { path: "notes.md" }, paths: ["notes.md"] } },
    ]);
    await vi.waitFor(async () => {
      const pending = (await (await get(s, `/api/runs/${run.id}`)).json()) as { actions: { status: string }[] };
      expect(pending.actions.some((a) => a.status === "pending")).toBe(true);
    }, { timeout: 5000 });
    const res = await post(s, `/api/runs/${run.id}/override/command`, { program: "node", args: ["-e", "1"], reason: REASON });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "run_active", message: "an agent is still working in this run" });
  });

  it("401 without the cookie or token", async () => {
    const { s, run } = await finished();
    expect((await post(s, `/api/runs/${run.id}/override/command`, { program: "node", reason: REASON }, "none")).status).toBe(401);
    expect((await post(s, `/api/runs/${run.id}/override/discard`, { reason: REASON }, "none")).status).toBe(401);
  });

  it("close() kills a running override and records it; the next start closes one left without a completion", async () => {
    const { s, run, dataDir } = await finished();
    await post(s, `/api/runs/${run.id}/override/command`, { program: "node", args: ["-e", "setInterval(()=>{},1000)"], reason: REASON });
    await s.close();
    running.splice(running.indexOf(s), 1);
    let db = openDatabase(join(dataDir, "ledger.db"));
    let ledger = new Ledger(db);
    const completed = ledger.list({ limit: 1000 }).filter((e) => e.type === "override.completed");
    expect(completed.map((e) => e.payload)).toEqual([expect.objectContaining({ ok: false, signal: "SIGKILL" })]);
    // A command whose process died with the previous workspace.
    commitEvent(db, ledger, () => ({
      event: {
        projectId: run.projectId, actor: { kind: "human", id: "owner" }, type: "override.command",
        payload: { overrideId: "o-dangling", runId: run.id, program: "node", args: [], cwd: ".", reason: REASON },
      },
      result: () => undefined,
    }));
    db.close();
    await start([{ message: "done" }], dataDir);
    db = openDatabase(join(dataDir, "ledger.db"));
    ledger = new Ledger(db);
    try {
      const recovered = ledger.list({ limit: 1000 }).filter((e) => e.type === "override.completed" && (e.payload as { overrideId: string }).overrideId === "o-dangling");
      expect(recovered.map((e) => e.payload)).toEqual([expect.objectContaining({ ok: false, output: "workspace restarted" })]);
    } finally {
      db.close();
    }
  });
});
