import { useCallback, useEffect, useRef, useState } from "react";
import { DEVICES, DEVICE_IDS, PREVIEW_LIMITS, adapterLabel, atLeast, failureSentence, jobTitle } from "@theterminal/shared";
import type { DeviceId, NativeTools, PreviewKind, PreviewPlan, PreviewView } from "@theterminal/shared";
import { ApiError, api, errorMessage } from "../api";
import { ProgressBar, StepChecklist, progressKey } from "../components/ProgressBar";
import { roleOf, useShell } from "../shell/model";
import { AppPreview } from "./AppPreview";
import { ConfirmPreviewDialog } from "./ConfirmPreviewDialog";
import { DeviceStage } from "./DeviceStage";
import { CANNOT_RUN } from "./who";
import { isDesktop, useLiveViews } from "./live-views";
import { loadPreviewPrefs, rotateAll, savePreviewPrefs, toggleDevice } from "./preview-store";
import type { PreviewPrefs } from "./preview-store";
import "./preview.css";

/** The tab tells the server it is still watched this often; 30 minutes without it stops the preview. */
const SEEN_MS = 60_000;
/** While a preview is starting, its view is read again this often, besides on its ledger entries. */
const POLL_MS = 2_000;

const isLive = (v: PreviewView | null): v is PreviewView => v !== null && (v.state === "requested" || v.state === "starting" || v.state === "ready");

const KIND_LABELS: Record<PreviewKind, string> = { web: "Website", ios: "iOS", android: "Android" };

/**
 * What the switch offers: the website when the run offered one, and both phone platforms when it offered an app
 * (The Terminal detects the project when the marker named the other one).
 */
export function previewChoices(offers: readonly PreviewKind[]): PreviewKind[] {
  const app = offers.includes("ios") || offers.includes("android");
  if (!app) return ["web"];
  return [...(offers.includes("web") ? (["web"] as const) : []), "ios", "android"];
}

/** The rest of the dialog's state: the plan shown, and why it is shown again. */
type Confirm = { plan: PreviewPlan; notice: string | null };

/** True while the element is on screen (dockview hides the tabs behind the active one). */
function useOnScreen(el: HTMLElement | null): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setOn(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, [el]);
  return on;
}

/** The Preview tab (`preview:<runId>`): a run's website on phone, tablet and laptop sizes. */
export function PreviewPanel({ id }: { id: string }) {
  const { model } = useShell();
  const runId = id.slice("preview:".length);
  const run = model.runs.find((r) => r.id === runId) ?? null;
  const homeRun = [...(model.home.data?.working ?? []), ...(model.home.data?.finishedToday ?? [])].find((h) => h.run.id === runId) ?? null;
  const title = run ? jobTitle(run) : homeRun ? homeRun.title : "job";
  const agent = adapterLabel((run ?? homeRun?.run)?.adapter);

  const [prefs, setPrefs] = useState<PreviewPrefs>(loadPreviewPrefs);
  const [view, setView] = useState<PreviewView | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  /** Desktop app with a host for device views: null until the server answered. */
  const [liveHost, setLiveHost] = useState<boolean | null>(() => (isDesktop() ? null : false));
  const [frames, setFrames] = useState<Map<DeviceId, HTMLElement>>(() => new Map());
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const onScreen = useOnScreen(root);

  // Website, iOS or Android. The choices only grow, so an app being built is never unmounted by a Home reload.
  const offers = homeRun?.offers ?? [];
  const offered = previewChoices(offers);
  const [choices, setChoices] = useState<PreviewKind[]>(offered);
  const offeredKey = offered.join(",");
  useEffect(() => {
    setChoices((c) => {
      if (offered.every((k) => c.includes(k))) return c;
      // The website shown only because nothing was offered yet gives way, unless it is already in use.
      const keep = c.length === 1 && c[0] === "web" && view === null ? [] : c;
      return previewChoices([...new Set([...keep, ...offered])]);
    });
  }, [offeredKey]);
  const [picked, setPicked] = useState<PreviewKind | null>(null);
  // Until the person picks, the first thing the run offered.
  const active: PreviewKind = picked !== null && choices.includes(picked) ? picked : (choices.find((k) => offers.includes(k)) ?? choices[0]!);
  const visible = onScreen && active === "web";
  const appKinds = choices.filter((k): k is "ios" | "android" => k !== "web");
  /** A live app of this run found when the tab opened. */
  const [followed, setFollowed] = useState<PreviewView | null>(null);

  // The Owner's tool detection, read once when the tab shows an app.
  const owner = roleOf(model) === "owner";
  /** Starting, stopping and screenshotting are for the Owner and maintainers; the server also checks the run's starter. */
  const canRun = atLeast(roleOf(model), "maintainer");
  const [tools, setTools] = useState<NativeTools | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const wantTools = owner && appKinds.length > 0;
  useEffect(() => {
    if (!wantTools) return;
    let on = true;
    api.nativeTools().then(
      (t) => on && setTools(t),
      (e) => on && setToolsError(errorMessage(e, "preview")),
    );
    return () => {
      on = false;
    };
  }, [wantTools]);

  const previewId = view?.id ?? null;
  const ready = view?.state === "ready" ? view : null;

  const changePrefs = (next: PreviewPrefs) => {
    setPrefs(next);
    savePreviewPrefs(next);
  };

  useEffect(() => {
    if (liveHost !== null) return;
    let on = true;
    api.hostCapabilities().then(
      (c) => on && setLiveHost(c.previewViews),
      () => on && setLiveHost(false),
    );
    return () => {
      on = false;
    };
  }, [liveHost]);

  // A preview of this run already live (started earlier, or in another tab): follow it.
  const livePreviewId = homeRun?.livePreviewId ?? null;
  useEffect(() => {
    if (livePreviewId === null || (view !== null && isLive(view))) return;
    let on = true;
    api.getPreview(livePreviewId).then(
      (v) => {
        if (!on) return;
        if (v.kind === "web") {
          setView(v);
          return;
        }
        setFollowed(v);
        setChoices((c) => (c.includes(v.kind) ? c : previewChoices([...c, v.kind])));
        setPicked(v.kind);
      },
      () => {},
    );
    return () => {
      on = false;
    };
  }, [livePreviewId]);

  const refresh = useCallback((pid: string) => {
    api.getPreview(pid).then(
      (v) => setView((cur) => (cur?.id === v.id ? v : cur)),
      () => {},
    );
  }, []);

  // Its ledger entries (started, progress, ready, failed, stopped) bring the view up to date.
  useEffect(() => {
    if (previewId === null) return;
    return model.subscribeEntries((e) => {
      if (!e.type.startsWith("preview.")) return;
      const p = e.payload as { previewId?: unknown } | null;
      if (p?.previewId === previewId) refresh(previewId);
    });
  }, [previewId, model.subscribeEntries, refresh]);

  // While it starts, read it again now and then: build counts are kept in memory only, not in the ledger.
  const starting = view !== null && (view.state === "requested" || view.state === "starting");
  useEffect(() => {
    if (!starting || previewId === null) return;
    const t = setInterval(() => refresh(previewId), POLL_MS);
    return () => clearInterval(t);
  }, [starting, previewId, refresh]);

  // Tell the server the tab still shows it, so it is not stopped as idle.
  const live = isLive(view);
  useEffect(() => {
    if (!live || previewId === null) return;
    const t = setInterval(() => {
      api.previewSeen(previewId).catch(() => {});
    }, SEEN_MS);
    return () => clearInterval(t);
  }, [live, previewId]);

  // Closing the tab stops the preview. The stop waits a tick, so a remount of the same tab (React's development
  // double mount) keeps it.
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

  useLiveViews({ previewId: ready && liveHost === true ? ready.id : null, frames, rotated: prefs.rotated, visible });

  const start = async (plan: PreviewPlan) => {
    setBusy(true);
    try {
      const v = await api.startPreview(runId, { kind: "web", key: plan.key });
      setConfirm(null);
      setReload(0);
      setView(v);
    } catch (e) {
      if (e instanceof ApiError && e.code === "preview_changed") {
        // The agent changed the command or package.json: show what will run now, and ask again.
        const notice = errorMessage(e, "preview");
        try {
          setConfirm({ plan: await api.previewPlan(runId, "web"), notice });
        } catch (again) {
          setConfirm(null);
          setError(errorMessage(again, "preview"));
        }
      } else {
        setConfirm(null);
        setError(errorMessage(e, "preview"));
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
      plan = await api.previewPlan(runId, "web");
    } catch (e) {
      setError(errorMessage(e, "preview"));
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
      setError(errorMessage(e, "preview"));
    }
  };

  const doReload = () => {
    if (ready && liveHost) api.previewViews({ previewId: ready.id, action: "reload", devices: [] }).catch(() => {});
    else setReload((k) => k + 1);
  };

  const screenshotAll = async () => {
    if (!ready) return;
    setError(null);
    setStatus(null);
    try {
      const { screenshots } = await api.takeScreenshots(ready.id);
      setStatus(screenshots.length === 1 ? "Saved 1 screenshot on the job." : `Saved ${screenshots.length} screenshots on the job.`);
    } catch (e) {
      setError(errorMessage(e, "preview"));
    }
  };

  const origin = ready?.origin ?? null;
  const count = prefs.devices.length;

  return (
    <section className="preview-panel" ref={setRoot} aria-label="Preview">
      <header className="preview-top">
        <span className="preview-word">
          PREVIEW · <b>{title}</b>
          {active !== "web" && " · Phone app"}
        </span>
        {choices.length > 1 && (
          <div className="preview-kinds" role="group" aria-label="What to preview">
            {choices.map((k) => (
              <button key={k} type="button" aria-pressed={active === k} onClick={() => setPicked(k)}>
                {KIND_LABELS[k]}
              </button>
            ))}
          </div>
        )}
        {origin && active === "web" && (
          <a className="preview-open" href={origin} target="_blank" rel="noreferrer noopener">
            Open in my browser ↗
          </a>
        )}
      </header>

      <div className="preview-web" hidden={active !== "web"}>
        {ready && (
          <div className="preview-bar">
            <div className="preview-devices" role="group" aria-label="Devices">
              {DEVICE_IDS.map((d) => {
                const on = prefs.devices.includes(d);
                const full = !on && count >= PREVIEW_LIMITS.maxDevices;
                const last = on && count === 1;
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    disabled={full || last}
                    title={full ? "Up to 4 devices" : last ? "Keep at least one device" : undefined}
                    onClick={() => changePrefs(toggleDevice(prefs, d))}
                  >
                    {DEVICES[d].label}
                  </button>
                );
              })}
            </div>
            <span className="preview-origin">
              <span className="preview-live">● live</span> · from “{title}” ({agent})
            </span>
            <button type="button" className="quiet" onClick={doReload}>
              ⟳ Reload
            </button>
            <button type="button" className="quiet" onClick={() => changePrefs(rotateAll(prefs))}>
              ⤾ Rotate
            </button>
            {canRun &&
              (liveHost ? (
                <button type="button" onClick={() => void screenshotAll()}>
                  Screenshot all
                </button>
              ) : (
                <span className="preview-note">Screenshots need the desktop app</span>
              ))}
            {canRun ? (
              <button type="button" className="quiet" onClick={() => void stop()}>
                Stop
              </button>
            ) : (
              <span className="preview-note">{CANNOT_RUN}</span>
            )}
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
        {ready?.exposed && <p className="preview-warning">This site may be reachable from other devices on your network</p>}

        <div className="preview-body">
          {view === null || view.state === "stopped" ? (
            <div className="preview-empty">
              <p className="preview-note">
                {view?.state === "stopped" ? "The preview stopped." : "See this job's website on phone, tablet and laptop sizes."}
              </p>
              {canRun ? (
                <button type="button" onClick={() => void begin()} disabled={busy}>
                  Preview
                </button>
              ) : (
                <p className="preview-note">{CANNOT_RUN}</p>
              )}
            </div>
          ) : view.state === "failed" ? (
            <div className="preview-failed">
              <p className="preview-error-line">{failureSentence(view.error ?? "start_failed", view.kind)}</p>
              {view.tail.length > 0 && <pre className="preview-tail">{view.tail.join("\n")}</pre>}
              {canRun ? (
                <button type="button" onClick={() => void begin()} disabled={busy}>
                  Try again
                </button>
              ) : (
                <p className="preview-note">{CANNOT_RUN}</p>
              )}
            </div>
          ) : view.state !== "ready" ? (
            <div className="preview-starting">
              <ProgressBar
                key={progressKey(view.id, view.progress.steps.length)}
                percent={view.percent}
                label="Getting the site running"
                caption={`stage ${view.progress.current ?? view.progress.done.length} of ${view.progress.steps.length}`}
              />
              <StepChecklist progress={view.progress} />
              {canRun ? (
                <button type="button" className="quiet" onClick={() => void stop()}>
                  Stop
                </button>
              ) : (
                <p className="preview-note">{CANNOT_RUN}</p>
              )}
            </div>
          ) : liveHost === null ? null : liveHost ? (
            <DeviceStage devices={prefs.devices} rotated={prefs.rotated} onFrames={setFrames} />
          ) : (
            <iframe
              className="preview-host"
              title="Device previews"
              src={`/preview/${encodeURIComponent(view.id)}?d=${prefs.devices.join(",")}&r=${prefs.rotated.join(",")}&k=${reload}`}
            />
          )}
        </div>
      </div>

      {appKinds.map((k) => (
        <div key={k} className="preview-app" hidden={active !== k}>
          <AppPreview runId={runId} kind={k} tools={tools} toolsError={toolsError} follow={followed} />
        </div>
      ))}

      {confirm && (
        <ConfirmPreviewDialog
          plan={confirm.plan}
          notice={confirm.notice}
          busy={busy}
          onStart={() => void start(confirm.plan)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </section>
  );
}
