import { useCallback, useEffect, useRef, useState } from "react";
import { DecisionCard } from "../components/DecisionCard";
import { IntakeNotices, intakeNotices } from "../components/IntakeNotices";
import { AgentFeedPanel } from "../views/AgentFeedPanel";
import { BoardView } from "../views/BoardView";
import { CapacityPanel } from "../views/CapacityPanel";
import { ConnectionEditor } from "../views/ConnectionEditor";
import { IntakePanel } from "../views/IntakePanel";
import { LedgerBottomPanel } from "../views/LedgerBottomPanel";
import { ActivityBar } from "./ActivityBar";
import { staleConnectionPanels } from "./dock-layout";
import { Dock } from "./Dock";
import type { DockApi, DockPanelId } from "./Dock";
import { LAYOUT_KEY } from "./layout-store";
import { ShellContext } from "./model";
import type { WorkbenchModel } from "./model";
import { SIDE_BAR_DEFAULT, SideBar } from "./SideBar";
import { StatusBar } from "./StatusBar";
import type { ViewId } from "./views";

// Stable registry: dockview keys components by name, so this object must not change between renders.
const PANELS = {
  board: BoardView, agent_feed: AgentFeedPanel, ledger: LedgerBottomPanel, connection: ConnectionEditor, capacity: CapacityPanel,
  intake: IntakePanel,
};

type Props = { model: WorkbenchModel };

/** True for text inputs, textareas, selects and contenteditable elements. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest("[contenteditable='true'], [contenteditable='']")) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file", "image"].includes(target.type);
  }
  return false;
}

/**
 * VS Code-style shell: activity bar, side bar for the selected view, the docked main and bottom areas,
 * and a status bar. The Needs-you strip sits outside the dock so decisions surface in every layout.
 */
export function Workbench({ model }: Props) {
  const [view, setView] = useState<ViewId>("board");
  const [sideOpen, setSideOpen] = useState(true);
  const [width, setWidth] = useState(SIDE_BAR_DEFAULT);
  const dockRef = useRef<DockApi | null>(null);

  const running = model.runs.filter((r) => r.status === "running").length;
  const pending = model.pending.length;
  const notices = intakeNotices(model);
  /** Everything waiting on the Owner: agent actions and open plan decisions. */
  const waiting = pending + notices.reduce((a, n) => a + n.decisions, 0);

  const selectView = (v: ViewId) => {
    // The Board view's home is the Board tab: bring it back if it was closed.
    if (v === "board") dockRef.current?.focus("board");
    if (v === view) {
      setSideOpen((open) => !open);
      return;
    }
    setView(v);
    setSideOpen(true);
  };

  const [dockReady, setDockReady] = useState(false);
  const onDockReady = useCallback((api: DockApi) => {
    dockRef.current = api;
    setDockReady(true);
  }, []);

  // A restored layout can hold tabs for connections removed since: close them once, on the first successful
  // load. Later removals leave the tab saying the connection no longer exists.
  const { loaded, list, catalog } = model.connections;
  const pruned = useRef(false);
  useEffect(() => {
    const dock = dockRef.current;
    if (pruned.current || !dockReady || !loaded || !dock) return;
    pruned.current = true;
    for (const id of staleConnectionPanels(dock.panelIds(), list, catalog)) dock.close(id as DockPanelId);
  }, [dockReady, loaded, list, catalog]);

  // Ctrl/Cmd+J toggles the bottom panel, as in VS Code, except while the Owner is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        dockRef.current?.toggleBottom();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ctx = { model, dock: () => dockRef.current, selectView };

  return (
    <ShellContext.Provider value={ctx}>
      <div className="workbench">
        <div className="workbench-body">
          <ActivityBar active={sideOpen ? view : null} running={running} pending={waiting} onSelect={selectView} />
          {sideOpen && <SideBar view={view} width={width} onResize={setWidth} />}
          <main className="main-column">
            {(pending > 0 || notices.length > 0) && (
              <section className="needs-you" aria-label="Needs you">
                <h2>Needs you</h2>
                <IntakeNotices notices={notices} />
                {model.pending.map((a) => (
                  <DecisionCard key={a.id} action={a} projectName={a.projectName} onDecide={model.onDecide} />
                ))}
              </section>
            )}
            <div className="dock">
              <Dock panels={PANELS} onReady={onDockReady} layoutKey={LAYOUT_KEY} />
            </div>
          </main>
        </div>
        <StatusBar status={model.status} running={running} pending={waiting} onSelectView={selectView} onResetLayout={() => dockRef.current?.reset()} />
      </div>
    </ShellContext.Provider>
  );
}
