import https from "node:https";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LINKING_ACK, mirrorFrameSchema, type AgentAction, type AgentRun, type LedgerEntry } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { commitEvent } from "../../src/events/commit.js";
import { getLinkRun, getRun, getSetting, listPendingActions } from "../../src/events/projections.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { WorktreeManager } from "../../src/agents/worktrees.js";
import { ApprovalBroker } from "../../src/agents/approvals.js";
import { AgentRunner } from "../../src/agents/runner.js";
import { FakeAdapter, type FakeStep } from "../../src/agents/fake-adapter.js";
import { ConnectionService } from "../../src/connections/service.js";
import { LinkListener } from "../../src/link/listener.js";
import { LinkClient, MachineUnreachableError, RemoteRefusedError, type Peer } from "../../src/link/client.js";
import { LinkService } from "../../src/link/service.js";
import { fakeDiscovery } from "../../src/link/discovery.js";
import { registerLinkProtocolRoutes } from "../../src/link/protocol-routes.js";
import { LinkWorker } from "../../src/link/worker.js";
import { MAX_BUNDLE_BYTES, exportRepoBundle, importSnapshot } from "../../src/link/bundles.js";
import { verifyFrame, type MirrorFrame } from "../../src/link/mirror.js";
import type { LinkIdentity } from "../../src/link/identity.js";
import { newIdentity, rawTlsGet } from "./helpers.js";

// Every run makes a git worktree, and git on Windows CI is slow.
const T = 120_000;
const owner = { kind: "human", id: "owner" } as const;
const shell = { tool: "Bash", kind: "shell" as const, summary: "run the tests", input: { command: "npm test" }, paths: [] };

type Worker = {
  dataDir: string; db: Db; ledger: Ledger; runner: AgentRunner; link: LinkService; worker: LinkWorker; peer: Peer; worktrees: WorktreeManager;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

let scratch: string;
let requester: LinkIdentity;
let reqData: string;
let reqWt: WorktreeManager;
beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "proto-scratch-")));
  reqData = realpathSync(mkdtempSync(join(tmpdir(), "proto-req-")));
  reqWt = new WorktreeManager(reqData);
  requester = await newIdentity();
  cleanups.push(() => {
    for (const d of [scratch, reqData]) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  });
});

/** The worker machine: linking on (loopback, any port), the requester paired, the fake agent running `script`. */
async function startWorker(script: FakeStep[], o: { heartbeatMs?: number; now?: () => number } = {}): Promise<Worker> {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "proto-worker-")));
  const db = openDatabase(":memory:");
  const ledger = new Ledger(db);
  const worktrees = new WorktreeManager(dataDir);
  const secrets = new MemorySecretStore();
  const connections = new ConnectionService({ db, ledger, secrets, testers: {} });
  await connections.load();
  const runner = new AgentRunner({
    db, ledger, worktrees, broker: new ApprovalBroker(), adapters: { fake: new FakeAdapter(script) }, extraSecrets: () => [],
    dataDir, username: "alice", selectConnections: (ids) => connections.selectForRun(ids),
  });
  const holder: { worker?: LinkWorker } = {};
  const link: LinkService = new LinkService({
    db,
    ledger,
    secrets,
    listener: (deps) => new LinkListener(deps),
    client: (identity, timeoutMs) => new LinkClient({ identity, ...(timeoutMs !== undefined && { timeoutMs }) }),
    registerProtocol: (app) => registerLinkProtocolRoutes(app, { link, worker: holder.worker! }),
    discovery: fakeDiscovery(),
    bind: "127.0.0.1",
  });
  const worker = new LinkWorker({
    link, db, ledger, runner, worktrees, dataDir,
    changes: { db, dataDir, worktrees, clean: (id, s, max) => runner.cleanFor(id)(s, max), settling: (id) => runner.settling(id) },
    ...(o.heartbeatMs !== undefined && { heartbeatMs: o.heartbeatMs }),
    ...(o.now !== undefined && { now: o.now }),
    cleanText: (t) => connections.publicText(t),
  });
  holder.worker = worker;
  await link.load();
  const port = await link.enableLinking(owner, LINKING_ACK, 0);
  commitEvent(db, ledger, () => ({
    event: {
      projectId: null, actor: owner, type: "machine.paired",
      payload: {
        machineId: requester.machineId, name: "Laptop", publicKey: requester.publicKeyBase64, fingerprint: requester.fingerprint,
        address: "127.0.0.1:1", role: "showed_code",
      },
    },
    result: () => undefined,
  }));
  cleanups.push(async () => {
    await runner.shutdown();
    await link.shutdown();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });
  const peer: Peer = {
    machineId: link.self()!.machineId,
    address: `127.0.0.1:${port}`,
    publicKeyDer: Buffer.from(getSetting(db, "link.publicKey")!, "base64"),
  };
  return { dataDir, db, ledger, runner, link, worker, peer, worktrees };
}

const client = () => new LinkClient({ identity: requester, timeoutMs: 60_000 });

async function uploadRepo(w: Worker, runId: string): Promise<void> {
  const file = join(scratch, `${runId}.bundle`);
  await exportRepoBundle(reqWt, "p1", file);
  await client().upload(w.peer, `/link/v1/runs/${runId}/repo`, file, MAX_BUNDLE_BYTES);
}

const startBody = (over: Record<string, unknown> = {}) => ({
  v: 1, projectId: "p1", projectName: "Demo", adapter: "fake", prompt: "do the thing", cardId: null, connectionIds: [], ...over,
});

const startRun = (w: Worker, runId: string, over: Record<string, unknown> = {}) =>
  client().request<AgentRun>(w.peer, "POST", `/link/v1/runs/${runId}/start`, startBody(over));

const refusal = async (p: Promise<unknown>): Promise<{ status: number; code: string }> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(RemoteRefusedError);
  return { status: (err as RemoteRefusedError).status, code: (err as RemoteRefusedError).code };
};

/** Reads the whole event stream from `afterSeq`; resolves when the worker ends it. */
async function readStream(w: Worker, runId: string, afterSeq = 0): Promise<MirrorFrame[]> {
  const frames: MirrorFrame[] = [];
  await client().stream(w.peer, `/link/v1/runs/${runId}/events?afterSeq=${afterSeq}`, async (line) => {
    frames.push(mirrorFrameSchema.parse(JSON.parse(line)));
  }, new AbortController().signal);
  return frames;
}

const until = (fn: () => void) => vi.waitFor(fn, { timeout: 30_000, interval: 50 });
const types = (entries: LedgerEntry[]) => entries.map((e) => e.type);

describe("link protocol: runs from a paired machine", () => {
  it("imports the repository, records the project and the run in one transaction, then starts the run under the requested id", { timeout: T }, async () => {
    const w = await startWorker([{ message: "hello" }]);
    await uploadRepo(w, "run-a");
    const run = await startRun(w, "run-a");
    expect(run.id).toBe("run-a");
    expect(run.projectId).toBe("p1");
    const entries = w.ledger.list();
    const firstLink = entries.findIndex((e) => e.type === "project.created");
    const accepted = entries.slice(firstLink, firstLink + 4);
    expect(types(accepted)).toEqual(["project.created", "link.project_received", "link.run_accepted", "agent.started"]);
    expect(accepted[1]!.seq).toBe(accepted[0]!.seq + 1);
    expect(accepted[2]!.seq).toBe(accepted[1]!.seq + 1);
    expect(accepted[1]!.payload).toEqual({ projectId: "p1", machineId: requester.machineId, name: "Demo" });
    expect(accepted[2]!.payload).toEqual({ runId: "run-a", machineId: requester.machineId, projectId: "p1" });
    // The Owner asked, through the requester; the run is the Owner's on this machine too.
    expect(accepted[3]!.actor).toEqual(owner);
    await until(() => expect(getRun(w.db, "run-a")!.status).toBe("completed"));
    // Nothing is left of the uploaded bundle.
    expect(readdirSync(join(w.dataDir, "link", "incoming"))).toEqual([]);

    // A second run in the same project records only link.run_accepted before it starts.
    const before = w.ledger.headSeq();
    await uploadRepo(w, "run-b");
    await startRun(w, "run-b");
    expect(types(w.ledger.list({ afterSeq: before })).slice(0, 2)).toEqual(["link.run_accepted", "agent.started"]);
  });

  it("refuses a start before the repository arrived, a repeated run id, and a bundle that is not one", { timeout: T }, async () => {
    const w = await startWorker([{ message: "hello" }]);
    expect(await refusal(startRun(w, "run-x"))).toEqual({ status: 409, code: "no_repo" });
    await uploadRepo(w, "run-x");
    await startRun(w, "run-x");
    // Another upload or start for the same id is a conflict.
    expect(await refusal(uploadRepo(w, "run-x"))).toEqual({ status: 409, code: "conflict" });
    expect(await refusal(startRun(w, "run-x"))).toEqual({ status: 409, code: "conflict" });

    const bad = join(scratch, "bad.bundle");
    writeFileSync(bad, "not a bundle");
    await client().upload(w.peer, "/link/v1/runs/run-bad/repo", bad, MAX_BUNDLE_BYTES);
    const head = w.ledger.headSeq();
    expect(await refusal(startRun(w, "run-bad"))).toEqual({ status: 400, code: "bundle_invalid" });
    expect(w.ledger.headSeq()).toBe(head);
  });

  it("refuses a run id or project id that is not an id before any path is built", { timeout: T }, async () => {
    const w = await startWorker([{ message: "hello" }]);
    for (const id of ["..%2Fx", "a%20b", "x".repeat(101)]) {
      expect(await refusal(startRun(w, id))).toEqual({ status: 400, code: "invalid_input" });
    }
    await uploadRepo(w, "run-p");
    expect(await refusal(startRun(w, "run-p", { projectId: "../p1" }))).toEqual({ status: 400, code: "invalid_input" });
    expect(existsSync(join(w.dataDir, "projects", "..", "p1"))).toBe(false);
  });

  it("refuses to import into a project this machine did not receive from that machine", { timeout: T }, async () => {
    const w = await startWorker([{ message: "hello" }]);
    commitEvent(w.db, w.ledger, () => ({
      event: { projectId: "p1", actor: owner, type: "project.created", payload: { projectId: "p1", name: "Mine", pitch: "" } },
      result: () => undefined,
    }));
    await uploadRepo(w, "run-own");
    expect(await refusal(startRun(w, "run-own"))).toEqual({ status: 409, code: "conflict" });
    expect(w.ledger.list().some((e) => e.type === "link.run_accepted")).toBe(false);
  });

  it("two machines racing a brand-new project id: one import lands, the other is refused before it touches the repository", { timeout: T }, async () => {
    const w = await startWorker([{ message: "hello" }]);
    // A second paired requester with its own copy of "p1", one commit further on, so the two bundles differ.
    const other = await newIdentity();
    commitEvent(w.db, w.ledger, () => ({
      event: {
        projectId: null, actor: owner, type: "machine.paired",
        payload: { machineId: other.machineId, name: "Other", publicKey: other.publicKeyBase64, fingerprint: other.fingerprint, address: "127.0.0.1:2", role: "showed_code" },
      },
      result: () => undefined,
    }));
    const otherData = realpathSync(mkdtempSync(join(tmpdir(), "proto-other-")));
    cleanups.push(() => rmSync(otherData, { recursive: true, force: true, maxRetries: 5 }));
    const otherWt = new WorktreeManager(otherData);
    const otherRepo = await otherWt.ensureProjectRepo("p1");
    await otherWt.runGit(otherRepo, ["commit", "--allow-empty", "--no-verify", "-m", "second"]);
    const head = async (wt: WorktreeManager, repo: string) => (await wt.runGit(repo, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    const heads = { mine: await head(reqWt, await reqWt.ensureProjectRepo("p1")), other: await head(otherWt, otherRepo) };
    expect(heads.mine).not.toBe(heads.other);
    const otherClient = new LinkClient({ identity: other, timeoutMs: 60_000 });
    await uploadRepo(w, "run-race-a");
    const otherBundle = join(scratch, "other.bundle");
    await exportRepoBundle(otherWt, "p1", otherBundle);
    await otherClient.upload(w.peer, "/link/v1/runs/run-race-b/repo", otherBundle, MAX_BUNDLE_BYTES);

    const [a, b] = await Promise.all([
      startRun(w, "run-race-a").then(() => "ok" as const, (e: unknown) => e),
      otherClient.request<AgentRun>(w.peer, "POST", "/link/v1/runs/run-race-b/start", startBody()).then(() => "ok" as const, (e: unknown) => e),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    const loser = outcomes.find((o) => o !== "ok");
    expect(loser).toBeInstanceOf(RemoteRefusedError);
    expect((loser as RemoteRefusedError).code).toBe("conflict");
    // The repository holds the winner's commit, untouched by the loser's bundle.
    const winner = a === "ok" ? heads.mine : heads.other;
    expect(await head(w.worktrees, join(w.dataDir, "projects", "p1", "repo"))).toBe(winner);
    expect(w.ledger.list().filter((e) => e.type === "project.created")).toHaveLength(1);
    expect(w.ledger.list().filter((e) => e.type === "link.run_accepted")).toHaveLength(1);
    expect(readdirSync(join(w.dataDir, "link", "incoming"))).toEqual([]);
  });

  it("records the requester's project name cleaned as any text from another machine", { timeout: T }, async () => {
    const w = await startWorker([{ message: "hello" }]);
    await uploadRepo(w, "run-name");
    await startRun(w, "run-name", { projectName: "Demo sk-ant-TESTKEY0123456789abcdef mail me@example.com" });
    const received = w.ledger.list().find((e) => e.type === "link.project_received")!;
    const name = (received.payload as { name: string }).name;
    expect(name).not.toContain("TESTKEY");
    expect(name).not.toContain("me@example.com");
    expect(name.startsWith("Demo")).toBe(true);
  });

  it("keeps an owner record beside each upload, and refuses a start whose record is missing", { timeout: T }, async () => {
    const w = await startWorker([{ message: "hello" }]);
    await uploadRepo(w, "run-rec");
    const incoming = join(w.dataDir, "link", "incoming");
    const record = JSON.parse(readFileSync(join(incoming, "run-rec.json"), "utf8"));
    expect(record).toMatchObject({ machineId: requester.machineId });
    expect(record.bytes).toBeGreaterThan(0);
    expect(typeof record.ts).toBe("string");
    rmSync(join(incoming, "run-rec.json"));
    expect(await refusal(startRun(w, "run-rec"))).toEqual({ status: 409, code: "no_repo" });
    expect(readdirSync(incoming)).toEqual([]);
  });

  it("refuses a second upload for a run id whose repository is already waiting", { timeout: T }, async () => {
    const w = await startWorker([{ message: "hello" }]);
    await uploadRepo(w, "run-twice");
    expect(await refusal(uploadRepo(w, "run-twice"))).toEqual({ status: 409, code: "conflict" });
  });

  it("caps a machine's waiting uploads at four, and at 1 GiB with the declared length", { timeout: T }, async () => {
    const w = await startWorker([{ message: "hello" }]);
    for (const id of ["u1", "u2", "u3", "u4"]) await uploadRepo(w, id);
    expect(await refusal(uploadRepo(w, "u5"))).toEqual({ status: 409, code: "upload_limit" });
    // Starting one frees a place.
    await startRun(w, "u1");
    // Bytes: with 800 MiB waiting (u2 stands for it here), a declared 256 MiB, or an undeclared body that may be as
    // large, passes 1 GiB; a small declared one still fits.
    const incoming = join(w.dataDir, "link", "incoming");
    const record = JSON.parse(readFileSync(join(incoming, "u2.json"), "utf8"));
    writeFileSync(join(incoming, "u2.json"), JSON.stringify({ ...record, bytes: 800 * 1024 * 1024 }));
    const { port } = parseHostPort(w.peer.address);
    const declared = await rawPost(port, "/link/v1/runs/u6/repo", { "content-length": String(MAX_BUNDLE_BYTES) }, null);
    expect(declared).toEqual({ status: 409, body: { error: "upload_limit" } });
    const chunked = await rawPost(port, "/link/v1/runs/u6/repo", { "transfer-encoding": "chunked" }, 10);
    expect(chunked).toEqual({ status: 409, body: { error: "upload_limit" } });
    await uploadRepo(w, "u6");
  });

  it("removes uploads never started after an hour, and stray files, before the next upload and when the listener starts", { timeout: T }, async () => {
    let now = Date.parse("2026-11-15T10:00:00Z");
    const w = await startWorker([{ message: "hello" }], { now: () => now });
    await uploadRepo(w, "old");
    const incoming = join(w.dataDir, "link", "incoming");
    now += 60 * 60 * 1000 + 1;
    await uploadRepo(w, "fresh");
    expect(readdirSync(incoming).sort()).toEqual(["fresh.bundle", "fresh.json"]);
    expect(await refusal(startRun(w, "old"))).toEqual({ status: 409, code: "no_repo" });
    // Left by a crash: a partial upload, a bundle without its record, a record without its bundle.
    writeFileSync(join(incoming, `x.${requester.machineId}.0000.part`), "partial");
    writeFileSync(join(incoming, "orphan.bundle"), "b");
    writeFileSync(join(incoming, "lonely.json"), JSON.stringify({ machineId: requester.machineId, bytes: 1, ts: new Date(now).toISOString() }));
    await w.link.disableLinking(owner);
    await w.link.enableLinking(owner, LINKING_ACK, 0);
    expect(readdirSync(incoming).sort()).toEqual(["fresh.bundle", "fresh.json"]);
  });

  it("refuses a body over the limit with 413, leaving no file behind", { timeout: T }, async () => {
    const w = await startWorker([{ message: "hello" }]);
    const { port } = parseHostPort(w.peer.address);
    // Declared too large: refused from the header, before any byte of the body is read.
    const declared = await rawPost(port, "/link/v1/runs/run-big/repo", { "content-length": String(MAX_BUNDLE_BYTES + 1) }, null);
    expect(declared).toEqual({ status: 413, body: { error: "repo_too_large" } });
    // Undeclared (chunked): counted as it arrives, MAX_BUNDLE_BYTES + 1 zero bytes.
    const chunked = await rawPost(port, "/link/v1/runs/run-big/repo", { "transfer-encoding": "chunked" }, MAX_BUNDLE_BYTES + 1);
    expect(chunked.status).toBe(413);
    const incoming = join(w.dataDir, "link", "incoming");
    expect(existsSync(incoming) ? readdirSync(incoming) : []).toEqual([]);
    expect(await refusal(startRun(w, "run-big"))).toEqual({ status: 409, code: "no_repo" });
  });

  it("refuses a connection id that exists only on the requester, and records no connection.used", { timeout: T }, async () => {
    const w = await startWorker([{ message: "hello" }]);
    await uploadRepo(w, "run-c");
    expect(await refusal(startRun(w, "run-c", { connectionIds: ["conn-on-the-requester"] }))).toEqual({ status: 404, code: "not_found" });
    expect(w.ledger.list().some((e) => e.type === "connection.used")).toBe(false);
    expect(getRun(w.db, "run-c")).toBeNull();
    // The accepted run that could not start is recorded as failed, with the code the requester was answered.
    const failed = w.ledger.list().filter((e) => e.type === "link.run_failed");
    expect(failed.map((e) => e.payload)).toEqual([{ runId: "run-c", machineId: requester.machineId, error: "not_found" }]);
    expect(getLinkRun(w.db, "run-c")).toMatchObject({ state: "failed", error: "not_found" });
  });

  it("streams the run's agent entries in order, each signed with the worker's key, and ends after agent.finished", { timeout: T }, async () => {
    const w = await startWorker([{ message: "hello" }, { message: "done" }]);
    await uploadRepo(w, "run-s");
    await startRun(w, "run-s");
    await until(() => expect(getRun(w.db, "run-s")!.status).toBe("completed"));
    const frames = await readStream(w, "run-s");
    const expected = w.ledger.list().filter((e) => e.type.startsWith("agent.") && (e.payload as { runId?: string }).runId === "run-s");
    expect(frames.map((f) => f.origin.seq)).toEqual(expected.map((e) => e.seq));
    expect(frames.map((f) => f.origin.type)).toEqual(["agent.started", "agent.message", "agent.message", "agent.finished"]);
    for (const f of frames) expect(verifyFrame(w.peer.publicKeyDer, f)).toBe(true);
    for (const f of frames) expect(verifyFrame(requester.publicKeyDer, f)).toBe(false);
    // From a later seq only what follows it; from past the end, an empty stream that still ends.
    expect((await readStream(w, "run-s", frames[1]!.origin.seq)).map((f) => f.origin.type)).toEqual(["agent.message", "agent.finished"]);
    expect(await readStream(w, "run-s", frames.at(-1)!.origin.seq)).toEqual([]);
  });

  it("answers 404 for a stream, decision, stop or changes of a run the worker never accepted from this machine", { timeout: T }, async () => {
    const w = await startWorker([{ message: "hello" }]);
    expect(await refusal(readStream(w, "run-never"))).toEqual({ status: 404, code: "not_found" });
    expect(await refusal(client().request(w.peer, "POST", "/link/v1/runs/run-never/stop"))).toEqual({ status: 404, code: "not_found" });
    expect(await refusal(client().request(w.peer, "POST", "/link/v1/runs/run-never/actions/a1/decision", { v: 1, decision: "allow", reason: "" })))
      .toEqual({ status: 404, code: "not_found" });
    expect(await refusal(client().download(w.peer, "/link/v1/runs/run-never/changes", join(scratch, "c.bundle"), MAX_BUNDLE_BYTES)))
      .toEqual({ status: 404, code: "not_found" });
    // A local run of the worker is not the requester's to see either.
    commitEvent(w.db, w.ledger, () => ({
      event: { projectId: "local", actor: owner, type: "project.created", payload: { projectId: "local", name: "Local", pitch: "" } },
      result: () => undefined,
    }));
    const local = await w.runner.start(owner, { projectId: "local", adapter: "fake", prompt: "p" });
    expect(await refusal(readStream(w, local.id))).toEqual({ status: 404, code: "not_found" });
  });

  it("relays a decision through the worker's own gate: link.decision_received, then the human decision; only the latter is streamed", { timeout: T }, async () => {
    const w = await startWorker([{ propose: shell, result: { ok: true, output: "tests pass" } }]);
    await uploadRepo(w, "run-d");
    await startRun(w, "run-d");
    await until(() => expect(listPendingActions(w.db, "p1")).toHaveLength(1));
    const [pending] = listPendingActions(w.db, "p1");
    // The worker's own copy of an accepted run is a local run: its runner decides it (only a requester's mirror has a machine).
    expect(getRun(w.db, "run-d")!.machineId).toBeNull();
    // The worker gated the action itself: nothing ran before a decision.
    expect(w.ledger.list().some((e) => e.type === "agent.action.completed")).toBe(false);
    const decided = await client().request<AgentAction>(w.peer, "POST", `/link/v1/runs/run-d/actions/${pending!.id}/decision`, {
      v: 1, decision: "allow", reason: "fine",
    });
    expect(decided).toMatchObject({ id: pending!.id, status: "allowed", decidedBy: "human" });
    const entries = w.ledger.list();
    const received = entries.findIndex((e) => e.type === "link.decision_received");
    expect(entries[received]!.payload).toEqual({ runId: "run-d", actionId: pending!.id, machineId: requester.machineId, decision: "allow" });
    // The relay is recorded only once the worker's own gate took the decision, right after it.
    expect(entries[received - 1]).toMatchObject({ type: "agent.action.decided", payload: { by: "human", decision: "allow" } });
    await until(() => expect(getRun(w.db, "run-d")!.status).toBe("completed"));
    expect(w.ledger.list().filter((e) => e.type === "agent.action.completed")).toHaveLength(1);
    expect(await refusal(client().request(w.peer, "POST", `/link/v1/runs/run-d/actions/${pending!.id}/decision`, { v: 1, decision: "deny", reason: "" })))
      .toEqual({ status: 409, code: "already_decided" });
    // A decision the runner refused is no relay: nothing of it is recorded.
    expect(w.ledger.list().filter((e) => e.type === "link.decision_received")).toHaveLength(1);
    const frames = await readStream(w, "run-d");
    const streamed = frames.map((f) => f.origin.type);
    expect(streamed).toContain("agent.action.decided");
    expect(streamed).not.toContain("link.decision_received");
    expect(streamed.at(-1)).toBe("agent.finished");
  });

  it("streams live while the run waits, and ends after a stop", { timeout: T }, async () => {
    const w = await startWorker([{ propose: shell, result: { ok: true, output: "x" } }]);
    await uploadRepo(w, "run-live");
    await startRun(w, "run-live");
    const reading = readStream(w, "run-live");
    await until(() => expect(listPendingActions(w.db, "p1")).toHaveLength(1));
    const stopped = await client().request<AgentRun>(w.peer, "POST", "/link/v1/runs/run-live/stop");
    expect(stopped.status).toBe("stopped");
    const frames = await reading;
    expect(frames.map((f) => f.origin.type)).toEqual(["agent.started", "agent.action.requested", "agent.action.decided", "agent.finished"]);
  });

  it("unpairing the requester stops the runs accepted from it; unpairing another machine leaves them alone", { timeout: T }, async () => {
    const w = await startWorker([{ propose: shell, result: { ok: true, output: "x" } }]);
    await uploadRepo(w, "run-unpaired");
    await startRun(w, "run-unpaired");
    const reading = readStream(w, "run-unpaired");
    await until(() => expect(listPendingActions(w.db, "p1")).toHaveLength(1));
    const other = await newIdentity();
    commitEvent(w.db, w.ledger, () => ({
      event: {
        projectId: null, actor: owner, type: "machine.paired",
        payload: {
          machineId: other.machineId, name: "Other", publicKey: other.publicKeyBase64, fingerprint: other.fingerprint,
          address: "127.0.0.1:2", role: "showed_code",
        },
      },
      result: () => undefined,
    }));
    await w.link.unpair(owner, other.machineId);
    await new Promise((r) => setTimeout(r, 150));
    expect(getRun(w.db, "run-unpaired")!.status).toBe("running");
    expect(listPendingActions(w.db, "p1")).toHaveLength(1);

    await w.link.unpair(owner, requester.machineId);
    await until(() => expect(getRun(w.db, "run-unpaired")!.status).toBe("stopped"));
    expect(listPendingActions(w.db, "p1")).toHaveLength(0);
    // The stream the requester held is cut with the trust: nothing of it outlives the unpair, and the requester's next
    // connection is refused at the TLS layer.
    await expect(reading).rejects.toBeInstanceOf(MachineUnreachableError);
    await expect(readStream(w, "run-unpaired")).rejects.toBeInstanceOf(MachineUnreachableError);
    expect(w.ledger.list().filter((e) => e.type === "agent.finished")).toHaveLength(1);
  });

  it("ends the stream cleanly before an entry it cannot sign as a frame the requester would accept", { timeout: T }, async () => {
    const w = await startWorker([{ propose: shell, result: { ok: true, output: "x" } }]);
    await uploadRepo(w, "run-big-frame");
    await startRun(w, "run-big-frame");
    await until(() => expect(listPendingActions(w.db, "p1")).toHaveLength(1));
    // Over the mirrored input cap: the runner never records one, so it is written here directly.
    commitEvent(w.db, w.ledger, () => ({
      event: {
        projectId: "p1", actor: { kind: "agent", id: "run-big-frame" }, type: "agent.action.requested",
        payload: { runId: "run-big-frame", actionId: "act-huge", kind: "other", tool: "Tool", summary: "huge", input: { blob: "z".repeat(30_000) } },
      },
      result: () => undefined,
    }));
    const frames = await readStream(w, "run-big-frame");
    expect(frames.map((f) => f.origin.type)).toEqual(["agent.started", "agent.action.requested"]);
  });

  it("sends a blank heartbeat line while nothing happens, which the requester skips", { timeout: T }, async () => {
    const w = await startWorker([{ propose: shell, result: { ok: true, output: "x" } }], { heartbeatMs: 50 });
    await uploadRepo(w, "run-hb");
    await startRun(w, "run-hb");
    await until(() => expect(listPendingActions(w.db, "p1")).toHaveLength(1));
    const { port } = parseHostPort(w.peer.address);
    const raw = await rawGetFor(port, "/link/v1/runs/run-hb/events?afterSeq=0", 400);
    expect(raw).toMatch(/\n\n/);
    const frames = raw.split("\n").filter((l) => l !== "");
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const l of frames) expect(verifyFrame(w.peer.publicKeyDer, mirrorFrameSchema.parse(JSON.parse(l)))).toBe(true);
  });

  it("refuses the changes while the run is live, then sends a snapshot bundle that importSnapshot accepts", { timeout: T }, async () => {
    const w = await startWorker([
      { propose: { ...shell, kind: "file_write", tool: "Write", summary: "write notes", input: { path: "notes.md" }, paths: ["notes.md"] }, write: { path: "notes.md", content: "from the worker\n" }, result: { ok: true, output: "written" } },
    ]);
    await uploadRepo(w, "run-ch");
    await startRun(w, "run-ch");
    await until(() => expect(listPendingActions(w.db, "p1")).toHaveLength(1));
    const file = join(scratch, "changes-run-ch.bundle");
    expect(await refusal(client().download(w.peer, "/link/v1/runs/run-ch/changes", file, MAX_BUNDLE_BYTES))).toEqual({ status: 409, code: "run_active" });
    const [pending] = listPendingActions(w.db, "p1");
    await client().request(w.peer, "POST", `/link/v1/runs/run-ch/actions/${pending!.id}/decision`, { v: 1, decision: "allow", reason: "" });
    await until(() => expect(getRun(w.db, "run-ch")!.status).toBe("completed"));
    await client().download(w.peer, "/link/v1/runs/run-ch/changes", file, MAX_BUNDLE_BYTES);
    const imported = await importSnapshot(reqWt, "p1", "run-ch", file);
    expect(imported.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(imported.absPath, "notes.md"))).toBe(true);
    // The worker keeps no copy of what it sent.
    expect(readdirSync(join(w.dataDir, "link", "outgoing"))).toEqual([]);
  });

  it("destroys a connection from a machine that is not paired", { timeout: T }, async () => {
    const w = await startWorker([{ message: "hello" }]);
    const stranger = await newIdentity();
    const { port } = parseHostPort(w.peer.address);
    const reply = await rawTlsGet(port, "/link/v1/runs/run-a/events?afterSeq=0", stranger);
    expect(reply.kind).toBe("closed");
  });
});

function parseHostPort(address: string): { host: string; port: number } {
  const at = address.lastIndexOf(":");
  return { host: address.slice(0, at), port: Number(address.slice(at + 1)) };
}

/** A raw POST as the paired requester: `zeros` bytes of zeros as the body (null sends no body), and the reply. */
function rawPost(
  port: number, path: string, headers: Record<string, string>, zeros: number | null,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1", port, path, method: "POST", agent: false, rejectUnauthorized: false, minVersion: "TLSv1.3",
        checkServerIdentity: () => undefined, ...requester.tls(),
        headers: { "content-type": "application/octet-stream", ...headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
        res.on("error", reject);
      },
    );
    req.on("error", () => undefined); // the worker may close while the body is still being written
    req.setTimeout(60_000, () => req.destroy(new Error("timeout")));
    req.flushHeaders();
    if (zeros === null) return; // headers only; the worker answers without waiting for the body
    const chunk = Buffer.alloc(1024 * 1024);
    let left = zeros;
    const pump = (): void => {
      while (left > 0) {
        const n = Math.min(left, chunk.length);
        left -= n;
        if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
          req.once("drain", pump);
          return;
        }
      }
      req.end();
    };
    pump();
  });
}

/** The raw text of a GET as the paired requester, cut off after `ms`. */
function rawGetFor(port: number, path: string, ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1", port, path, method: "GET", agent: false, rejectUnauthorized: false, minVersion: "TLSv1.3",
        checkServerIdentity: () => undefined, ...requester.tls(),
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        setTimeout(() => {
          req.destroy();
          resolve(text);
        }, ms);
      },
    );
    req.on("error", (e) => (e.message.includes("socket hang up") ? undefined : reject(e)));
    req.end();
  });
}
