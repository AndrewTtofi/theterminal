import type { AgentAction, AgentRun, LedgerEntry, MirroredOrigin } from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { commitEvent } from "../events/commit.js";
import { getLinkRun, getMachine, MirroredEntryRefusedError } from "../events/projections.js";
import { redact } from "../agents/redact.js";
import { checkFrame, cleanStrings, displayOrigin, type FrameCheck, type FrameRefusal } from "./mirror.js";

/**
 * The requester's side of a mirrored run, where it touches the ledger: committing one untrusted line of a worker's
 * stream, and showing what a worker sent through this machine's own cleaner.
 */

const LINK_ACTOR = { kind: "system", id: "link" } as const;

/** Whether a worker entry id was already mirrored for the run: one indexed-by-type ledger read, not the whole set. */
function seenFor(db: Db, runId: string): (originId: string) => boolean {
  const q = db.prepare(
    `SELECT 1 FROM ledger WHERE type = 'link.mirrored' AND CASE WHEN json_valid(payload)
       THEN json_extract(payload, '$.origin.id') = ? AND json_extract(payload, '$.origin.payload.runId') = ? ELSE 0 END
     LIMIT 1`,
  );
  return (originId) => q.get(originId, runId) !== undefined;
}

/**
 * Refusals a correct worker never causes: the run ends at the first one (`link.run_failed`, committed with the
 * refusal), because the stream can no longer be trusted. `out_of_order` and `duplicate` can follow from a reconnect
 * and only skip the frame; `conflict` is this machine's state, not the worker's fault.
 */
export const FATAL_REFUSALS: ReadonlySet<FrameRefusal> = new Set<FrameRefusal>([
  "bad_signature", "wrong_run", "wrong_project", "foreign_action", "invalid_payload", "not_mirrorable", "too_large", "invalid_frame",
]);

/** A constraint the projection's own tables enforce (a run or action id that already exists, a missing project). */
const PROJECTION_CONSTRAINTS = new Set(["SQLITE_CONSTRAINT_PRIMARYKEY", "SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_NOTNULL"]);

function projectionRefused(err: unknown): boolean {
  if (err instanceof MirroredEntryRefusedError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return err instanceof Error && err.name === "SqliteError" && typeof code === "string" && PROJECTION_CONSTRAINTS.has(code);
}

/**
 * Checks one line of the stream of `runId` with `checkFrame`, against this machine's own records only, and commits it
 * as `link.mirrored` when it passes; check and commit happen in one transaction, one line at a time, so a decision
 * frame sees the request committed just before it.
 *
 * - The run must be one this machine requested (`link_runs`, direction `requested`); otherwise `wrong_run`, and nothing
 *   is recorded. Once the link run has failed, every frame is refused (`run_failed`) and nothing is recorded.
 * - The key is the one pinned in the `machines` row of `link_runs.machine_id`, never one a connection presents; an
 *   unpaired machine has no key, so its frames are `bad_signature`.
 * - The cursor is `link_runs.last_seq`, duplicates are looked up in the ledger, and an action's owner is
 *   `agent_actions.run_id`.
 * - A fatal refusal (`FATAL_REFUSALS`) commits `link.run_failed { runId, machineId, error: reason }` in the same
 *   transaction, which fails the link run and the mirrored run. Any other refusal commits nothing.
 * - When the projection refuses a checked frame (a run id that already exists here, say), the commit rolls back and
 *   the answer is `conflict`. Any other error, a read-only ledger included, is thrown.
 */
export function acceptMirroredLine(db: Db, ledger: Ledger, runId: string, line: string): FrameCheck {
  try {
    return commitEvent(db, ledger, () => {
      const link = getLinkRun(db, runId);
      if (!link || link.direction !== "requested") return { result: (): FrameCheck => ({ ok: false, reason: "wrong_run" }) };
      if (link.state === "failed") return { result: (): FrameCheck => ({ ok: false, reason: "run_failed" }) };
      const machine = getMachine(db, link.machineId);
      const actionOwner = db.prepare("SELECT run_id FROM agent_actions WHERE id = ?");
      const check: FrameCheck = machine
        ? checkFrame(line, {
          publicKeyDer: Buffer.from(machine.publicKey, "base64"),
          runId,
          projectId: link.projectId,
          lastSeq: link.lastSeq,
          seen: seenFor(db, runId),
          actionRunOf: (actionId) => (actionOwner.get(actionId) as { run_id: string } | undefined)?.run_id ?? null,
        })
        : { ok: false, reason: "bad_signature" };
      if (!check.ok) {
        if (!FATAL_REFUSALS.has(check.reason)) return { result: () => check };
        return {
          event: {
            projectId: link.projectId, actor: LINK_ACTOR, type: "link.run_failed",
            payload: { runId, machineId: link.machineId, error: check.reason },
          },
          result: () => check,
        };
      }
      const { origin, signature } = check.frame;
      return {
        event: { projectId: origin.projectId, actor: LINK_ACTOR, type: "link.mirrored", payload: { machineId: link.machineId, origin, signature } },
        result: () => check,
      };
    });
  } catch (err) {
    if (projectionRefused(err)) return { ok: false, reason: "conflict" };
    throw err;
  }
}

/** The built-in redaction, for a caller that has no cleaner of its own. */
export const builtInClean = (s: string): string => redact(s);

/**
 * An entry as it may be shown or exported: a `link.mirrored` one with every string of its origin's payload passed
 * through `clean` (this machine's own redaction: a worker's cleaning is not trusted), any other entry as it is. The
 * result is for display only; the stored entry, whose signature and hash cover the original, is never changed.
 */
export function displayEntry(e: LedgerEntry, clean: (s: string) => string = builtInClean): LedgerEntry {
  if (e.type !== "link.mirrored") return e;
  const p = e.payload;
  if (typeof p !== "object" || p === null) return e;
  const origin = (p as { origin?: unknown }).origin;
  if (typeof origin !== "object" || origin === null) return e;
  return { ...e, payload: { ...p, origin: displayOrigin(origin as MirroredOrigin, clean) } };
}

/**
 * Runs and actions as they may be shown: those of a run on a linked machine (`machineId` set) with their free text
 * passed through `clean`, as their mirrored entries are; this machine's own runs as they are. The projection keeps
 * what the worker sent, so a rebuild stays exact; only the view is cleaned. `worktree` is never touched.
 */
export function remoteDisplay(db: Db, clean: (s: string) => string = builtInClean): {
  run: <T extends AgentRun>(r: T) => T;
  action: <T extends AgentAction>(a: T) => T;
} {
  const machineOf = db.prepare("SELECT machine_id FROM agent_runs WHERE id = ?");
  const remote = (runId: string) => ((machineOf.get(runId) as { machine_id: string | null } | undefined)?.machine_id ?? null) !== null;
  return {
    run: (r) => (r.machineId === null ? r : { ...r, prompt: clean(r.prompt), error: r.error === null ? null : clean(r.error) }),
    action: (a) =>
      !remote(a.runId)
        ? a
        : {
          ...a, tool: clean(a.tool), summary: clean(a.summary), reason: clean(a.reason),
          output: a.output === null ? null : clean(a.output), input: cleanStrings(a.input, clean),
        },
  };
}
