import { useCallback, useEffect, useId, useRef, useState } from "react";
import { atLeast, failureSentence } from "@theterminal/shared";
import type { NativeTools, PreviewPlan, PreviewView, Screenshot } from "@theterminal/shared";
import { ApiError, api, errorMessage } from "../api";
import { ProgressBar } from "../components/ProgressBar";
import { Screenshots } from "../components/Screenshots";
import { roleOf, useShell } from "../shell/model";
import { ConfirmPreviewDialog } from "./ConfirmPreviewDialog";
import { CANNOT_RUN } from "./who";
import { ToolsBox } from "./ToolsBox";
import "./preview.css";

/** The tab tells the server it is still watched this often; 30 minutes without it stops the app. */
const SEEN_MS = 60_000;
/** While the app is being built and started, its view is read again this often (build counts live in memory only). */
const POLL_MS = 2_000;
/** How many of the run's latest screenshots show beside the progress. */
const SHOTS = 5;

type AppKind = "ios" | "android";

const isLive = (v: PreviewView | null): v is PreviewView => v !== null && (v.state === "requested" || v.state === "starting" || v.state === "ready");

/** When this tab saw each stage begin and end, in its own clock; a stage it did not see begin has no duration. */
export type StageTimes = Record<number, { began?: number; ended?: number }>;

/**
 * Records stage changes between two readings of the same preview. A stage's start is known only when this tab saw it
 * become current, or for the first stage from the preview's own start; durations are never guessed.
 */
export function trackStages(times: StageTimes, prev: PreviewView | null, next: PreviewView, now: number): StageTimes {
  const out: StageTimes = { ...times };
  const { done, current } = next.progress;
  if (current !== null && out[current]?.began === undefined) {
    if (prev === null) {
      const start = Date.parse(next.startedAt);
      if (current === 1 && done.length === 0 && !Number.isNaN(start)) out[1] = { began: Math.min(start, now) };
    } else if (prev.progress.current !== current && !prev.progress.done.includes(current)) {
      out[current] = { began: now };
    }
  }
  for (const n of done) {
    const t = out[n];
    if (t?.began !== undefined && t.ended === undefined) out[n] = { ...t, ended: now };
  }
  return out;
}

/** "8s", "1m 12s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

type Props = {
  runId: string;
  kind: AppKind;
  /** The Owner's tool detection, read once by the tab; null while unknown or for anyone else. */
  tools: NativeTools | null;
  toolsError?: string | null;
  /** A live app preview of this run the tab found when it opened; followed when it is of this kind. */
  follow?: PreviewView | null;
};

/**
 * A run's phone app in Apple's or Google's simulator: the person confirms the exact commands, The Terminal builds,
 * starts the simulator, installs and opens the app, and the stages show as real progress. The app itself is used in
 * the simulator's own window; screenshots land on the job.
 */
export function AppPreview({ runId, kind, tools, toolsError = null, follow = null }: Props) {
  const { model } = useShell();
  const canRun = atLeast(roleOf(model), "maintainer");
  const [view, setView] = useState<PreviewView | null>(null);
  const [times, setTimes] = useState<StageTimes>({});
  const [confirm, setConfirm] = useState<{ plan: PreviewPlan; notice: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [shots, setShots] = useState<Screenshot[]>([]);
  const last = useRef<PreviewView | null>(null);
  const headingId = useId();

  const previewId = view?.id ?? null;

  /** Shows a reading of a preview; a reading of another preview than the current one starts the stage times afresh. */
  const show = useCallback((v: PreviewView) => {
    const prev = last.current?.id === v.id ? last.current : null;
    const now = Date.now();
    setTimes((t) => trackStages(prev === null ? {} : t, prev, v, now));
    last.current = v;
    setView(v);
  }, []);

  const refresh = useCallback(
    (pid: string) => {
      api.getPreview(pid).then(
        (v) => {
          if (last.current?.id === v.id) show(v);
        },
        () => {},
      );
    },
    [show],
  );

  const loadShots = useCallback(() => {
    api.runScreenshots(runId).then(
      (r) => setShots([...r.screenshots].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))),
      () => {},
    );
  }, [runId]);
  useEffect(loadShots, [loadShots]);

  // A live app the tab found when it opened.
  useEffect(() => {
    if (follow === null || follow.kind !== kind || follow.runId !== runId) return;
    if (isLive(last.current)) return;
    show(follow);
  }, [follow, kind, runId, show]);

  // Its ledger entries bring it up to date; a new screenshot of the run reloads the thumbnails.
  useEffect(
    () =>
      model.subscribeEntries((e) => {
        if (!e.type.startsWith("preview.")) return;
        const p = e.payload as { previewId?: unknown; runId?: unknown } | null;
        if (e.type === "preview.screenshot" && p?.runId === runId) loadShots();
        if (previewId !== null && p?.previewId === previewId) refresh(previewId);
      }),
    [previewId, runId, model.subscribeEntries, refresh, loadShots],
  );

  const starting = view !== null && (view.state === "requested" || view.state === "starting");
  useEffect(() => {
    if (!starting || previewId === null) return;
    const t = setInterval(() => refresh(previewId), POLL_MS);
    return () => clearInterval(t);
  }, [starting, previewId, refresh]);

  const live = isLive(view);
  useEffect(() => {
    if (!live || previewId === null) return;
    const t = setInterval(() => {
      api.previewSeen(previewId).catch(() => {});
    }, SEEN_MS);
    return () => clearInterval(t);
  }, [live, previewId]);

  // Closing the tab stops the app; the stop waits a tick so a remount of the same tab keeps it.
  const liveIdRef = useRef<string | null>(null);
  liveIdRef.current = live ? previewId : null;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const pid = liveIdRef.current;
      if (pid === null) return;
      setTimeout(() => {
        if (!mounted.current) api.stopPreview(pid, "tab_closed").catch(() => {});
      }, 0);
    };
  }, []);

  const start = async (plan: PreviewPlan) => {
    setBusy(true);
    try {
      const v = await api.startPreview(runId, { kind, key: plan.key });
      setConfirm(null);
      show(v);
    } catch (e) {
      if (e instanceof ApiError && e.code === "preview_changed") {
        const notice = errorMessage(e);
        try {
          setConfirm({ plan: await api.previewPlan(runId, kind), notice });
        } catch (again) {
          setConfirm(null);
          setError(errorMessage(again));
        }
      } else {
        setConfirm(null);
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const begin = async () => {
    setError(null);
    setStatus(null);
    setBusy(true);
    let plan: PreviewPlan;
    try {
      plan = await api.previewPlan(runId, kind);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      return;
    }
    setBusy(false);
    if (plan.confirmedEarlier) await start(plan);
    else setConfirm({ plan, notice: null });
  };

  const stop = async () => {
    if (previewId === null) return;
    setError(null);
    try {
      await api.stopPreview(previewId, "person");
      setView((v) => (v && v.id === previewId ? { ...v, state: "stopped" } : v));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const screenshot = async () => {
    if (view?.state !== "ready") return;
    setError(null);
    setStatus(null);
    try {
      const { screenshots } = await api.takeScreenshots(view.id);
      setStatus(screenshots.length === 1 ? "Saved 1 screenshot on the job." : `Saved ${screenshots.length} screenshots on the job.`);
      loadShots();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const shown = view !== null && view.state !== "stopped" ? view : null;
  const failed = view?.state === "failed";
  const progress = shown?.progress ?? null;
  const stageNo = progress ? (progress.current ?? progress.done.length) : 0;

  return (
    <div className="app-preview">
      <section className="app-card" aria-labelledby={headingId}>
        <h3 id={headingId}>{shown ? `Getting it running · ${shown.percent}%` : kind === "ios" ? "iPhone app" : "Android app"}</h3>
        {shown && progress ? (
          <>
            <ProgressBar key={shown.id} percent={shown.percent} label="Getting it running" caption={`stage ${stageNo} of ${progress.steps.length}`} />
            <ol className="app-stages">
              {progress.steps.map((text, i) => {
                const n = i + 1;
                const done = progress.done.includes(n);
                const current = !done && progress.current === n;
                const t = times[n];
                const took = done && t?.began !== undefined && t.ended !== undefined ? formatDuration(t.ended - t.began) : null;
                return (
                  <li key={n} className={done ? "done" : current ? "current" : "todo"} {...(current && { "aria-current": "step" as const })}>
                    <span className="app-stage-name">{text}</span>
                    {done ? (
                      <span className="app-stage-mark ok">
                        ✓{took !== null && <span className="num"> {took}</span>}
                      </span>
                    ) : current && shown.state === "failed" ? (
                      <span className="app-stage-mark failed">✕ failed</span>
                    ) : current ? (
                      <span className="app-stage-mark now">
                        ❯ starting…
                        {shown.liveCount && <span className="num"> {`${shown.liveCount.n} of ${shown.liveCount.m}`}</span>}
                      </span>
                    ) : (
                      <span className="app-stage-mark todo">○</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          <p className="preview-note">
            {view?.state === "stopped"
              ? "The app stopped."
              : `The Terminal builds this job's app, starts the ${kind === "ios" ? "iPhone simulator" : "Android emulator"} and opens the app in it.`}
          </p>
        )}

        {shown?.state === "failed" && (
          <div className="preview-failed-inline">
            <p className="preview-error-line">{failureSentence(shown.error ?? "start_failed", shown.kind)}</p>
            {shown.tail.length > 0 && <pre className="preview-tail">{shown.tail.join("\n")}</pre>}
          </div>
        )}
        {error && (
          <p className="preview-error" role="alert">
            {error}
          </p>
        )}
        {status && (
          <p className="preview-note" role="status">
            {status}
          </p>
        )}

        {!canRun && <p className="preview-note">{CANNOT_RUN}</p>}
        <div className="app-actions">
          {!canRun ? null : isLive(view) ? (
            <>
              {view.state === "ready" && (
                <button type="button" onClick={() => void screenshot()}>
                  Screenshot
                </button>
              )}
              <button type="button" className="quiet" onClick={() => void stop()}>
                Stop
              </button>
            </>
          ) : (
            <button type="button" onClick={() => void begin()} disabled={busy}>
              {failed ? "Try again" : "Run the app"}
            </button>
          )}
        </div>
        <p className="preview-note">You use the app in the simulator's own window.</p>
      </section>

      <section className="app-card app-side" aria-label="Tools and screenshots">
        <ToolsBox kind={kind} tools={tools} error={toolsError} />
        <h3>Latest screenshots</h3>
        {shots.length > 0 ? <Screenshots shots={shots} max={SHOTS} captions /> : <p className="preview-note">No screenshots yet.</p>}
      </section>

      {confirm && (
        <ConfirmPreviewDialog
          plan={confirm.plan}
          notice={confirm.notice}
          busy={busy}
          onStart={() => void start(confirm.plan)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
