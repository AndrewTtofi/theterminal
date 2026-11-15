import { beforeEach, describe, expect, it } from "vitest";
import type { LedgerEntry } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger, LedgerReadOnlyError } from "../../src/ledger/ledger.js";
import { commitEvent } from "../../src/events/commit.js";
import { canonicalJson } from "../../src/ledger/canonical.js";
import { getLinkRun, getRun, listActions, listAllPendingActions } from "../../src/events/projections.js";
import { BoardService } from "../../src/board/board-service.js";
import { acceptMirroredLine, displayEntry, remoteDisplay } from "../../src/link/mirrored.js";
import { pairAndRequest, remoteRun, requestRun, type RemoteRun } from "./remote-fixtures.js";

const owner = { kind: "human", id: "owner" } as const;
const SECRET = "sk-ant-TESTKEY-0000000000";

let db: Db;
let ledger: Ledger;
let projectId: string;
let remote: RemoteRun;

beforeEach(async () => {
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  projectId = new BoardService(db, ledger).createProject(owner, { name: "Demo" }).id;
  remote = await remoteRun("run-remote-1", projectId);
  pairAndRequest(db, ledger, remote);
});

const mirroredEntries = () => ledger.list().filter((e) => e.type === "link.mirrored");
const accept = (line: string, runId = remote.runId) => acceptMirroredLine(db, ledger, runId, line);
/** A frame the worker's key signed over exactly this origin, whatever it holds. */
const signed = (origin: Record<string, unknown>, via = remote) =>
  JSON.stringify({ origin, signature: via.identity.sign(Buffer.from(canonicalJson(origin))) });
const originOf = (e: LedgerEntry) => JSON.parse(remote.line(e)).origin as Record<string, unknown>;

/** The line is refused for `reason`, and nothing is committed. */
function refused(line: string, reason: string, runId = remote.runId) {
  const head = ledger.headSeq();
  const link = getLinkRun(db, runId);
  expect(accept(line, runId)).toEqual({ ok: false, reason });
  expect(ledger.headSeq()).toBe(head);
  expect(getLinkRun(db, runId)).toEqual(link);
}

describe("acceptMirroredLine", () => {
  it("commits each good frame as link.mirrored by the link, in the origin's project, with the origin byte for byte", () => {
    const started = remote.started();
    const result = accept(remote.line(started));
    expect(result.ok).toBe(true);
    const [e] = mirroredEntries();
    expect(e).toMatchObject({ projectId, actor: { kind: "system", id: "link" }, type: "link.mirrored" });
    const frame = JSON.parse(remote.line(started));
    expect(canonicalJson(e!.payload)).toBe(canonicalJson({ machineId: remote.machineId, origin: frame.origin, signature: frame.signature }));
    expect(getRun(db, remote.runId)).toMatchObject({ status: "running", machineId: remote.machineId });

    const used = remote.connectionUsed();
    expect(accept(remote.line(used)).ok).toBe(true);
    expect(mirroredEntries()[1]!.projectId).toBeNull();
  });

  it("checks and commits frames one at a time, so a decision sees the request committed just before it", () => {
    for (const e of [remote.started(), remote.requested("act-1"), remote.decided("act-1"), remote.completed("act-1"), remote.finished()]) {
      expect(accept(remote.line(e))).toMatchObject({ ok: true });
    }
    expect(listActions(db, remote.runId).map((a) => a.status)).toEqual(["completed"]);
    expect(getLinkRun(db, remote.runId)!.state).toBe("finished");
  });

  it("checks the signature with the key pinned in the machines row of the run's machine", async () => {
    const impostor = await remoteRun(remote.runId, projectId);
    refused(impostor.line(impostor.started()), "bad_signature");
    accept(remote.line(remote.started()));
    // Unpaired: the key is gone, so nothing more from that machine is accepted.
    commitEvent(db, ledger, () => ({
      event: { projectId: null, actor: owner, type: "machine.unpaired", payload: { machineId: remote.machineId, name: "GPU box" } },
      result: () => undefined,
    }));
    refused(remote.line(remote.message("still here")), "bad_signature");
  });

  it("refuses a frame for a run that is not a run requested here", async () => {
    refused(remote.line(remote.started()), "wrong_run", "never-requested");
    commitEvent(db, ledger, () => ({
      event: { projectId, actor: { kind: "system", id: "link" }, type: "link.run_accepted", payload: { runId: "accepted-1", machineId: remote.machineId, projectId } },
      result: () => undefined,
    }));
    const accepted = await remoteRun("accepted-1", projectId);
    refused(accepted.line(accepted.started()), "wrong_run", "accepted-1");
  });

  it("refuses the Review Focus 2 frames: another key, an unlisted type, another run, a duplicate id, an oversize message", async () => {
    accept(remote.line(remote.started()));
    const third = await remoteRun(remote.runId, projectId);
    refused(third.line(third.message("hi")), "bad_signature");

    const card = { ...originOf(remote.message("x")), type: "card.moved", payload: { runId: remote.runId, cardId: "c1", from: "plan", to: "build" } };
    refused(signed(card), "not_mirrorable");

    const otherRun = remote.record("agent.message", { runId: "another-run", text: "hi" });
    refused(remote.line(otherRun), "wrong_run");

    const message = remote.message("once");
    expect(accept(remote.line(message)).ok).toBe(true);
    refused(remote.line(message), "out_of_order");
    refused(signed({ ...originOf(message), seq: 1000 }), "duplicate");

    refused(signed({ ...originOf(remote.message("x")), payload: { runId: remote.runId, text: "y".repeat(4001) } }), "invalid_payload");

    // The next good frame is committed.
    expect(accept(remote.line(remote.message("after"))).ok).toBe(true);
  });

  it("refuses a frame about an action of another run, and leaves that action alone", async () => {
    // A second run on the same machine owns act-9.
    const two = await remoteRun("run-remote-2", projectId, remote.identity);
    requestRun(db, ledger, two);
    expect(accept(two.line(two.started()), two.runId).ok).toBe(true);
    expect(accept(two.line(two.requested("act-9")), two.runId).ok).toBe(true);

    accept(remote.line(remote.started()));
    refused(remote.line(remote.decided("act-9")), "foreign_action");
    refused(remote.line(remote.completed("act-9")), "foreign_action");
    refused(remote.line(remote.requested("act-9")), "foreign_action");
    expect(listAllPendingActions(db).map((a) => [a.id, a.runId, a.status])).toEqual([["act-9", two.runId, "pending"]]);
  });

  it("answers conflict, committing nothing, when the projection refuses a checked frame", () => {
    // A local run already has the id the worker reports.
    commitEvent(db, ledger, () => ({
      event: {
        projectId, actor: owner, type: "agent.started",
        payload: { runId: remote.runId, adapter: "fake", authMode: "none", prompt: "p", cardId: null, worktree: "w" },
      },
      result: () => undefined,
    }));
    refused(remote.line(remote.started()), "conflict");
  });

  it("does not swallow a read-only ledger", () => {
    ledger.readOnly = true;
    expect(() => accept(remote.line(remote.started()))).toThrow(LedgerReadOnlyError);
  });
});

describe("displayEntry", () => {
  it("cleans every string of a mirrored origin's payload, and leaves the stored entry and other entries alone", () => {
    accept(remote.line(remote.started()));
    accept(remote.line(remote.message(`the key is ${SECRET}`)));
    const stored = mirroredEntries()[1]!;
    const shown = displayEntry(stored, (s) => s.replaceAll(SECRET, "[REDACTED]"));
    expect(JSON.stringify(shown)).not.toContain("TESTKEY");
    expect((shown.payload as { origin: { payload: { text: string } } }).origin.payload.text).toBe("the key is [REDACTED]");
    expect(JSON.stringify(stored)).toContain("TESTKEY");
    expect(JSON.stringify(ledger.list().at(-1))).toContain("TESTKEY");
    const local = ledger.list()[0]!;
    expect(displayEntry(local, () => "x")).toBe(local);
  });

  it("cleans with the built-in redaction when given no cleaner", () => {
    accept(remote.line(remote.started()));
    accept(remote.line(remote.message(`the key is ${SECRET}`)));
    expect(JSON.stringify(displayEntry(mirroredEntries()[1]!))).not.toContain("TESTKEY");
  });
});

describe("remoteDisplay", () => {
  it("cleans a remote run's free text and its actions', and leaves this machine's runs and the worktree alone", async () => {
    accept(remote.line(remote.started()));
    accept(remote.line(remote.requested("act-1", `echo ${SECRET}`)));
    const local = await remoteRun("local-run", projectId);
    commitEvent(db, ledger, () => ({
      event: {
        projectId, actor: owner, type: "agent.started",
        payload: { runId: local.runId, adapter: "fake", authMode: "none", prompt: `local ${SECRET}`, cardId: null, worktree: "w" },
      },
      result: () => undefined,
    }));
    const shown = remoteDisplay(db);
    const run = getRun(db, remote.runId)!;
    expect(shown.run(run)).toEqual(run); // nothing to clean in its prompt
    expect(shown.run({ ...run, prompt: `p ${SECRET}`, error: SECRET })).toEqual({ ...run, prompt: "p [REDACTED]", error: "[REDACTED]" });
    const [action] = listActions(db, remote.runId);
    expect(shown.action(action!)).toMatchObject({ summary: "Run: echo [REDACTED]", input: { command: "echo [REDACTED]" } });
    const localRun = getRun(db, local.runId)!;
    expect(shown.run(localRun)).toBe(localRun);
  });
});
