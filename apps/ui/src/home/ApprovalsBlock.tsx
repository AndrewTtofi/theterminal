import { forwardRef, useId, useRef, useState } from "react";
import { actionPhrase, adapterLabel, visibleControls } from "@theterminal/shared";
import type { AdapterId, CardMoveRequest, PendingAgentAction } from "@theterminal/shared";
import { ApiError } from "../api";
import { stageLabel } from "../components/Board";
import { intakeNotices } from "../components/IntakeNotices";
import { gateFor, useShell, useViewerRole } from "../shell/model";
import type { WorkbenchModel } from "../shell/model";

/** The agent of a run Home or the runs list knows, else null. */
export function adapterOfRun(model: Pick<WorkbenchModel, "runs" | "home">, runId: string): AdapterId | null {
  const run = model.runs.find((r) => r.id === runId) ?? model.home.data?.working.find((h) => h.run.id === runId)?.run;
  return run?.adapter ?? null;
}

/** "Claude wants to edit src/a.ts": the plain sentence of a pending action, built from the narration. */
export function decisionSentence(model: Pick<WorkbenchModel, "runs" | "home">, a: PendingAgentAction): string {
  const adapter = adapterOfRun(model, a.runId);
  return `${adapter === null ? "Agent" : adapterLabel(adapter)} wants to ${actionPhrase(a)}`;
}

/**
 * Everything waiting on the Owner, counted as the Workbench counts it: actions, open plan decisions, a stopped move's
 * gates, and the agents' requests to move a card.
 */
export function waitingCount(model: Pick<WorkbenchModel, "pending" | "gate" | "selectedId" | "intake" | "status" | "home">): number {
  const gates = model.gate ? model.gate.evaluations.filter((g) => g.outcome !== "pass").length : 0;
  const moves = model.home?.data?.moveRequests?.length ?? 0;
  return model.pending.length + intakeNotices(model).reduce((a, n) => a + n.decisions, 0) + gates + moves;
}

/** "Claude wants to move “Fix the form” to Ship". */
export const moveRequestSentence = (r: CardMoveRequest): string =>
  `${r.adapter === null ? "Agent" : adapterLabel(r.adapter)} wants to move “${visibleControls(r.title)}” to ${stageLabel(r.to)}`;

/**
 * An agent's move that a gate held: Review asks for the move as a person would (so the gate card and its sign-off do
 * it), Not yet records that the person declined. Reviewers and above.
 */
function MoveRequestRow({ request, otherProject }: { request: CardMoveRequest; otherProject: boolean }) {
  const { model } = useShell();
  const may = gateFor(useViewerRole(), "reviewer");
  const sentenceId = useId();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const run = async (fn: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await fn();
    } catch {
      // The model shows the error; the row stays until the request is settled.
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <li className="home-approval">
      <div className="approval-text">
        {otherProject && <span className="approval-project">{visibleControls(request.projectName)}</span>}
        <p className="approval-sentence" id={sentenceId}>{moveRequestSentence(request)}</p>
      </div>
      {!may.disabled && (
        <div className="approval-actions">
          <button type="button" disabled={busy} aria-describedby={sentenceId} onClick={() => void run(() => model.onReviewMove(request))}>
            Review
          </button>
          <button
            type="button"
            className="quiet"
            disabled={busy}
            aria-describedby={sentenceId}
            onClick={() => void run(() => model.onDeclineMove(request.cardId))}
          >
            Not yet
          </button>
        </div>
      )}
    </li>
  );
}

/** One pending action: its sentence, the agent's reason, and Approve, Deny and Ask why (the same decision as everywhere). */
function ApprovalRow({ action, reason, otherProject }: { action: PendingAgentAction; reason: string | null; otherProject: boolean }) {
  const { model, dock } = useShell();
  const may = gateFor(useViewerRole(), "reviewer");
  const sentenceId = useId();
  const [denying, setDenying] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [note, setNote] = useState<string | null>(null);
  const machine = action.machineName === undefined ? null : visibleControls(action.machineName);

  const decide = async (decision: "allow" | "deny", text?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNote(null);
    try {
      await (text ? model.onDecide(action.id, decision, text) : model.onDecide(action.id, decision));
    } catch (e) {
      // Fixed words only, as on the decision card: a refusal is never shown as sent.
      setNote(
        e instanceof ApiError && e.code === "machine_unreachable" && machine !== null
          ? `Could not reach ${machine}. Your decision was not sent.`
          : e instanceof ApiError && e.status === 409 ? "Already decided" : "Something went wrong",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <li className="home-approval">
      <div className="approval-text">
        {otherProject && <span className="approval-project">{visibleControls(action.projectName)}</span>}
        <p className="approval-sentence" id={sentenceId}>{decisionSentence(model, action)}</p>
        {reason !== null && <p className="approval-reason">{reason}</p>}
        {note !== null && <p className="approval-note" role="status">{note}</p>}
      </div>
      {!may.disabled && (
        denying ? (
          <div className="approval-actions">
            <label>
              Reason (optional)
              <input value={why} onChange={(e) => setWhy(e.target.value)} autoFocus />
            </label>
            <button type="button" disabled={busy} onClick={() => void decide("deny", why.trim())}>
              Confirm deny
            </button>
            <button type="button" className="quiet" onClick={() => setDenying(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="approval-actions">
            <button type="button" disabled={busy} aria-describedby={sentenceId} onClick={() => void decide("allow")}>
              Approve
            </button>
            <button type="button" className="quiet" disabled={busy} aria-describedby={sentenceId} onClick={() => setDenying(true)}>
              Deny
            </button>
            <button type="button" className="quiet" aria-describedby={sentenceId} onClick={() => dock()?.focus("needs_you")}>
              Ask why
            </button>
          </div>
        )
      )}
    </li>
  );
}

/** A row that is reviewed on the Needs-you tab: a stopped move's gates or a plan's open decisions. */
function ReviewRow({ text }: { text: string }) {
  const { dock } = useShell();
  const id = useId();
  return (
    <li className="home-approval">
      <div className="approval-text">
        <p className="approval-sentence" id={id}>{text}</p>
      </div>
      <div className="approval-actions">
        <button type="button" className="quiet" aria-describedby={id} onClick={() => dock()?.focus("needs_you")}>
          Review
        </button>
      </div>
    </li>
  );
}

/**
 * Needs your approval: every project's pending decisions (a project choice never hides one), a stopped move and plans
 * waiting on decisions. Always rendered, whatever the layout says. The heading takes focus from the strip's "need you".
 */
export const ApprovalsBlock = forwardRef<HTMLHeadingElement>(function ApprovalsBlock(_props, headingRef) {
  const { model } = useShell();
  const notices = intakeNotices(model);
  const reasons = new Map((model.home.data?.working ?? []).map((h) => [h.run.id, h.reason]));
  const gate = model.gate;
  const moves = model.home?.data?.moveRequests ?? [];
  const empty = model.pending.length === 0 && gate === null && notices.length === 0 && moves.length === 0;
  const headingId = useId();
  return (
    <section className="home-block home-approvals" aria-labelledby={headingId}>
      <h2 id={headingId} ref={headingRef} tabIndex={-1}>Needs your approval</h2>
      {empty ? (
        <p className="home-empty">Nothing needs you right now.</p>
      ) : (
        <ul className="home-approval-list">
          {model.pending.map((a) => (
            <ApprovalRow key={a.id} action={a} reason={reasons.get(a.runId) ?? null} otherProject={a.projectId !== model.selectedId} />
          ))}
          {moves.map((r) => (
            <MoveRequestRow key={r.cardId} request={r} otherProject={r.projectId !== model.selectedId} />
          ))}
          {gate !== null && (
            <ReviewRow text={`Moving “${visibleControls(gate.cardTitle)}” to ${stageLabel(gate.to)} needs your sign-off`} />
          )}
          {notices.map((n) => (
            <ReviewRow key={n.projectId} text={n.text} />
          ))}
        </ul>
      )}
    </section>
  );
});
