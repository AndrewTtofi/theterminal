import type { DockviewApi, SerializedDockview } from "dockview-react";
import type { CatalogEntry } from "@theterminal/shared";

/** Share of the dock's height the bottom panel takes in the default layout. */
export const BOTTOM_SHARE = 0.3;

/** The registry key for a panel id: `connection:<x>` panels share the `connection` component, `story:<card>` the `story` one. */
export const componentOf = (id: string) => id.split(":")[0]!;

export type PresetId = "guided" | "operator";
export const PRESET_LABELS: Record<PresetId, string> = { guided: "Guided", operator: "Operator" };

/**
 * Guided: the Board and the Conversation in the main area, Board active. Operator: the Board and Capacity in the
 * main area; below it (30 %) the Terminal, the Agent feed and the Ledger, Ledger active.
 */
export function buildPreset(api: DockviewApi, preset: PresetId): void {
  if (preset === "guided") {
    api.addPanel({ id: "board", component: "board", title: "Board" });
    api.addPanel({ id: "conversation", component: "conversation", title: "Conversation", position: { referencePanel: "board", direction: "within" }, inactive: true });
    return;
  }
  api.addPanel({ id: "board", component: "board", title: "Board" });
  api.addPanel({ id: "capacity", component: "capacity", title: "Capacity", position: { referencePanel: "board", direction: "within" }, inactive: true });
  api.addPanel({
    id: "terminal",
    component: "terminal",
    title: "Terminal",
    position: { direction: "below" },
    initialHeight: Math.round(api.height * BOTTOM_SHARE) || undefined,
  });
  api.addPanel({ id: "agent_feed", component: "agent_feed", title: "Agent feed", position: { referencePanel: "terminal", direction: "within" } });
  api.addPanel({ id: "ledger", component: "ledger", title: "Ledger", position: { referencePanel: "terminal", direction: "within" } });
  const bottom = api.getPanel("ledger")?.group;
  if (bottom && api.height > 0) bottom.api.setSize({ height: Math.round(api.height * BOTTOM_SHARE) });
}

/** The default layout: the Guided preset. */
export function buildDefault(api: DockviewApi): void {
  buildPreset(api, "guided");
}

/** Prefixes of the tabs that show one file of a run: `diff:<runId>:<encoded path>` and `file:<runId>:<encoded path>`. */
const RUN_PANEL = /^(diff|file):([^:]+):(.+)$/;
export const diffPanelId = (runId: string, path: string) => `diff:${runId}:${encodeURIComponent(path)}` as const;
export const filePanelId = (runId: string, path: string) => `file:${runId}:${encodeURIComponent(path)}` as const;

/** The run and path of a `diff:` or `file:` tab, or null for any other id (or a malformed one). */
export function parsePanelPath(id: string): { runId: string; path: string } | null {
  const m = RUN_PANEL.exec(id);
  if (!m) return null;
  try {
    return { runId: m[2]!, path: decodeURIComponent(m[3]!) };
  } catch {
    return null;
  }
}

const isRunPanel = (id: string) => id.startsWith("diff:") || id.startsWith("file:");

/** `diff:` and `file:` tabs whose run is not in `runIds`, and malformed ones. Other panel ids are left alone. */
export function staleRunPanels(panelIds: readonly string[], runIds: readonly string[]): string[] {
  const known = new Set(runIds);
  return panelIds.filter((id) => {
    if (!isRunPanel(id)) return false;
    const parsed = parsePanelPath(id);
    return parsed === null || !known.has(parsed.runId);
  });
}

/** The runs named by the `diff:` and `file:` tabs among `panelIds`, each once. */
export function runsOfPanels(panelIds: readonly string[]): string[] {
  return [...new Set(panelIds.flatMap((id) => (isRunPanel(id) ? [parsePanelPath(id)?.runId ?? ""] : [])).filter((r) => r !== ""))];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A saved layout fit to restore, or null. Only grid groups are kept: floating, popout and edge groups are
 * dropped, since they can sit over the Needs-you strip. Every panel must use a registered component.
 */
export function sanitizeLayout(saved: unknown, components: readonly string[]): SerializedDockview | null {
  if (!isRecord(saved) || !isRecord(saved.grid) || !isRecord(saved.grid.root) || !isRecord(saved.panels)) return null;
  const known = new Set(components);
  for (const [id, panel] of Object.entries(saved.panels)) {
    if (!isRecord(panel) || panel.id !== id) return null;
    const component = typeof panel.contentComponent === "string" ? panel.contentComponent : id;
    if (!known.has(componentOf(component))) return null;
  }
  const { floatingGroups: _f, popoutGroups: _p, edgeGroups: _e, ...rest } = saved;
  return rest as unknown as SerializedDockview;
}

/** Restores the saved layout when it is valid and shows at least one panel; otherwise builds the default. */
export function restoreOrDefault(api: DockviewApi, saved: unknown, components: readonly string[]): "restored" | "default" {
  const layout = sanitizeLayout(saved, components);
  if (layout) {
    try {
      api.fromJSON(layout);
      const visible = api.groups.some((g) => g.api.isVisible && g.panels.length > 0);
      if (api.panels.length > 0 && visible) return "restored";
    } catch {
      // fall through to the default layout
    }
  }
  api.clear();
  buildDefault(api);
  return "default";
}

/**
 * Connection tabs to close: `connection:<id>` whose connection no longer exists, and `connection:new:<provider>`
 * whose provider is unknown or not available. Other panel ids are left alone.
 */
export function staleConnectionPanels(
  panelIds: readonly string[],
  connections: readonly { id: string }[],
  catalog: readonly CatalogEntry[],
): string[] {
  const ids = new Set(connections.map((c) => c.id));
  return panelIds.filter((id) => {
    if (componentOf(id) !== "connection") return false;
    const rest = id.slice("connection:".length);
    if (rest.startsWith("new:")) {
      const provider = rest.slice("new:".length);
      return !catalog.some((e) => e.provider === provider && e.available);
    }
    return !ids.has(rest);
  });
}
