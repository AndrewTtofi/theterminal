import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import type { DockApi, DockPanelId } from "../src/shell/Dock";

const DEFAULT: { id: DockPanelId; where: "main" | "bottom" }[] = [
  { id: "board", where: "main" },
  { id: "agent_feed", where: "bottom" },
  { id: "ledger", where: "bottom" },
];

/** The DockApi of the most recently mounted TestDock, so tests can close panels as the Owner would. */
export const testDock: { api: DockApi | null } = { api: null };

/**
 * A flat stand-in for the dockview wrapper (jsdom cannot lay dockview out): every open panel renders
 * in a `div[data-panel=<id>]`, and the DockApi tracks which panels are open and whether the bottom is shown.
 */
export function Dock(props: { panels: Record<string, ComponentType<{ id: string }>>; onReady(api: DockApi): void; layoutKey: string }) {
  const [open, setOpen] = useState(DEFAULT);
  const [bottomShown, setBottomShown] = useState(true);
  const [active, setActive] = useState<DockPanelId | null>(null);

  useEffect(() => {
    const api: DockApi = {
      open: (id, _title, where) => {
        setOpen((prev) => (prev.some((p) => p.id === id) ? prev : [...prev, { id, where }]));
        setActive(id);
      },
      // Like the real dock, focusing a closed built-in panel reopens it.
      focus: (id) => {
        const builtIn = DEFAULT.find((p) => p.id === id);
        if (builtIn) setOpen((prev) => (prev.some((p) => p.id === id) ? prev : [...prev, builtIn]));
        setActive(id);
      },
      close: (id) => setOpen((prev) => prev.filter((p) => p.id !== id)),
      reset: () => {
        setOpen(DEFAULT);
        setBottomShown(true);
      },
      toggleBottom: () => setBottomShown((v) => !v),
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
