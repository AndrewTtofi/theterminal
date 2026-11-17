import { useSyncExternalStore } from "react";

let count = 0;
const listeners = new Set<() => void>();

/** Marks an overlay (dialog, menu, toast) as open; the returned function releases it, and only the first call counts. */
export function pushOverlay(): () => void {
  count += 1;
  for (const l of [...listeners]) l();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    count -= 1;
    for (const l of [...listeners]) l();
  };
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** True while any overlay is open: device views over the Preview tab hide meanwhile. */
export function useOverlayOpen(): boolean {
  return useSyncExternalStore(subscribe, () => count > 0, () => false);
}
