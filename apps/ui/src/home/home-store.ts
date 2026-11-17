/** Where the Home layout lives in localStorage. Bump the version when saved layouts stop being compatible. */
export const HOME_KEY = "tt.home.v1";

export const HOME_BLOCKS = ["ask", "approvals", "working", "overall", "finished", "previews", "files"] as const;
export type HomeBlockId = (typeof HOME_BLOCKS)[number];

export const HOME_BLOCK_LABELS: Record<HomeBlockId, string> = {
  ask: "Ask box",
  approvals: "Needs your approval",
  working: "Working now",
  overall: "Overall progress",
  finished: "Finished today",
  previews: "Previews",
  files: "Project files",
};

export type HomeLayout = { version: 1; order: HomeBlockId[]; hidden: HomeBlockId[]; workingColumns: 1 | 2 };

export const DEFAULT_HOME: HomeLayout = { version: 1, order: [...HOME_BLOCKS], hidden: [], workingColumns: 2 };

const isId = (x: unknown): x is HomeBlockId => (HOME_BLOCKS as readonly unknown[]).includes(x);

function ids(v: unknown): HomeBlockId[] {
  const out: HomeBlockId[] = [];
  if (Array.isArray(v)) for (const x of v) if (isId(x) && !out.includes(x)) out.push(x);
  return out;
}

const fresh = (): HomeLayout => ({ ...DEFAULT_HOME, order: [...DEFAULT_HOME.order], hidden: [] });

/** A valid layout from anything stored: unknown ids and duplicates dropped, missing ids put back, approvals never hidden. */
export function normalizeHome(v: unknown): HomeLayout {
  if (typeof v !== "object" || v === null || (v as { version?: unknown }).version !== 1) return fresh();
  const o = v as { order?: unknown; hidden?: unknown; workingColumns?: unknown };
  const order = ids(o.order);
  // A missing id goes right after the nearest block that precedes it by default; with none, it goes last,
  // so a block the person put first stays first.
  HOME_BLOCKS.forEach((id, i) => {
    if (order.includes(id)) return;
    let at = order.length;
    for (let j = i - 1; j >= 0; j--) {
      const k = order.indexOf(HOME_BLOCKS[j]!);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    order.splice(at, 0, id);
  });
  return {
    version: 1,
    order,
    hidden: ids(o.hidden).filter((id) => id !== "approvals"),
    workingColumns: o.workingColumns === 1 ? 1 : 2,
  };
}

// Storage can be unavailable; Home's layout is a convenience, so fail quietly like the dock layout.
export function loadHome(): HomeLayout {
  try {
    const raw = localStorage.getItem(HOME_KEY);
    return raw === null ? fresh() : normalizeHome(JSON.parse(raw));
  } catch {
    return fresh();
  }
}

export function saveHome(l: HomeLayout): void {
  try {
    localStorage.setItem(HOME_KEY, JSON.stringify(l));
  } catch {
    // keep working with the in-memory layout
  }
}

export function resetHome(): HomeLayout {
  try {
    localStorage.removeItem(HOME_KEY);
  } catch {
    // nothing saved that we could reach
  }
  return fresh();
}

export function moveBlock(l: HomeLayout, id: HomeBlockId, delta: -1 | 1): HomeLayout {
  const from = l.order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= l.order.length) return l;
  const order = [...l.order];
  order.splice(from, 1);
  order.splice(to, 0, id);
  return { ...l, order };
}

export function toggleBlock(l: HomeLayout, id: HomeBlockId): HomeLayout {
  if (id === "approvals") return l;
  const hidden = l.hidden.includes(id) ? l.hidden.filter((x) => x !== id) : [...l.hidden, id];
  return { ...l, hidden };
}
