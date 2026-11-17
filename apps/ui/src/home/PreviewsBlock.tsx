import { useEffect, useId, useState } from "react";
import { atLeast, visibleControls } from "@theterminal/shared";
import type { HomeRun, PreviewKind, PreviewState, Screenshot } from "@theterminal/shared";
import { api } from "../api";
import { Screenshots } from "../components/Screenshots";
import { roleOf, useShell } from "../shell/model";

/** How many of the selected project's screenshots show. */
const LATEST = 8;

const KIND_WORDS: Record<PreviewKind, string> = { web: "Website", ios: "iPhone app", android: "Android app" };
const STATE_WORDS: Record<PreviewState, string> = {
  requested: "starting",
  starting: "starting",
  ready: "ready",
  failed: "failed",
  stopped: "stopped",
};

/** Newest first; screenshots of the same file on two runs are both kept. */
export function latestShots(runs: HomeRun[], max: number): Screenshot[] {
  return runs
    .flatMap((h) => h.screenshots ?? [])
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, max);
}

/** One live preview: the job, what is previewed and how far it got (read from the server), and Open. */
function LiveRow({ h, canOpen }: { h: HomeRun; canOpen: boolean }) {
  const { model } = useShell();
  const id = h.livePreviewId!;
  const [state, setState] = useState<string>("live");
  useEffect(() => {
    let on = true;
    api.getPreview(id).then(
      (v) => on && setState(`${KIND_WORDS[v.kind]} · ${STATE_WORDS[v.state]}`),
      () => {},
    );
    return () => {
      on = false;
    };
  }, [id]);
  return (
    <li className="home-preview">
      <span className="home-preview-title">{visibleControls(h.title)}</span>
      <span className="home-preview-state">{state}</span>
      {canOpen && (
        <button type="button" className="quiet" onClick={() => model.openPreview(h.run.id)}>
          Open
        </button>
      )}
    </li>
  );
}

/** Previews: the selected project's live previews and its latest screenshots. Never a live view. */
export function PreviewsBlock() {
  const { model } = useShell();
  const headingId = useId();
  const data = model.home.data;
  const mine = [...(data?.working ?? []), ...(data?.finishedToday ?? [])].filter((h) => h.run.projectId === model.selectedId);
  const live = mine.filter((h) => typeof h.livePreviewId === "string" && h.livePreviewId !== "");
  const shots = latestShots(mine, LATEST);
  const canOpen = atLeast(roleOf(model), "reviewer");
  return (
    <section className="home-block home-previews" aria-labelledby={headingId}>
      <h2 id={headingId}>Previews</h2>
      {live.length === 0 && shots.length === 0 ? (
        <p className="home-empty">No previews yet. When an agent builds a website or an app, you can preview it here.</p>
      ) : (
        <>
          {live.length > 0 && (
            <ul className="home-preview-list">
              {live.map((h) => (
                <LiveRow key={h.run.id} h={h} canOpen={canOpen} />
              ))}
            </ul>
          )}
          <Screenshots shots={shots} max={LATEST} captions />
        </>
      )}
    </section>
  );
}
