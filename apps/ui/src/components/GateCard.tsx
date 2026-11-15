import { useId, useState } from "react";
import { visibleControls } from "@theterminal/shared";
import type { GateDecisionInput, GateEvaluation, Stage } from "@theterminal/shared";
import type { GatePrompt } from "../shell/model";
import { stageLabel } from "./Board";

/** The shortest waiver reason the server accepts, after trimming. */
const REASON_MIN = 10;
const REASON_MAX = 500;

type CardProps = {
  evaluation: GateEvaluation;
  cardTitle: string;
  to: Stage;
  /** The Owner's decision for this gate, or null once it no longer stands (the sentence unticked, the reason edited). */
  onDecision: (decision: GateDecisionInput | null) => void;
  onCancel: () => void;
};

/**
 * One readiness gate a move raised: what it is about, its checklist, and the Owner's sign-off (every condition met)
 * or waiver (a condition unmet; needs a reason). Either needs the gate's acknowledgement sentence ticked.
 */
export function GateCard({ evaluation: g, cardTitle, to, onDecision, onCancel }: CardProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState("");
  const [chosen, setChosen] = useState<"sign_off" | "waive" | null>(null);
  const hintId = useId();
  const trimmed = reason.trim();

  const reset = () => {
    setChosen(null);
    onDecision(null);
  };
  const decide = (decision: "sign_off" | "waive") => {
    setChosen(decision);
    onDecision(
      decision === "sign_off"
        ? { gateId: g.id, decision, acknowledgement: g.acknowledgement }
        : { gateId: g.id, decision, reason: trimmed, acknowledgement: g.acknowledgement },
    );
  };

  return (
    <article className="gate-card" aria-label={`Gate: ${visibleControls(g.title)}`}>
      <h3>{visibleControls(g.title)}</h3>
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
          <button type="button" aria-pressed={chosen === "sign_off"} disabled={!acknowledged} onClick={() => decide("sign_off")}>
            Sign off
          </button>
        ) : (
          <button
            type="button"
            aria-pressed={chosen === "waive"}
            disabled={!acknowledged || trimmed.length < REASON_MIN}
            onClick={() => decide("waive")}
          >
            Waive
          </button>
        )}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {chosen !== null && <p className="note">{chosen === "sign_off" ? "Signed off" : "Waived"}: the move below records it.</p>}
    </article>
  );
}

type Props = {
  gate: GatePrompt;
  onResolve: (decisions: GateDecisionInput[]) => Promise<boolean>;
  onCancel: () => void;
};

/** A gated move in the Needs-you strip: one card per gate waiting on the Owner, the passed ones in a line each, and the move. */
export function GateCards({ gate, onResolve, onCancel }: Props) {
  // Keyed by gate and outcome: a gate whose outcome changed on a refresh starts over with no decision.
  const [decisions, setDecisions] = useState<Record<string, GateDecisionInput>>({});
  const [busy, setBusy] = useState(false);
  const keyOf = (g: GateEvaluation) => `${g.id}:${g.outcome}`;
  const passed = gate.evaluations.filter((g) => g.outcome === "pass");
  const waiting = gate.evaluations.filter((g) => g.outcome !== "pass");
  const chosen = waiting.map((g) => decisions[keyOf(g)]);
  const ready = chosen.every((d) => d !== undefined);
  const title = visibleControls(gate.cardTitle);

  return (
    <div className="gate-prompt">
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
          onDecision={(d) =>
            setDecisions((prev) => {
              const { [keyOf(g)]: _dropped, ...rest } = prev;
              return d === null ? rest : { ...rest, [keyOf(g)]: d };
            })
          }
        />
      ))}
      {gate.note !== null && (
        <p className="note" role="status">
          {gate.note}
        </p>
      )}
      <div className="gate-footer">
        <button
          type="button"
          disabled={!ready || busy}
          onClick={() => {
            setBusy(true);
            void onResolve(chosen.filter((d): d is GateDecisionInput => d !== undefined)).finally(() => setBusy(false));
          }}
        >
          Move "{title}" to {stageLabel(gate.to)}
        </button>
      </div>
    </div>
  );
}
