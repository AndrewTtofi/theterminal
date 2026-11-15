import type { Actor, LedgerEntry, MirrorableType } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { commitEvent } from "../../src/events/commit.js";
import type { LinkIdentity } from "../../src/link/identity.js";
import { signFrame } from "../../src/link/mirror.js";
import { newIdentity } from "./helpers.js";

const owner = { kind: "human", id: "owner" } as const;

/**
 * A run the requester sent to a paired worker: the worker's own ledger (real, hashed and chained entries, no
 * projections), its identity, and helpers that record worker entries and sign them as the frames the worker streams.
 */
export type RemoteRun = {
  machineId: string;
  identity: LinkIdentity;
  runId: string;
  projectId: string;
  /** Records an entry on the worker's own ledger. */
  record: (type: MirrorableType, payload: Record<string, unknown>, actor?: Actor, projectId?: string | null) => LedgerEntry;
  /** The NDJSON line the worker sends for one of its entries. */
  line: (entry: LedgerEntry) => string;
  /** The worker's usual entries for the run. */
  started: (cardId?: string | null) => LedgerEntry;
  message: (text: string) => LedgerEntry;
  requested: (actionId: string, command?: string) => LedgerEntry;
  decided: (actionId: string, decision?: "allow" | "deny") => LedgerEntry;
  completed: (actionId: string, output?: string) => LedgerEntry;
  finished: () => LedgerEntry;
  connectionUsed: () => LedgerEntry;
};

/** A fresh worker ledger, and a fresh identity unless given, for `runId` in `projectId` (the same ids on both machines). */
export async function remoteRun(runId: string, projectId: string, given?: LinkIdentity): Promise<RemoteRun> {
  const identity = given ?? (await newIdentity());
  const workerDb: Db = openDatabase(":memory:");
  const workerLedger = new Ledger(workerDb);
  const agent = { kind: "agent", id: runId } as const;
  const record: RemoteRun["record"] = (type, payload, actor = agent, pid = projectId) =>
    commitEvent(workerDb, workerLedger, () => ({ event: { projectId: pid, actor, type, payload }, result: (e) => e! }), () => {});
  return {
    machineId: identity.machineId,
    identity,
    runId,
    projectId,
    record,
    line: (entry) => JSON.stringify(signFrame(identity, entry)),
    started: (cardId = null) =>
      record("agent.started", {
        runId, adapter: "fake", authMode: "none", prompt: "Fix the tests", cardId, worktree: `projects/${projectId}/worktrees/${runId}`,
      }, owner),
    message: (text) => record("agent.message", { runId, text }),
    requested: (actionId, command = "npm test") =>
      record("agent.action.requested", { runId, actionId, kind: "shell", tool: "Bash", summary: `Run: ${command}`, input: { command } }),
    decided: (actionId, decision = "allow") =>
      record("agent.action.decided", { runId, actionId, decision, by: "human", reason: "" }, owner),
    completed: (actionId, output = "ok") => record("agent.action.completed", { runId, actionId, ok: true, output }),
    finished: () => record("agent.finished", { runId, status: "completed", costUsd: null, error: null }, { kind: "system", id: "runner" }),
    connectionUsed: () => record("connection.used", { connectionId: "c1", name: "Work key", runId, purpose: "api_key" }, owner, null),
  };
}

const emitter = (db: Db, ledger: Ledger) => (type: LedgerEntry["type"], payload: Record<string, unknown>, projectId: string | null) =>
  commitEvent(db, ledger, () => ({ event: { projectId, actor: owner, type, payload }, result: () => undefined }));

/** Records on the requester that the run was sent to `remote`'s machine, in the run's project. */
export function requestRun(db: Db, ledger: Ledger, remote: RemoteRun): void {
  emitter(db, ledger)("link.run_requested", {
    runId: remote.runId, machineId: remote.machineId, adapter: "fake", prompt: "Fix the tests", cardId: null, connectionIds: [],
  }, remote.projectId);
}

/** Records on the requester that `remote`'s machine is paired and that the run was sent to it. */
export function pairAndRequest(db: Db, ledger: Ledger, remote: RemoteRun, name = "GPU box"): void {
  emitter(db, ledger)("machine.paired", {
    machineId: remote.machineId, name, publicKey: remote.identity.publicKeyBase64, fingerprint: remote.identity.fingerprint,
    address: "gpu-box.local:4418", role: "entered_code",
  }, null);
  requestRun(db, ledger, remote);
}
