import { useState } from "react";
import { visibleControls } from "@theterminal/shared";
import type { DecisionId, IntakeDecisionView } from "@theterminal/shared";

type Props = {
  decision: IntakeDecisionView;
  /** Resolves true when the server recorded the decision. */
  onDecide: (decisionId: DecisionId, chosen: string, rationale: string) => Promise<boolean> | void;
};

/** Who made a recorded decision, as narration names them: the workspace owner is "Owner". */
export function ownerName(owner: string): string {
  return owner === "owner" ? "Owner" : visibleControls(owner);
}

export const shortDate = (iso: string) => new Date(iso).toLocaleDateString();

/**
 * One plan decision the intake raised: the answers behind it, the options with their trade-offs and the
 * recommendation, what it means and the risk. Recorded text (answers, rationale, owner) is shown with its
 * hidden characters made visible.
 */
export function IntakeDecisionCard({ decision: d, onDecide }: Props) {
  const [chosen, setChosen] = useState<string | null>(d.chosen);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const decidedLabel = d.options.find((o) => o.id === d.chosen)?.label ?? d.chosen;
  const name = `plan-decision-${d.id}`;

  const decide = async () => {
    if (busy || chosen === null) return;
    setBusy(true);
    try {
      if ((await onDecide(d.id, chosen, why.trim())) === true) setWhy("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="decision-card intake-decision" aria-label={`Plan decision: ${d.question}`}>
      <h3>{d.question}</h3>
      {d.because.length > 0 && (
        <div className="because">
          <p>Because you answered:</p>
          <ul>
            {d.because.map((b) => (
              <li key={b.label}>
                {b.label} <q>{visibleControls(b.answer)}</q>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="intake-options">
        {d.options.map((o) => (
          <li key={o.id}>
            <label>
              <input type="radio" name={name} value={o.id} checked={chosen === o.id} onChange={() => setChosen(o.id)} />
              {o.label}
            </label>
            {o.id === d.recommended && <span className="recommended">Recommended</span>}
            <p className="tradeoffs">{o.tradeoffs}</p>
          </li>
        ))}
      </ul>
      <h4>What this means</h4>
      <p className="means">{d.learn}</p>
      <h4>Risk</h4>
      <p className="means">{d.risk}</p>
      {d.chosen !== null && d.owner !== null && d.decidedAt !== null && (
        <p className="decided">
          {`Decided by ${ownerName(d.owner)} on ${shortDate(d.decidedAt)}: ${decidedLabel}`}
          {d.rationale ? <span className="rationale">{` Why: ${visibleControls(d.rationale)}`}</span> : null}
        </p>
      )}
      <div className="decision-actions">
        <label>
          Why (optional)
          <input value={why} maxLength={1000} onChange={(e) => setWhy(e.target.value)} />
        </label>
        <button type="button" disabled={busy || chosen === null} onClick={() => void decide()}>
          Decide
        </button>
      </div>
    </article>
  );
}
