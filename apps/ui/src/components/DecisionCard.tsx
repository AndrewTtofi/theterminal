import { useState } from "react";
import type { AgentAction } from "@theterminal/shared";
import { ApiError } from "../api";

type Props = {
  action: AgentAction;
  onDecide: (id: string, decision: "allow" | "deny", reason?: string) => Promise<unknown> | void;
};

/** For an input the core recorded as truncated, how many characters the card cannot show; else null. */
function hiddenChars(input: unknown): number | null {
  if (typeof input !== "object" || input === null) return null;
  const { truncated, totalChars, preview } = input as { truncated?: unknown; totalChars?: unknown; preview?: unknown };
  if (truncated !== true || typeof totalChars !== "number") return null;
  const shown = typeof preview === "string" ? preview.replace(/…\[truncated\]$/, "").length : 0;
  return Math.max(0, totalChars - shown);
}

export function DecisionCard({ action, onDecide }: Props) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const decide = async (decision: "allow" | "deny", why?: string) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await (why ? onDecide(action.id, decision, why) : onDecide(action.id, decision));
    } catch (e) {
      setNote(e instanceof ApiError && e.status === 409 ? "Already decided" : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const hidden = hiddenChars(action.input);

  return (
    <article className="decision-card" aria-label={`Decision: ${action.summary}`}>
      <h3>Agent wants to: {action.summary}</h3>
      <details>
        <summary>Details</summary>
        <pre>{JSON.stringify(action.input, null, 2)}</pre>
      </details>
      {hidden !== null && <p className="note">{hidden} characters hidden — full input not shown</p>}
      {denying ? (
        <div className="decision-actions">
          <label>
            Reason (optional)
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button type="button" disabled={busy} onClick={() => void decide("deny", reason.trim())}>
            Confirm deny
          </button>
          <button type="button" onClick={() => setDenying(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="decision-actions">
          <button type="button" disabled={busy} onClick={() => void decide("allow")}>
            Allow
          </button>
          <button type="button" disabled={busy} onClick={() => setDenying(true)}>
            Deny
          </button>
        </div>
      )}
      {note && <p role="status">{note}</p>}
    </article>
  );
}
