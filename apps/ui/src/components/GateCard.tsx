import { useContext, useEffect, useId, useRef, useState } from "react";
import { GATE_TOPIC, OWNER_ID, ROLE_LABELS, atLeast, requirementLabel, satisfies, visibleControls } from "@theterminal/shared";
import type { GateDecisionInput, GateEvaluation, GateRequirement, Person, Role, Stage } from "@theterminal/shared";
import { api, errorMessage } from "../api";
import { ShellContext } from "../shell/model";
import type { GatePrompt } from "../shell/model";
import { stageLabel } from "./Board";

/** The shortest waiver reason the server accepts, after trimming. */
const REASON_MIN = 10;
const REASON_MAX = 500;

/** Who is deciding. Until the shell passes who is signed in, the Owner. */
export type GateViewer = { personId: string; role: Role };
/** What the card needs to know of a person: a name for the requirement, and whether they are still here. */
export type GatePerson = Pick<Person, "id" | "name" | "removedAt">;

const OWNER_VIEWER: GateViewer = { personId: OWNER_ID, role: "owner" };
const NO_PEOPLE: GatePerson[] = [];
const FORMER = "a former collaborator";

const ROLE_CHOICES = [
  ["role:reviewer", "A reviewer or above"],
  ["role:maintainer", "A maintainer or above"],
  ["role:owner", "The Owner"],
] as const;

const choiceOf = (r: GateRequirement): string => ("role" in r ? `role:${r.role}` : `person:${r.personId}`);
function requirementOfChoice(v: string): GateRequirement {
  return v.startsWith("role:") ? { role: v.slice(5) as Role } : { personId: v.slice(7) };
}

type AccessProps = {
  /** Who is deciding: the role that may act at all, and who `signable` was judged for. */
  viewer?: GateViewer;
  /** People, to name a requirement's person and to offer each current one to the Owner. */
  people?: GatePerson[];
  /** The card's project: the Owner's choice of who may sign is offered only with it. */
  projectId?: string;
  /** After the Owner changed who may sign: the caller reads the gates again. */
  onRequirementChanged?: () => void;
};

type CardProps = {
  evaluation: GateEvaluation;
  cardTitle: string;
  to: Stage;
  /** The Owner's decision for this gate, or null once it no longer stands (the sentence unticked, the reason edited). */
  onDecision: (decision: GateDecisionInput | null) => void;
  onCancel: () => void;
  /** A copy of a gate the strip shows: its checklist and sentence without the controls, pointing to the strip. */
  readOnly?: boolean;
} & AccessProps;

/**
 * One readiness gate a move raised: what it is about, its checklist, and the Owner's sign-off (every condition met)
 * or waiver (a condition unmet; needs a reason). Either needs the gate's acknowledgement sentence ticked.
 */
export function GateCard({
  evaluation: g, cardTitle, to, onDecision, onCancel, readOnly = false,
  viewer = OWNER_VIEWER, people = NO_PEOPLE, projectId, onRequirementChanged,
}: CardProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  // The requirement the Owner just set here, until the caller's next evaluation arrives.
  const [changed, setChanged] = useState<GateRequirement | null>(null);
  const [changing, setChanging] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [chosen, setChosen] = useState<"sign_off" | "waive" | null>(null);
  const hintId = useId();
  const headingId = useId();
  // Outside the shell there is no Learn view to open, so no link.
  const openLearn = useContext(ShellContext)?.openLearn;
  const trimmed = reason.trim();
  const requirement = changed ?? g.requirement;
  const signable = changed !== null ? satisfies(changed, viewer) : g.signable;
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? FORMER;
  const needs = visibleControls(requirementLabel(requirement, nameOf));
  const mayDecide = atLeast(viewer.role, "reviewer");
  const roleTitle = mayDecide ? undefined : `Your role (${ROLE_LABELS[viewer.role]}) cannot do this.`;
  const blocked = !mayDecide || !signable;
  const current = people.filter((p) => p.id !== OWNER_ID && p.removedAt === null);
  const value = choiceOf(requirement);
  const listed = ROLE_CHOICES.some(([v]) => v === value) || current.some((p) => `person:${p.id}` === value);
  const showChoice = !readOnly && viewer.role === "owner" && projectId !== undefined;

  const change = (v: string) => {
    if (projectId === undefined) return;
    setChanging(true);
    setChangeError(null);
    api
      .setGateRequirement(projectId, g.id, requirementOfChoice(v))
      .then((r) => {
        setChanged(r.requirement);
        reset();
        onRequirementChanged?.();
      })
      .catch((e: unknown) => setChangeError(errorMessage(e)))
      .finally(() => setChanging(false));
  };
  const whoMaySign = (
    <>
      <p className="gate-requirement">Who may sign: {needs}</p>
      {showChoice && (
        <p className="gate-requirement-choice">
          <label>
            Change who may sign{" "}
            <select value={value} disabled={changing} onChange={(e) => change(e.target.value)}>
              {ROLE_CHOICES.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
              {current.map((p) => (
                <option key={p.id} value={`person:${p.id}`}>
                  {visibleControls(p.name)}
                </option>
              ))}
              {!listed && (
                <option value={value} disabled>
                  {needs}
                </option>
              )}
            </select>
          </label>
          {changeError !== null && <span className="error"> {changeError}</span>}
        </p>
      )}
    </>
  );
  const reset = () => {
    setChosen(null);
    onDecision(null);
  };
  const decide = (decision: "sign_off" | "waive") => {
    setChosen(decision);
    onDecision(
      decision === "sign_off"
        ? { gateId: g.id, decision, acknowledgement: g.acknowledgement }
        : { gateId: g.id, decision, reason: trimmed.slice(0, REASON_MAX), acknowledgement: g.acknowledgement },
    );
  };

  return (
    <article className="gate-card" aria-label={`Gate: ${visibleControls(g.title)}`}>
      <h3 id={headingId} tabIndex={-1}>
        {visibleControls(g.title)}
      </h3>
      <p className="gate-move">
        Moving "{visibleControls(cardTitle)}" to {stageLabel(to)}
      </p>
      <p>{visibleControls(g.explanation)}</p>
      <h4>Risks</h4>
      <ul className="gate-risks">
        {g.risks.map((r) => (
          <li key={r}>{visibleControls(r)}</li>
        ))}
      </ul>
      <ul className="gate-checklist" aria-label="Checklist">
        {g.conditions.map((c) => (
          <li key={c.id} className={c.met ? "met" : "unmet"}>
            <span role="img" aria-label={c.met ? "met" : "unmet"}>
              {c.met ? "✓" : "✗"}
            </span>{" "}
            {visibleControls(c.label)}
            {c.detail !== null && <span className="muted"> ({visibleControls(c.detail)})</span>}
          </li>
        ))}
      </ul>
      <h4>What this means</h4>
      <p>{visibleControls(g.learn)}</p>
      {openLearn && (
        <p>
          <button type="button" className="link" aria-describedby={headingId} onClick={() => openLearn(GATE_TOPIC[g.id])}>
            Learn more
          </button>
        </p>
      )}
      {readOnly ? (
        <>
          <p className="gate-ack">{g.acknowledgement}</p>
          {whoMaySign}
          <p className="note">Decide in the strip above</p>
        </>
      ) : (
        <>
          <label className="gate-ack">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => {
                setAcknowledged(e.target.checked);
                reset();
              }}
            />
            {g.acknowledgement}
          </label>
          {whoMaySign}
          {!signable && <p className="note">You cannot sign this gate. It needs {needs}.</p>}
          {!g.met && (
            <div className="gate-reason">
              <label>
                Why are you proceeding anyway?
                <textarea
                  value={reason}
                  maxLength={REASON_MAX}
                  rows={2}
                  aria-describedby={hintId}
                  onChange={(e) => {
                    setReason(e.target.value);
                    reset();
                  }}
                />
              </label>
              <span id={hintId} className="hint">
                At least {REASON_MIN} characters
              </span>
            </div>
          )}
          <div className="decision-actions">
            {g.met ? (
              <button
                type="button"
                aria-pressed={chosen === "sign_off"}
                disabled={blocked || !acknowledged}
                title={roleTitle}
                onClick={() => decide("sign_off")}
              >
                Sign off
              </button>
            ) : (
              <button
                type="button"
                aria-pressed={chosen === "waive"}
                disabled={blocked || !acknowledged || trimmed.length < REASON_MIN}
                title={roleTitle}
                onClick={() => decide("waive")}
              >
                Waive
              </button>
            )}
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}
      {chosen !== null && <p className="note">{chosen === "sign_off" ? "Signed off" : "Waived"}: the move below records it.</p>}
    </article>
  );
}

type Props = {
  gate: GatePrompt;
  onResolve: (decisions: GateDecisionInput[]) => Promise<boolean>;
  onCancel: () => void;
  /** Shows the gates without controls or the move, pointing to the strip: for a copy of the strip's prompt. */
  readOnly?: boolean;
  /** Moves focus to the first waiting gate when the prompt appears or its checklist changes; off for a second copy. */
  autoFocus?: boolean;
} & AccessProps;

/** A gated move in the Needs-you strip: one card per gate waiting on the Owner, the passed ones in a line each, and the move. */
export function GateCards({ gate, onResolve, onCancel, readOnly = false, autoFocus = !readOnly, ...access }: Props) {
  // Keyed by refusal, gate, outcome and which conditions hold: a gate whose checklist changed, or any gate after the
  // server refused the decisions, starts over with no decision, acknowledgement or reason.
  const [decisions, setDecisions] = useState<Record<string, GateDecisionInput>>({});
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const keyOf = (g: GateEvaluation) =>
    `${gate.revision}:${g.id}:${g.outcome}:${g.conditions.map((c) => (c.met ? "1" : "0")).join("")}`;
  const passed = gate.evaluations.filter((g) => g.outcome === "pass");
  const waiting = gate.evaluations.filter((g) => g.outcome !== "pass");
  const chosen = waiting.map((g) => decisions[keyOf(g)]);
  const ready = chosen.every((d) => d !== undefined);
  const title = visibleControls(gate.cardTitle);
  const checklist = waiting.map(keyOf).join("|");

  // When the prompt appears (it is keyed by card and stage) and whenever its checklist changes, move focus to the
  // first gate, so a keyboard or screen reader user lands on what needs them.
  useEffect(() => {
    if (autoFocus) rootRef.current?.querySelector<HTMLElement>(".gate-card h3")?.focus();
  }, [checklist, autoFocus]);

  return (
    <div className="gate-prompt" ref={rootRef}>
      {passed.map((g) => (
        <p key={g.id} className="gate-passed">
          Passed: {visibleControls(g.title)}
        </p>
      ))}
      {waiting.map((g) => (
        <GateCard
          key={keyOf(g)}
          evaluation={g}
          cardTitle={gate.cardTitle}
          to={gate.to}
          onCancel={onCancel}
          readOnly={readOnly}
          {...access}
          onDecision={(d) =>
            setDecisions((prev) => {
              const { [keyOf(g)]: _dropped, ...rest } = prev;
              return d === null ? rest : { ...rest, [keyOf(g)]: d };
            })
          }
        />
      ))}
      {readOnly ? (
        // The strip's copy announces the note; this one only shows it.
        gate.note !== null && <p className="note">{gate.note}</p>
      ) : (
        <>
          {/* Always mounted, so a note that appears later is announced. */}
          <p className="note" role="status">
            {gate.note ?? ""}
          </p>
          <div className="gate-footer">
            <button
              type="button"
              disabled={!ready || busy || gate.refreshing}
              onClick={() => {
                setBusy(true);
                void onResolve(chosen.filter((d): d is GateDecisionInput => d !== undefined)).finally(() => setBusy(false));
              }}
            >
              Move "{title}" to {stageLabel(gate.to)}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
