import { useContext, useId, useState } from "react";
import { ACTION_KIND_MEANS, ACTION_TOPIC, actionPhrase, visibleControls } from "@theterminal/shared";
import type { AgentAction } from "@theterminal/shared";
import { ApiError } from "../api";
import { ShellContext } from "../shell/model";

type Props = {
  action: AgentAction;
  /** The project the action belongs to, shown when the card may sit beside other projects' cards. */
  projectName?: string;
  onDecide: (id: string, decision: "allow" | "deny", reason?: string) => Promise<unknown> | void;
  /** Shows the "More context" button, which opens the Needs-you tab; absent on cards already there. */
  onMore?: () => void;
  /** A copy of a card the strip shows: no Allow or Deny here, only a pointer to the strip, so it is decided once. */
  readOnly?: boolean;
  /** The linked machine the agent runs on (this computer's name for it); the decision is sent there. */
  machineName?: string;
};

/** For an input the core recorded as truncated, how many characters the card cannot show; else null. */
function hiddenChars(input: unknown): number | null {
  if (typeof input !== "object" || input === null) return null;
  const { truncated, totalChars, preview } = input as { truncated?: unknown; totalChars?: unknown; preview?: unknown };
  if (truncated !== true || typeof totalChars !== "number") return null;
  const shown = typeof preview === "string" ? preview.replace(/…\[truncated\]$/, "").length : 0;
  return Math.max(0, totalChars - shown);
}

/**
 * The full command of a shell action (the title is capped), or null. For input to a running command
 * (`codex.stdin`) it is the text that will be typed, not the command already running. Either way its control,
 * bidi and zero-width characters are made visible.
 */
function shellCommand(action: AgentAction): string | null {
  if (action.kind !== "shell" || typeof action.input !== "object" || action.input === null) return null;
  const { command, reason } = action.input as { command?: unknown; reason?: unknown };
  if (action.tool === "codex.stdin") return typeof reason === "string" ? visibleControls(reason) : null;
  return typeof command === "string" ? visibleControls(command) : null;
}

export function DecisionCard({ action, projectName, onDecide, onMore, readOnly = false, machineName }: Props) {
  // Outside the shell (a card on its own) there is no Learn view to open, so no link.
  const openLearn = useContext(ShellContext)?.openLearn;
  const headingId = useId();
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
      // Fixed words only: a linked machine's refusal is never shown as it sent it.
      setNote(
        e instanceof ApiError && e.code === "machine_unreachable" && machine !== null
          ? `Could not reach ${machine}. Your decision was not sent.`
          : e instanceof ApiError && e.status === 409 ? "Already decided" : "Something went wrong",
      );
    } finally {
      setBusy(false);
    }
  };

  const machine = machineName === undefined ? null : visibleControls(machineName);
  const hidden = hiddenChars(action.input);
  const command = shellCommand(action);

  return (
    <article className="decision-card" aria-label={`Decision: ${visibleControls(action.summary)}`}>
      {projectName !== undefined && <p className="project-name">{visibleControls(projectName)}</p>}
      <h3 id={headingId}>Agent wants to {actionPhrase(action)}</h3>
      {machine !== null && <p className="machine-note" role="status">This agent runs on {machine}. Your decision is sent there.</p>}
      <h4>What this means</h4>
      <p className="means">{ACTION_KIND_MEANS[action.kind] ?? ACTION_KIND_MEANS.other}</p>
      {(openLearn || onMore) && (
        <p className="decision-links">
          {openLearn && (
            <button
              type="button"
              className="link"
              aria-describedby={headingId}
              onClick={() => openLearn(ACTION_TOPIC[action.kind] ?? ACTION_TOPIC.other)}
            >
              Learn more
            </button>
          )}
          {onMore && (
            <button type="button" className="link" aria-describedby={headingId} onClick={onMore}>
              More context
            </button>
          )}
        </p>
      )}
      {command !== null && <pre className="command">{command}</pre>}
      <details>
        <summary>Details</summary>
        <pre>{visibleControls(JSON.stringify(action.input, null, 2) ?? "")}</pre>
      </details>
      {hidden !== null && <p className="note">{hidden} characters hidden — full input not shown</p>}
      {readOnly ? (
        <p className="note">Decide in the strip above</p>
      ) : denying ? (
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
