import { useId, useMemo } from "react";
import { innerEntry, jobTitle, narrate, visibleControls } from "@theterminal/shared";
import { namesRun, useShell } from "../shell/model";
import "./home.css";

/**
 * A run's summary timeline (`timeline:<runId>`): its steps narrated in plain language, oldest first, with the way to
 * the raw work one click away (Changes, the Agent feed, the Terminal). Made from the selected project's loaded stream.
 */
export function RunTimelinePanel({ id }: { id: string }) {
  const { model, dock, showView } = useShell();
  const runId = id.slice("timeline:".length);
  const headingId = useId();
  const run = model.runs.find((r) => r.id === runId) ?? model.home.data?.working.concat(model.home.data.finishedToday).find((h) => h.run.id === runId)?.run;
  const steps = useMemo(
    () =>
      model.projectEntries
        .filter((e) => namesRun(e, runId))
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({ e, n: narrate(e, model.narration) })),
    [model.projectEntries, model.narration, runId],
  );
  // The start not loaded means older steps are only in the server's history.
  const startLoaded = steps.some(({ e }) => innerEntry(e).type === "agent.started");
  const follow = (panel: "agent_feed" | "terminal") => {
    model.onFollowRun(runId);
    dock()?.focus(panel);
  };
  return (
    <section className="run-timeline" aria-labelledby={headingId}>
      <h2 id={headingId}>{run ? visibleControls(jobTitle(run)) : "Run timeline"}</h2>
      <div className="timeline-links">
        <button
          type="button"
          className="quiet"
          onClick={() => {
            model.onSelectRun(runId);
            showView("changes");
          }}
        >
          Changes
        </button>
        <button type="button" className="quiet" onClick={() => follow("agent_feed")}>
          Agent feed
        </button>
        <button type="button" className="quiet" onClick={() => follow("terminal")}>
          Terminal
        </button>
      </div>
      {!startLoaded && <p className="home-note">Open the Agents view for older steps</p>}
      {steps.length === 0 ? (
        <p className="home-empty">No steps recorded yet.</p>
      ) : (
        <ol className="timeline-steps">
          {steps.map(({ e, n }) => (
            <li key={e.id} className={n.attention ? "attention" : undefined}>
              <time dateTime={e.ts}>{new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
              <span>{n.headline}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
