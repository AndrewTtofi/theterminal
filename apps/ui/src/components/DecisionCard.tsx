import { useState } from "react";
import type { AgentAction } from "@theterminal/shared";
import { ApiError } from "../api";

type Props = {
  action: AgentAction;
  onDecide: (id: string, decision: "allow" | "deny", reason?: string) => Promise<unknown> | void;
};

export function DecisionCard({ action, onDecide }: Props) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const decide = async (decision: "allow" | "deny", why?: string) => {
    setNote(null);
    try {
      await (why ? onDecide(action.id, decision, why) : onDecide(action.id, decision));
    } catch (e) {
      setNote(e instanceof ApiError && e.status === 409 ? "Already decided" : "Something went wrong");
    }
  };

  return (
    <article className="decision-card" aria-label={`Decision: ${action.summary}`}>
      <h3>Agent wants to: {action.summary}</h3>
      <details>
        <summary>Details</summary>
        <pre>{JSON.stringify(action.input, null, 2)}</pre>
      </details>
      {denying ? (
        <div className="decision-actions">
          <label>
            Reason (optional)
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button type="button" onClick={() => void decide("deny", reason.trim())}>
            Confirm deny
          </button>
          <button type="button" onClick={() => setDenying(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="decision-actions">
          <button type="button" onClick={() => void decide("allow")}>
            Allow
          </button>
          <button type="button" onClick={() => setDenying(true)}>
            Deny
          </button>
        </div>
      )}
      {note && <p role="status">{note}</p>}
    </article>
  );
}
