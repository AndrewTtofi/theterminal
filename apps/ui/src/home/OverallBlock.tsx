import { useId } from "react";
import { overallProgress } from "@theterminal/shared";
import type { HomeRun } from "@theterminal/shared";
import { ProgressBar } from "../components/ProgressBar";

/**
 * Overall progress: done steps over all steps of the running runs that stated a plan. Runs without a plan add nothing
 * to the number and are counted beside it, so nothing is estimated.
 */
export function OverallBlock({ runs }: { runs: HomeRun[] }) {
  const headingId = useId();
  const o = overallProgress(runs.map((h) => h.run));
  return (
    <section className="home-block home-overall" aria-labelledby={headingId}>
      <h2 id={headingId}>Overall progress</h2>
      {o.withPlan === 0 && o.withoutPlan === 0 ? (
        <p className="home-empty">Nothing is running.</p>
      ) : (
        <>
          {o.withPlan > 0 && <ProgressBar percent={o.percent} label="Overall progress" />}
          {o.withoutPlan > 0 && <p className="home-note">{o.withoutPlan} working without a plan</p>}
        </>
      )}
    </section>
  );
}
