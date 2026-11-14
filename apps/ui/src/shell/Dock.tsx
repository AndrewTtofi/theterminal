import { useMemo, useRef } from "react";
import type { ComponentType, FunctionComponent } from "react";
import { DockviewReact, themeDark } from "dockview-react";
import type { DockviewApi, DockviewReadyEvent, IDockviewPanel, IDockviewPanelProps } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { BOTTOM_SHARE, buildDefault, componentOf, restoreOrDefault } from "./dock-layout";
import { loadLayout, resetLayout, saveLayout } from "./layout-store";

export type DockPanelId = "board" | "agent_feed" | "ledger" | `connection:${string}`;
export type DockApi = {
  open(id: DockPanelId, title: string, where: "main" | "bottom"): void;
  focus(id: DockPanelId): void;
  close(id: DockPanelId): void;
  reset(): void;
  toggleBottom(): void;
  /** Ids of every open panel. */
  panelIds(): string[];
};

const BOTTOM_IDS: DockPanelId[] = ["agent_feed", "ledger"];
/** Where focus() reopens a built-in panel the Owner closed. */
const DEFAULTS: Partial<Record<DockPanelId, { title: string; where: "main" | "bottom" }>> = {
  board: { title: "Board", where: "main" },
  agent_feed: { title: "Agent feed", where: "bottom" },
  ledger: { title: "Ledger", where: "bottom" },
};
function bottomPanel(api: DockviewApi): IDockviewPanel | undefined {
  return BOTTOM_IDS.map((id) => api.getPanel(id)).find((p) => p !== undefined);
}

function makeDockApi(api: DockviewApi, layoutKey: string): DockApi {
  const open: DockApi["open"] = (id, title, where) => {
    const existing = api.getPanel(id);
    if (existing) {
      existing.group.api.setVisible(true);
      existing.api.setActive();
      return;
    }
    if (where === "bottom") {
      const ref = bottomPanel(api);
      if (ref) ref.group.api.setVisible(true);
      api.addPanel({
        id,
        component: componentOf(id),
        title,
        position: ref ? { referenceGroup: ref.group, direction: "within" } : { direction: "below" },
        ...(ref ? {} : { initialHeight: Math.round(api.height * BOTTOM_SHARE) || undefined }),
      });
      return;
    }
    // Main area: beside the board, else in any group that is not the bottom panel.
    const bottomGroup = bottomPanel(api)?.group;
    const main = api.getPanel("board")?.group ?? api.groups.find((g) => g !== bottomGroup);
    api.addPanel({
      id,
      component: componentOf(id),
      title,
      position: main ? { referenceGroup: main, direction: "within" } : { direction: "above" },
    });
  };

  return {
    open,
    focus(id) {
      const panel = api.getPanel(id);
      if (panel) {
        panel.group.api.setVisible(true);
        panel.api.setActive();
        return;
      }
      const d = DEFAULTS[id];
      if (d) open(id, d.title, d.where);
    },
    close(id) {
      const panel = api.getPanel(id);
      if (panel) api.removePanel(panel);
    },
    reset() {
      resetLayout(layoutKey);
      api.clear();
      buildDefault(api);
    },
    toggleBottom() {
      const ref = bottomPanel(api);
      if (!ref) {
        open("agent_feed", "Agent feed", "bottom");
        open("ledger", "Ledger", "bottom");
        return;
      }
      ref.group.api.setVisible(!ref.group.api.isVisible);
    },
    panelIds: () => api.panels.map((p) => p.id),
  };
}

type Props = {
  panels: Record<string, ComponentType<{ id: string }>>;
  onReady(api: DockApi): void;
  /** localStorage key the layout is saved under. */
  layoutKey: string;
};

/** dockview-react wrapper: registers the panels, restores or builds the layout, and saves every change. */
export function Dock({ panels, onReady, layoutKey }: Props) {
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // dockview reads the component map by key; keep it stable for a given registry.
  const components = useMemo(() => {
    const out: Record<string, FunctionComponent<IDockviewPanelProps>> = {};
    for (const [key, Panel] of Object.entries(panels)) {
      out[key] = (props: IDockviewPanelProps) => (
        <div className="dock-panel">
          <Panel id={props.api.id} />
        </div>
      );
    }
    return out;
  }, [panels]);

  const handleReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    restoreOrDefault(api, loadLayout(layoutKey), Object.keys(panels));
    api.onDidLayoutChange(() => saveLayout(api.toJSON(), layoutKey));
    saveLayout(api.toJSON(), layoutKey);
    onReadyRef.current(makeDockApi(api, layoutKey));
  };

  // Floating groups are off: one could sit over the Needs-you strip, which must stay visible.
  return (
    <DockviewReact
      className="dock-host"
      theme={themeDark}
      components={components}
      onReady={handleReady}
      disableFloatingGroups
    />
  );
}
