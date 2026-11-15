import { narrateAction, visibleControls } from "@theterminal/shared";
import type { AgentAction, LedgerEntry } from "@theterminal/shared";
import { ADAPTER_NAMES, KIND_ICON, cost, decidedBy } from "../components/AgentPanel";
import { canonicalPayload } from "../components/LedgerPanel";
import { useShell } from "../shell/model";

/** The text of an `agent.message` entry for this run, or null for any other entry. */
function messageOf(e: LedgerEntry, runId: string): string | null {
  if (e.type !== "agent.message" || typeof e.payload !== "object" || e.payload === null) return null;
  const { runId: of, text } = e.payload as { runId?: unknown; text?: unknown };
  return of === runId && typeof text === "string" ? text : null;
}

/** An action's raw record: its input, then its output when it has one. Text only. */
function rawAction(a: AgentAction): string {
  const input = canonicalPayload(a.input);
  return visibleControls(a.output ? `${input}\n\nOutput:\n${a.output}` : input);
}

/** Bottom tab: what the selected run asked for and did, newest last. */
export function AgentFeedPanel() {
  const { model } = useShell();
  const run = model.runs.find((r) => r.id === model.selectedRunId);
  if (!run) return <p className="empty">Select a run in the Agents view to follow it here.</p>;
  const messages = [...model.entries]
    .sort((a, b) => a.seq - b.seq)
    .flatMap((e) => {
      const text = messageOf(e, run.id);
      return text === null ? [] : [{ seq: e.seq, text }];
    });
  return (
    <section className="agent-feed" aria-label="Agent feed">
      <p className="feed-run">
        {ADAPTER_NAMES[run.adapter]}: {visibleControls(run.prompt)} ({run.status}
        {cost(run)})
      </p>
      <ul className="run-actions" aria-label="Run actions">
        {model.runActions.map((a) => {
          const headline = narrateAction(a).headline;
          return (
            <li key={a.id}>
              <span aria-hidden="true">{KIND_ICON[a.kind]}</span> {headline}{" "}
              <span className="action-status">
                · {a.status}
                {decidedBy(a)}
              </span>
              <details className="raw">
                <summary aria-label={`Raw record: ${headline}`}>Raw</summary>
                <pre>{rawAction(a)}</pre>
              </details>
            </li>
          );
        })}
      </ul>
      {messages.length > 0 && (
        <ul className="run-messages" aria-label="Agent messages">
          {messages.map((m) => (
            <li key={m.seq}>The agent said: {visibleControls(m.text)}</li>
          ))}
        </ul>
      )}
      {run.error && <p className="feed-error">Run error: {visibleControls(run.error)}</p>}
    </section>
  );
}
