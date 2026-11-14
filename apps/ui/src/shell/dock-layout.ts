import type { DockviewApi, SerializedDockview } from "dockview-react";

/** Share of the dock's height the bottom panel takes in the default layout. */
export const BOTTOM_SHARE = 0.3;

/** The registry key for a panel id: `connection:<x>` panels share the `connection` component. */
export const componentOf = (id: string) => id.split(":")[0]!;

/** Main group with the Board; bottom group (30 %) with the Agent feed and the Ledger, Ledger active. */
export function buildDefault(api: DockviewApi): void {
  api.addPanel({ id: "board", component: "board", title: "Board" });
  api.addPanel({
    id: "agent_feed",
    component: "agent_feed",
    title: "Agent feed",
    position: { direction: "below" },
    initialHeight: Math.round(api.height * BOTTOM_SHARE) || undefined,
  });
  api.addPanel({ id: "ledger", component: "ledger", title: "Ledger", position: { referencePanel: "agent_feed", direction: "within" } });
  const bottom = api.getPanel("ledger")?.group;
  if (bottom && api.height > 0) bottom.api.setSize({ height: Math.round(api.height * BOTTOM_SHARE) });
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
