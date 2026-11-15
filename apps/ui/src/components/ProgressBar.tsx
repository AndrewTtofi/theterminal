import { progressPercent } from "@theterminal/shared";
import type { RunProgress } from "@theterminal/shared";
import "./progress.css";

/**
 * A run's progress as the agent reports it. A number draws a progressbar; `null` (no plan) shows "Working…" with no
 * number and no progressbar value, because a made-up percentage would be fake progress.
 */
export function ProgressBar({ percent, label }: { percent: number | null; label: string }) {
  if (percent === null) {
    return (
      <div className="progress progress-indeterminate">
        <span className="progress-text" role="status">Working…</span>
      </div>
    );
  }
  return (
    <div className="progress">
      <div className="progress-track" role="progressbar" aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="progress-text">{percent}%</span>
      <span className="progress-caption">as the agent reports it</span>
    </div>
  );
}

/** The agent's plan: each step done (✓), current, or to do. */
export function StepChecklist({ progress }: { progress: RunProgress }) {
  return (
    <ol className="step-checklist">
      {progress.steps.map((text, i) => {
        const n = i + 1;
        const done = progress.done.includes(n);
        const current = !done && progress.current === n;
        return (
          <li key={n} className={done ? "done" : current ? "current" : "todo"} {...(current && { "aria-current": "step" as const })}>
            {done ? <span aria-label="done">✓</span> : <span aria-hidden="true">{current ? "▸" : "○"}</span>} {text}
          </li>
        );
      })}
    </ol>
  );
}
