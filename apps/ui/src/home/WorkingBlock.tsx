import { useId } from "react";
import type { CSSProperties } from "react";
import { adapterLabel, atLeast, formatUsd, visibleControls } from "@theterminal/shared";
import type { HomeRun } from "@theterminal/shared";
import { ProgressBar, StepChecklist, progressKey } from "../components/ProgressBar";
import { Screenshots } from "../components/Screenshots";
import { roleOf, useShell } from "../shell/model";
import { decisionSentence } from "./ApprovalsBlock";

/** Whole minutes since `startedAt`, never negative. */
export function elapsedMinutes(startedAt: string, now = Date.now()): number {
  const t = Date.parse(startedAt);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now - t) / 60_000));
}

/** Opens the run's plain-language timeline tab. */
export function useOpenTimeline() {
  const { dock } = useShell();
  return (h: HomeRun) => dock()?.open(`timeline:${h.run.id}`, visibleControls(h.title), "main");
}

/** Preview, on a run that offered a website or an app: opens its Preview tab (reviewers and above see previews). */
export function PreviewButton({ h }: { h: HomeRun }) {
  const { model } = useShell();
  if ((h.offers ?? []).length === 0 || !atLeast(roleOf(model), "reviewer")) return null;
  return (
    <button type="button" className="quiet card-preview" onClick={() => model.openPreview(h.run.id)}>
      Preview
    </button>
  );
}

function RunCard({ h, showProject }: { h: HomeRun; showProject: boolean }) {
  const { model } = useShell();
  const open = useOpenTimeline();
  const titleId = useId();
  const title = visibleControls(h.title);
  const pending = model.pending.find((a) => a.runId === h.run.id);
  const why = h.reason ?? (pending ? decisionSentence(model, pending) : "a decision");
  const plan = h.run.progress && h.run.progress.steps.length > 0 ? h.run.progress : null;
  const cost = h.run.costUsd === null ? "cost so far unknown" : formatUsd(h.run.costUsd);
  return (
    <article
      className={`home-card${h.waiting ? " waiting" : ""}`}
      aria-labelledby={titleId}
      // The whole card opens the timeline for a pointer; the title is the keyboard's button.
      onClick={(e) => {
        if (!(e.target instanceof HTMLElement) || !e.target.closest("button, a")) open(h);
      }}
    >
      {showProject && <span className="card-project">{visibleControls(h.projectName)}</span>}
      <h3 className="card-title">
        <button type="button" id={titleId} className="link" onClick={() => open(h)}>
          {title}
        </button>
      </h3>
      <ProgressBar key={progressKey(h.run.id, h.run.progress?.steps.length ?? 0)} percent={h.percent} label={title} />
      {h.waiting && <p className="card-waiting">Waiting for you: {why}</p>}
      {plan ? (
        <StepChecklist progress={plan} />
      ) : (
        h.now !== null && !h.waiting && (
          <p className="card-now">
            <span>Now:</span> {h.now}
          </p>
        )
      )}
      <Screenshots shots={h.screenshots ?? []} max={3} />
      <div className="card-foot">
        <p className="card-meta">
          {adapterLabel(h.run.adapter)} · {elapsedMinutes(h.run.startedAt)} min · {cost}
        </p>
        <PreviewButton h={h} />
      </div>
    </article>
  );
}

/** Working now: one card per running run (amber while it waits on you), in one or two columns. */
export function WorkingBlock({ runs, columns, allProjects }: { runs: HomeRun[]; columns: 1 | 2; allProjects: boolean }) {
  const headingId = useId();
  return (
    <section className="home-block home-working" aria-labelledby={headingId}>
      <h2 id={headingId}>Working now{allProjects ? " · every project" : ""}</h2>
      <div className="home-cards" style={{ "--home-columns": String(columns) } as CSSProperties}>
        {runs.length === 0 ? (
          <p className="home-empty">No agent is working right now.</p>
        ) : (
          runs.map((h) => <RunCard key={h.run.id} h={h} showProject={allProjects} />)
        )}
      </div>
    </section>
  );
}
