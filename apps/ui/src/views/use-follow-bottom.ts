import { useLayoutEffect, useRef, useState } from "react";

/** How far above the bottom the Owner can be and still count as following the newest items. */
const SLACK_PX = 40;

/**
 * Keeps a scrolling list's newest item in view as items arrive, unless the Owner has scrolled up more than 40 px.
 * `keys` are the items' keys, oldest first. While the Owner reads further up, `fresh` counts the items that arrived
 * since, and `jump` scrolls back to the bottom and follows again.
 */
export function useFollowBottom<E extends HTMLElement>(keys: readonly string[]) {
  const ref = useRef<E | null>(null);
  // The newest key when the Owner scrolled away (the empty string for an empty list); null while following.
  const [seen, setSeen] = useState<string | null>(null);
  const newest = keys[keys.length - 1] ?? "";

  useLayoutEffect(() => {
    const el = ref.current;
    if (seen === null && el) el.scrollTop = el.scrollHeight;
  }, [newest, seen]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const away = el.scrollHeight - el.scrollTop - el.clientHeight > SLACK_PX;
    if (away && seen === null) setSeen(newest);
    else if (!away && seen !== null) setSeen(null);
  };

  const jump = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    setSeen(null);
  };

  // Items after the one that was newest; all of them once that one has scrolled out of the kept window.
  const fresh = seen === null ? 0 : keys.length - 1 - keys.lastIndexOf(seen);
  return { ref, onScroll, away: seen !== null, fresh, jump };
}
