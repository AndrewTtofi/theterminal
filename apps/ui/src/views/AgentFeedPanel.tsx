import { ADAPTER_NAMES, KIND_ICON, cost, decidedBy } from "../components/AgentPanel";
import { useShell } from "../shell/model";

/** Bottom tab: what the selected run asked for and did, newest last. */
export function AgentFeedPanel() {
  const { model } = useShell();
  const run = model.runs.find((r) => r.id === model.selectedRunId);
  if (!run) return <p className="empty">Select a run in the Agents view to follow it here.</p>;
  return (
    <section className="agent-feed" aria-label="Agent feed">
      <p className="feed-run">
        {ADAPTER_NAMES[run.adapter]}: {run.prompt} ({run.status}
        {cost(run)})
      </p>
      <ul className="run-actions" aria-label="Run actions">
        {model.runActions.map((a) => (
          <li key={a.id}>
            <span aria-hidden="true">{KIND_ICON[a.kind]}</span> {a.summary} · {a.status}
            {decidedBy(a)}
          </li>
        ))}
      </ul>
      {run.error && <p className="feed-error">Run error: {run.error}</p>}
    </section>
  );
}
