import { useEffect, useRef, useState } from "react";
import { ApiError, errorMessage } from "../api";
import type { DockPanelId } from "../shell/Dock";
import { namesRun, useShell } from "../shell/model";

/**
 * Loads one file's data for a `diff:` or `file:` tab on mount, and again on every agent.* or override.* entry
 * naming its run (one load in flight, one more queued). A 404 `not_found` asks whether the run still exists: when
 * the server no longer knows it, the tab closes quietly, as stale tabs are pruned on load; otherwise the failure
 * is worded for the Owner and the last data loaded stays.
 */
export function useRunData<T>(
  panelId: string,
  target: { runId: string; path: string } | null,
  load: (runId: string, path: string) => Promise<T>,
): { data: T | null; error: string | null } {
  const { model, dock } = useShell();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const existsRef = useRef(model.runExists);
  existsRef.current = model.runExists;
  const dockRef = useRef(dock);
  dockRef.current = dock;
  const runId = target?.runId ?? null;
  const path = target?.path ?? null;
  const subscribe = model.subscribeEntries;

  useEffect(() => {
    if (runId === null || path === null) return;
    let cancelled = false;
    let inFlight = false;
    let again = false;
    const run = async (): Promise<void> => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      try {
        const d = await loadRef.current(runId, path);
        if (cancelled) return;
        setData(d);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404 && e.code === "not_found" && !(await existsRef.current(runId).catch(() => true))) {
          if (!cancelled) dockRef.current()?.closeQuietly(panelId as DockPanelId);
          return;
        }
        if (!cancelled) setError(errorMessage(e));
      } finally {
        inFlight = false;
        if (again && !cancelled) {
          again = false;
          void run();
        }
      }
    };
    void run();
    const unsubscribe = subscribe((e) => {
      if (namesRun(e, runId)) void run();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [panelId, runId, path, subscribe]);

  return { data, error };
}
