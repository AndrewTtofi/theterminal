import { useId } from "react";
import { visibleControls } from "@theterminal/shared";
import type { HomeRun, RunStatus } from "@theterminal/shared";
import { AcceptChanges } from "../components/AcceptChanges";
import { Screenshots } from "../components/Screenshots";
import { PreviewButton } from "./WorkingBlock";

const OUTCOME: Record<Exclude<RunStatus, "running">, string> = { completed: "done", failed: "failed", stopped: "stopped" };

/**
 * Finished today: the title, the final summary and the outcome of each run that ended today, with Accept these changes
 * (or Accepted) beside it. Never diffs or output.
 */
export function FinishedBlock({ runs, allProjects }: { runs: HomeRun[]; allProjects: boolean }) {
  const headingId = useId();
  return (
    <section className="home-block home-finished" aria-labelledby={headingId}>
      <h2 id={headingId}>Finished today{allProjects ? " · every project" : ""}</h2>
      {runs.length === 0 ? (
        <p className="home-empty">Nothing has finished today.</p>
      ) : (
        <ul className="home-finished-list">
          {runs.map((h) => {
            const outcome = h.run.status === "running" ? "working" : OUTCOME[h.run.status];
            return (
              <li key={h.run.id} className={`outcome-${outcome}`}>
                {allProjects && <span className="card-project">{visibleControls(h.projectName)}</span>}
                <span className="finished-line">
                  {`${visibleControls(h.title)}${h.summary !== null ? ` — ${visibleControls(h.summary)}` : ""} — ${outcome}`}
                </span>
                <Screenshots shots={h.screenshots ?? []} max={3} />
                <PreviewButton h={h} />
                <span className="finished-accept">
                  <AcceptChanges run={h.run} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
