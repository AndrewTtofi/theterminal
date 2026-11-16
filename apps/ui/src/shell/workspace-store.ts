import { useCallback, useSyncExternalStore } from "react";

/** Per-device workspace settings: `{ showBoard }`. */
export const WORKSPACE_KEY = "tt.workspace.v1";

export type Workspace = { showBoard: boolean };

// Storage can be unavailable; keep the choice in memory when a write is refused, so the switch still works.
let mem: Workspace | null = null;
let cached: Workspace = { showBoard: false };
const listeners = new Set<() => void>();

export function loadWorkspace(): Workspace {
  if (mem) return mem;
  let showBoard = false;
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (raw !== null) showBoard = (JSON.parse(raw) as { showBoard?: unknown } | null)?.showBoard === true;
  } catch {
    // corrupt or unavailable: the default
  }
  // The same object while nothing changed, so useSyncExternalStore does not loop.
  if (cached.showBoard !== showBoard) cached = { showBoard };
  return cached;
}

export function saveWorkspace(w: Workspace): void {
  const next = { showBoard: w.showBoard === true };
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(next));
    mem = null;
    cached = next;
  } catch {
    mem = next;
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useWorkspace(): { showBoard: boolean; setShowBoard: (b: boolean) => void } {
  const w = useSyncExternalStore(subscribe, loadWorkspace);
  const setShowBoard = useCallback((b: boolean) => saveWorkspace({ showBoard: b }), []);
  return { showBoard: w.showBoard, setShowBoard };
}
