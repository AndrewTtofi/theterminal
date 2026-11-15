import { useContext, useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import type { DockApi, DockPanelId } from "../src/shell/Dock";
import { PRESET_LABELS } from "../src/shell/dock-layout";
import type { PresetId } from "../src/shell/dock-layout";
import { saveNamedLayout } from "../src/shell/layout-store";
import { ShellContext } from "../src/shell/model";
import type { ShellContextValue } from "../src/shell/model";

export { diffPanelId, filePanelId, parsePanelPath } from "../src/shell/dock-layout";

type Placed = { id: DockPanelId; where: "main" | "bottom" };

const PRESETS: Record<PresetId, Placed[]> = {
  guided: [
    { id: "board", where: "main" },
    { id: "conversation", where: "main" },
  ],
  operator: [
    { id: "board", where: "main" },
    { id: "capacity", where: "main" },
    { id: "terminal", where: "bottom" },
    { id: "agent_feed", where: "bottom" },
    { id: "ledger", where: "bottom" },
  ],
};
/** Built-in panels focus() opens when absent. */
const BUILT_IN: Placed[] = [
  { id: "board", where: "main" },
  { id: "agent_feed", where: "bottom" },
  { id: "ledger", where: "bottom" },
  { id: "capacity", where: "main" },
  { id: "intake", where: "main" },
  { id: "conversation", where: "main" },
  { id: "needs_you", where: "main" },
  { id: "terminal", where: "bottom" },
  { id: "link_machine", where: "main" },
  { id: "share", where: "main" },
  { id: "digest", where: "main" },
  { id: "people", where: "main" },
];

/**
 * The DockApi and shell context of the most recently mounted TestDock, so tests can act as the Owner would.
 * Set `restore` before rendering to start from those panels, as if a saved layout had been restored.
 */
export const testDock: { api: DockApi | null; shell: ShellContextValue | null; restore: Placed[] | null } = {
  api: null,
  shell: null,
  restore: null,
};

/**
 * A flat stand-in for the dockview wrapper (jsdom cannot lay dockview out): every open panel renders
 * in a `div[data-panel=<id>]`, and the DockApi tracks which panels are open, whether the bottom is shown,
 * the layout's name and the layouts saved in this session.
 */
export function Dock(props: { panels: Record<string, ComponentType<{ id: string }>>; onReady(api: DockApi): void; layoutKey: string }) {
  testDock.shell = useContext(ShellContext);
  const [open, setOpen] = useState<Placed[]>(() => testDock.restore ?? PRESETS.guided);
  const [bottomShown, setBottomShown] = useState(true);
  const [active, setActive] = useState<DockPanelId | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    let name = "Guided";
    const listeners = new Set<(name: string) => void>();
    const saved = new Map<string, Placed[]>();
    const setName = (next: string) => {
      name = next;
      for (const fn of listeners) fn(next);
    };
    const add = (p: Placed) => {
      if (openRef.current.some((o) => o.id === p.id)) return;
      openRef.current = [...openRef.current, p];
      setOpen(openRef.current);
      setName("Custom");
    };
    const replace = (panels: Placed[], next: string) => {
      openRef.current = panels;
      setOpen(panels);
      setBottomShown(true);
      setName(next);
    };
    const api: DockApi = {
      open: (id, _title, where) => {
        add({ id, where });
        setActive(id);
      },
      // Like the real dock, focusing a closed built-in panel reopens it.
      focus: (id) => {
        const builtIn = BUILT_IN.find((p) => p.id === id);
        if (builtIn) add(builtIn);
        setActive(id);
      },
      close: (id) => {
        if (!openRef.current.some((p) => p.id === id)) return;
        openRef.current = openRef.current.filter((p) => p.id !== id);
        setOpen(openRef.current);
        setName("Custom");
      },
      closeQuietly: (id) => {
        openRef.current = openRef.current.filter((p) => p.id !== id);
        setOpen(openRef.current);
      },
      reset: () => replace(PRESETS.guided, "Guided"),
      toggleBottom: () => setBottomShown((v) => !v),
      panelIds: () => openRef.current.map((p) => p.id),
      applyPreset: (preset) => replace(PRESETS[preset], PRESET_LABELS[preset]),
      applySaved: (n) => {
        const panels = saved.get(n);
        if (panels) replace(panels, n);
      },
      // Like the real dock, the store validates and writes first: a refusal throws before the name changes.
      saveAs: (n) => {
        saveNamedLayout(n, openRef.current);
        saved.set(n, openRef.current);
        setName(n);
      },
      savedNames: () => [...saved.keys()],
      currentName: () => name,
      onNameChange: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    testDock.api = api;
    props.onReady(api);
    // onReady runs once, as with the real dock.
  }, []);

  return (
    <div data-testid="dock">
      {open
        .filter((p) => p.where === "main" || bottomShown)
        .map(({ id }) => {
          const Panel = props.panels[id.split(":")[0]!];
          return Panel ? (
            <div key={id} data-panel={id} data-active={active === id ? "true" : undefined}>
              <Panel id={id} />
            </div>
          ) : null;
        })}
    </div>
  );
}
