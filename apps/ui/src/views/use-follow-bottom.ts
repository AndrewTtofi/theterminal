import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** How far above the bottom the Owner can be and still count as following the newest items. */
const SLACK_PX = 40;
/** The count of new items is announced as a status: changed at most this often, so it does not chatter. */
const COUNT_EVERY_MS = 1000;

/** `value`, but changed at most once every `ms`: a change inside the window shows when the window ends. */
function useThrottled(value: number, ms: number): number {
  const [shown, setShown] = useState(value);
  const last = useRef(-Infinity);
  useEffect(() => {
    if (value === shown) return;
    const show = () => {
      last.current = Date.now();
      setShown(value);
    };
    const wait = last.current + ms - Date.now();
    if (wait <= 0) return show();
    const timer = setTimeout(show, wait);
    return () => clearTimeout(timer);
  }, [value, shown, ms]);
  return shown;
}

/**
 * Keeps a scrolling list's newest item in view as items arrive, unless the Owner has scrolled up more than 40 px.
 * `keys` are the items' keys, oldest first; each item element carries its key as `data-key`. While the Owner reads
 * further up, the item at the top of the view stays where it is even when old items are dropped above it (the list
 * sets `overflow-anchor: none` and this hook does the anchoring), `fresh` counts the items that arrived since (at
 * most once a second), and `jump` scrolls back to the bottom and follows again. `version` names content that can
 * grow inside the newest item (a run's answers): while following, a change scrolls to the bottom again.
 */
export function useFollowBottom<E extends HTMLElement>(keys: readonly string[], version: string | number = 0) {
  const ref = useRef<E | null>(null);
  // The newest key when the Owner scrolled away (the empty string for an empty list); null while following.
  const [seen, setSeen] = useState<string | null>(null);
  // The item at the top of the view, and how far its top sits above the view's top.
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const newest = keys[keys.length - 1] ?? "";
  const oldest = keys[0] ?? "";

  const capture = () => {
    const el = ref.current;
    if (!el) return;
    const top = Array.from(el.children).find(
      (c): c is HTMLElement => c instanceof HTMLElement && c.offsetTop + c.offsetHeight > el.scrollTop,
    );
    const key = top?.dataset.key;
    anchor.current = top && key !== undefined ? { key, offset: top.offsetTop - el.scrollTop } : null;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (seen === null) {
      el.scrollTop = el.scrollHeight;
    } else if (anchor.current) {
      const { key, offset } = anchor.current;
      const item = Array.from(el.children).find((c): c is HTMLElement => c instanceof HTMLElement && c.dataset.key === key);
      if (item) el.scrollTop = item.offsetTop - offset;
    }
    capture();
  }, [newest, oldest, seen, version]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const away = el.scrollHeight - el.scrollTop - el.clientHeight > SLACK_PX;
    if (away && seen === null) setSeen(newest);
    else if (!away && seen !== null) setSeen(null);
    capture();
  };

  const jump = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    setSeen(null);
  };

  // Items after the one that was newest; all of them once that one has scrolled out of the kept window.
  const fresh = useThrottled(seen === null ? 0 : keys.length - 1 - keys.lastIndexOf(seen), COUNT_EVERY_MS);
  return { ref, onScroll, away: seen !== null, fresh, jump };
}
