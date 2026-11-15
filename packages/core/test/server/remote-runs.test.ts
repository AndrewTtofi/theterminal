import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  LINKING_ACK, type AgentRun, type Connection, type LedgerEntry, type Machine, type PendingAgentAction, type RunChanges,
} from "@theterminal/shared";
import type { FakeStep } from "../../src/agents/fake-adapter.js";
import { fakeDiscovery } from "../../src/link/discovery.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { createServer, type RunningServer } from "../../src/server/server.js";
import { holdPort } from "../link/helpers.js";

/**
 * A remote run between two workspace servers in this process, each with its own data folder, memory secrets and the
 * in-process discovery, linked over 127.0.0.1 on ephemeral ports: the requester sends the project and the prompt,
 * follows the worker's signed entries, decides through the worker, and imports the changes when the run is over.
 */

const ENV_KEYS = ["THETERMINAL_FAKE_AGENT", "THETERMINAL_FAKE_SCRIPT"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const NO_BUNDLED = { claude: () => null, codex: () => null, gemini: () => null };
// Every run makes git worktrees and bundles on both sides; git on Windows CI is slow.
const T = 180_000;
const WAIT = { timeout: 60_000, interval: 100 };

// A shell step that asks and, once allowed, writes notes.txt into the working copy; then a closing message.
const script: FakeStep[] = [
  {
    propose: { tool: "Bash", kind: "shell", summary: "Run: nvidia-smi", input: { command: "nvidia-smi" }, paths: [] },
    result: { ok: true, output: "(fake) one GPU" },
    write: { path: "notes.txt", content: "written on the worker\n" },
  },
  { message: "I wrote notes.txt." },
];

type Side = { server: RunningServer; dataDir: string; secrets: MemorySecretStore; linkPort: number };
const sides: Side[] = [];
const dirs: string[] = [];

async function start(o: { dataDir?: string; secrets?: MemorySecretStore; linkPort?: number } = {}): Promise<Side> {
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), "tt-remote-"));
  if (!o.dataDir) dirs.push(dataDir);
  const secrets = o.secrets ?? new MemorySecretStore();
  let linkPort = o.linkPort;
  if (linkPort === undefined) {
    const held = await holdPort();
    linkPort = held.port;
    await held.release();
  }
  const server = await createServer({
    dataDir, port: 0, which: () => null, bundled: NO_BUNDLED, secrets, discovery: fakeDiscovery(),
    linkBind: "127.0.0.1", linkPort, remoteRuns: { backoffMs: [100, 200, 400] },
  });
  const side = { server, dataDir, secrets, linkPort };
  sides.push(side);
  return side;
}

const send = (s: Side, method: string, path: string, body?: unknown, o: { authed?: boolean } = {}) =>
  fetch(`http://127.0.0.1:${s.server.port}${path}`, {
    method,
    headers: {
      ...(o.authed !== false && { authorization: `Bearer ${s.server.token}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => {
  const r = await res;
  expect(r.status, `${r.url} answered ${r.status}`).toBeLessThan(400);
  return r.json() as Promise<T>;
};
const ledger = (s: Side) => json<LedgerEntry[]>(send(s, "GET", "/api/ledger?limit=500"));
const ofType = async (s: Side, type: string) => (await ledger(s)).filter((e) => e.type === type);
const origins = (entries: LedgerEntry[], runId: string) =>
  entries
    .filter((e) => e.type === "link.mirrored")
    .map((e) => (e.payload as { origin: LedgerEntry }).origin)
    .filter((o) => (o.payload as { runId?: string }).runId === runId);

let worker: Side;
let requester: Side;
let workerId: string;
let projectId: string;

/** Starts a remote fake run of the project on the worker; answers the provisional run. */
const startRemote = (body: Record<string, unknown> = {}) =>
  send(requester, "POST", `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "Check the GPU", machineId: workerId, ...body });

/** The requester's pending action of the run, once its mirrored request has arrived. */
async function pendingOf(runId: string, on: Side = requester): Promise<PendingAgentAction> {
  let found: PendingAgentAction | undefined;
  await vi.waitFor(async () => {
    found = (await json<PendingAgentAction[]>(send(on, "GET", "/api/pending-actions"))).find((a) => a.runId === runId);
    expect(found).toBeDefined();
  }, WAIT);
  return found!;
}

/** Waits until the run's changes were imported on `on`, and answers the entry. */
async function imported(runId: string, on: Side = requester): Promise<LedgerEntry> {
  let entry: LedgerEntry | undefined;
  await vi.waitFor(async () => {
    entry = (await ofType(on, "link.changes_imported")).find((e) => (e.payload as { runId: string }).runId === runId);
    expect(entry).toBeDefined();
  }, WAIT);
  return entry!;
}

beforeAll(async () => {
  process.env.THETERMINAL_FAKE_AGENT = "1";
  process.env.THETERMINAL_FAKE_SCRIPT = JSON.stringify(script);
  worker = await start();
  requester = await start();
  await json(send(worker, "POST", "/api/link/name", { name: "GPU box" }));
  const self = await json<{ machineId: string; linking: { port: number } }>(send(worker, "POST", "/api/link/enable", { acknowledgement: LINKING_ACK }));
  workerId = self.machineId;
  await json(send(requester, "POST", "/api/link/enable", { acknowledgement: LINKING_ACK }));
  const { code } = await json<{ code: string }>(send(worker, "POST", "/api/link/code"));
  const paired = await json<Machine>(send(requester, "POST", "/api/link/pair", { address: `127.0.0.1:${self.linking.port}`, code }));
  expect(paired).toMatchObject({ id: workerId, name: "GPU box" });
  projectId = (await json<{ id: string }>(send(requester, "POST", "/api/projects", { name: "Demo", pitch: "x" }))).id;
}, T);

afterAll(async () => {
  while (sides.length) await sides.pop()!.server.close().catch(() => undefined);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

describe("a remote run between two servers", { timeout: T }, () => {
  it("start, a decision sent to the worker, the stream, the finish and the import of the changes", async () => {
    const res = await startRemote();
    expect(res.status).toBe(201);
    const run = (await res.json()) as AgentRun;
    expect(run).toMatchObject({ projectId, adapter: "fake", status: "running", machineId: workerId });

    expect((await ofType(requester, "link.run_requested")).map((e) => (e.payload as { runId: string }).runId)).toContain(run.id);
    const action = await pendingOf(run.id);
    expect(action).toMatchObject({ projectName: "Demo", kind: "shell", status: "pending", machineName: "GPU box" });
    const types = origins(await ledger(requester), run.id).map((o) => o.type);
    expect(types.slice(0, 2)).toEqual(["agent.started", "agent.action.requested"]);
    expect((await json<{ run: AgentRun }>(send(requester, "GET", `/api/runs/${run.id}`))).run.machineId).toBe(workerId);

    const decided = await send(requester, "POST", `/api/actions/${action.id}/decision`, { decision: "allow" });
    expect(decided.status).toBe(200);

    const done = await imported(run.id);
    expect((done.payload as { commit: string }).commit).toMatch(/^[0-9a-f]{40}$/);
    const received = (await ofType(worker, "link.decision_received")).map((e) => e.payload);
    expect(received).toContainEqual(expect.objectContaining({ runId: run.id, actionId: action.id, decision: "allow" }));
    const mirrored = origins(await ledger(requester), run.id);
    expect(mirrored.map((o) => o.type)).toEqual(expect.arrayContaining(["agent.action.decided", "agent.action.completed", "agent.finished"]));
    expect(new Set(mirrored.map((o) => o.id)).size).toBe(mirrored.length);

    const finished = (await json<{ run: AgentRun }>(send(requester, "GET", `/api/runs/${run.id}`))).run;
    expect(finished).toMatchObject({ status: "completed", machineId: workerId });
    expect(readFileSync(join(requester.dataDir, finished.worktree, "notes.txt"), "utf8")).toBe("written on the worker\n");
    const changes = await json<RunChanges>(send(requester, "GET", `/api/runs/${run.id}/changes`));
    expect(changes.files.map((f) => f.path)).toContain("notes.txt");
    // Nothing is merged: the project's own branch is untouched by the import.
    expect(existsSync(join(requester.dataDir, "projects", projectId, "repo", "notes.txt"))).toBe(false);
    for (const dir of ["outgoing", "incoming"]) {
      const d = join(requester.dataDir, "link", dir);
      expect((existsSync(d) ? readdirSync(d) : []).filter((f) => f.endsWith(".bundle"))).toEqual([]);
    }

    const verify = await json<{ ok: boolean; checked: number; badSeqs: number[] }>(send(requester, "GET", "/api/link/verify"));
    expect(verify).toEqual({ ok: true, checked: (await ofType(requester, "link.mirrored")).length, badSeqs: [] });
    expect(verify.checked).toBeGreaterThanOrEqual(5);
  });

  it("the worker's listener goes away while an action waits: the decision is 502 and records nothing; the run resumes when it is back", async () => {
    const run = await json<AgentRun>(startRemote());
    const action = await pendingOf(run.id);
    await json(send(worker, "POST", "/api/link/disable"));
    const head = (await ledger(requester)).length;
    const refused = await send(requester, "POST", `/api/actions/${action.id}/decision`, { decision: "allow" });
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: "machine_unreachable" });
    expect((await ledger(requester)).length).toBe(head);
    expect((await pendingOf(run.id)).id).toBe(action.id);
    const overview = await json<{ machines: Array<{ id: string; online: boolean | null }> }>(send(requester, "GET", "/api/link"));
    expect(overview.machines.find((m) => m.id === workerId)!.online).toBe(false);

    await json(send(worker, "POST", "/api/link/enable", { acknowledgement: LINKING_ACK })); // the same port again
    await vi.waitFor(async () => {
      expect((await send(requester, "POST", `/api/actions/${action.id}/decision`, { decision: "allow" })).status).toBe(200);
    }, WAIT);
    await imported(run.id);
    const mirrored = origins(await ledger(requester), run.id);
    expect(new Set(mirrored.map((o) => o.id)).size).toBe(mirrored.length);
  });

  it("the requester restarts with a run in flight: the new server resumes it, and every worker entry is mirrored exactly once", async () => {
    const run = await json<AgentRun>(startRemote());
    await pendingOf(run.id);
    const { dataDir, secrets, linkPort } = requester;
    sides.splice(sides.indexOf(requester), 1);
    await requester.server.close();
    requester = await start({ dataDir, secrets, linkPort });

    expect((await json<{ run: AgentRun }>(send(requester, "GET", `/api/runs/${run.id}`))).run.status).toBe("running");
    const action = await pendingOf(run.id);
    expect((await send(requester, "POST", `/api/actions/${action.id}/decision`, { decision: "allow" })).status).toBe(200);
    await imported(run.id);
    const mirrored = origins(await ledger(requester), run.id);
    const workerEntries = (await ledger(worker)).filter(
      (e) => (e.payload as { runId?: string }).runId === run.id && (e.type.startsWith("agent.") || e.type === "connection.used"),
    );
    expect(mirrored.map((o) => o.id).sort()).toEqual(workerEntries.map((e) => e.id).sort());
  });

  it("an unreachable machine: 502 machine_unreachable, link.run_failed recorded, no bundle left and no run", async () => {
    const runsBefore = (await json<AgentRun[]>(send(requester, "GET", `/api/projects/${projectId}/runs`))).length;
    await json(send(worker, "POST", "/api/link/disable"));
    try {
      const res = await startRemote();
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "machine_unreachable" });
    } finally {
      await json(send(worker, "POST", "/api/link/enable", { acknowledgement: LINKING_ACK }));
    }
    const failed = (await ofType(requester, "link.run_failed")).at(-1)!;
    expect(failed.payload).toMatchObject({ machineId: workerId, error: "unreachable" });
    expect(readdirSync(join(requester.dataDir, "link", "outgoing"))).toEqual([]);
    expect(await json<AgentRun[]>(send(requester, "GET", `/api/projects/${projectId}/runs`))).toHaveLength(runsBefore);
  });

  it("the worker refusing a disabled connection: 400 remote_refused with its code and the machine's name, and link.run_failed", async () => {
    const conn = await json<Connection>(send(worker, "POST", "/api/connections", {
      kind: "mcp", provider: "mcp_http", name: "Docs", config: { url: "http://127.0.0.1:9/mcp" },
    }));
    await json(send(worker, "PATCH", `/api/connections/${conn.id}`, { enabled: false }));
    const res = await startRemote({ connectionIds: [conn.id] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "remote_refused", code: "connection_disabled", machine: "GPU box" });
    expect((await ofType(requester, "link.run_failed")).at(-1)!.payload).toMatchObject({ machineId: workerId, error: "connection_disabled" });
  });

  it("verify counts an unpaired machine's entries as bad: its key is gone", async () => {
    const before = await json<{ ok: boolean; checked: number; badSeqs: number[] }>(send(requester, "GET", "/api/link/verify"));
    expect(before.ok).toBe(true);
    expect((await send(requester, "DELETE", `/api/link/machines/${workerId}`)).status).toBe(204);
    const after = await json<{ ok: boolean; checked: number; badSeqs: number[] }>(send(requester, "GET", "/api/link/verify"));
    expect(after).toMatchObject({ ok: false, checked: before.checked });
    expect(after.badSeqs).toHaveLength(before.checked);
  });
});
