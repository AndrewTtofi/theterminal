import { useMemo, useRef } from "react";
import type { ComponentType, FunctionComponent } from "react";
import { DockviewReact, themeDark } from "dockview-react";
import type { DockviewApi, DockviewReadyEvent, IDockviewPanel, IDockviewPanelProps } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { BOTTOM_SHARE, PRESET_LABELS, buildDefault, buildPreset, componentOf, restoreOrDefault } from "./dock-layout";
import type { PresetId } from "./dock-layout";
import {
  currentLayoutName, listSavedLayouts, loadLayout, loadNamedLayout, resetLayout, saveLayout, saveNamedLayout, setCurrentLayoutName,
} from "./layout-store";

export { diffPanelId, filePanelId, parsePanelPath } from "./dock-layout";

/** `diff:` and `file:` ids are `<runId>:<encodeURIComponent(path)>`. */
export type DockPanelId =
  | "board" | "agent_feed" | "ledger" | "capacity" | "intake" | "conversation" | "needs_you" | "terminal" | "share" | "digest"
  | `connection:${string}` | `story:${string}` | `diff:${string}:${string}` | `file:${string}:${string}`;
export type DockApi = {
  open(id: DockPanelId, title: string, where: "main" | "bottom"): void;
  focus(id: DockPanelId): void;
  close(id: DockPanelId): void;
  /** Closes a panel without making the layout Custom: for tabs pruned on load, which the Owner did not close. */
  closeQuietly(id: DockPanelId): void;
  /** Applies Guided and forgets the saved working layout. */
  reset(): void;
  toggleBottom(): void;
  /** Ids of every open panel. */
  panelIds(): string[];
  applyPreset(preset: PresetId): void;
  /** Applies the layout saved under `name`, if it is still fit to restore. */
  applySaved(name: string): void;
  /** Saves the layout on screen under `name`; throws the store's RangeError when it refuses. */
  saveAs(name: string): void;
  /** Names of the saved layouts, in the order they were first saved. */
  savedNames(): string[];
  /** "Guided", "Operator", a saved name, or "Custom" once a panel was added, removed or moved since. */
  currentName(): string;
  onNameChange(fn: (name: string) => void): () => void;
};

const BOTTOM_IDS: DockPanelId[] = ["terminal", "agent_feed", "ledger"];
/** Where focus() reopens a built-in panel the Owner closed. */
const DEFAULTS: Partial<Record<DockPanelId, { title: string; where: "main" | "bottom" }>> = {
  board: { title: "Board", where: "main" },
  agent_feed: { title: "Agent feed", where: "bottom" },
  ledger: { title: "Ledger", where: "bottom" },
  capacity: { title: "Capacity", where: "main" },
  intake: { title: "Plan intake", where: "main" },
  conversation: { title: "Conversation", where: "main" },
  needs_you: { title: "Needs you", where: "main" },
  terminal: { title: "Terminal", where: "bottom" },
  share: { title: "Share", where: "main" },
  digest: { title: "Daily digest", where: "main" },
};
function bottomPanel(api: DockviewApi): IDockviewPanel | undefined {
  return BOTTOM_IDS.map((id) => api.getPanel(id)).find((p) => p !== undefined);
}

/**
 * Tracks the layout's name. Adding, removing or moving a panel makes it "Custom"; resizing, activating a tab or
 * restoring does not. Applying a layout runs inside `applying`, so the panels it adds and removes do not count.
 */
function nameTracker(api: DockviewApi) {
  let name = currentLayoutName();
  let applying = false;
  const listeners = new Set<(name: string) => void>();
  const set = (next: string) => {
    if (next === name) return;
    name = next;
    setCurrentLayoutName(next);
    for (const fn of listeners) fn(next);
  };
  const custom = () => {
    if (!applying) set("Custom");
  };
  api.onDidAddPanel(custom);
  api.onDidRemovePanel(custom);
  api.onDidMovePanel(custom);
  return {
    get: () => name,
    set,
    apply(next: string, build: () => string | void) {
      applying = true;
      try {
        set(build() ?? next);
      } finally {
        applying = false;
      }
    },
    subscribe(fn: (name: string) => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

function makeDockApi(api: DockviewApi, layoutKey: string, components: readonly string[], names: ReturnType<typeof nameTracker>): DockApi {
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
    closeQuietly(id) {
      const panel = api.getPanel(id);
      if (panel) names.apply(names.get(), () => api.removePanel(panel));
    },
    reset() {
      names.apply(PRESET_LABELS.guided, () => {
        resetLayout(layoutKey);
        api.clear();
        buildDefault(api);
      });
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
    applyPreset(preset) {
      names.apply(PRESET_LABELS[preset], () => {
        api.clear();
        buildPreset(api, preset);
      });
    },
    applySaved(name) {
      const saved = loadNamedLayout(name);
      if (saved === null) return;
      // restoreOrDefault passes the layout through sanitizeLayout and falls back to Guided when it is not fit.
      names.apply(name, () => (restoreOrDefault(api, saved, components) === "restored" ? name : PRESET_LABELS.guided));
    },
    saveAs(name) {
      saveNamedLayout(name, api.toJSON());
      names.set(name.trim());
    },
    savedNames: listSavedLayouts,
    currentName: names.get,
    onNameChange: names.subscribe,
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
    const components = Object.keys(panels);
    const restored = restoreOrDefault(api, loadLayout(layoutKey), components);
    const names = nameTracker(api);
    if (restored === "default") names.set(PRESET_LABELS.guided);
    api.onDidLayoutChange(() => saveLayout(api.toJSON(), layoutKey));
    saveLayout(api.toJSON(), layoutKey);
    onReadyRef.current(makeDockApi(api, layoutKey, components, names));
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
