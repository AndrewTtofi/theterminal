import { useCallback, useEffect, useRef, useState } from "react";
import { DecisionCard } from "../components/DecisionCard";
import { GateCards } from "../components/GateCard";
import { IntakeNotices, intakeNotices } from "../components/IntakeNotices";
import { basename } from "../components/text";
import { AgentFeedPanel } from "../views/AgentFeedPanel";
import { TerminalPanel } from "../views/TerminalPanel";
import { BoardView } from "../views/BoardView";
import { ConversationPanel } from "../views/ConversationPanel";
import { CapacityPanel } from "../views/CapacityPanel";
import { ConnectionEditor } from "../views/ConnectionEditor";
import { DiffPanel } from "../views/DiffPanel";
import { FilePanel } from "../views/FilePanel";
import { IntakePanel } from "../views/IntakePanel";
import { LedgerBottomPanel } from "../views/LedgerBottomPanel";
import { NeedsYouPanel } from "../views/NeedsYouPanel";
import { StoryPanel } from "../views/StoryPanel";
import { ActivityBar } from "./ActivityBar";
import { diffPanelId, filePanelId, runsOfPanels, staleConnectionPanels, staleRunPanels } from "./dock-layout";
import { Dock } from "./Dock";
import type { DockApi, DockPanelId } from "./Dock";
import { LAYOUT_KEY } from "./layout-store";
import { ShellContext } from "./model";
import type { AppModel, ShellContextValue, WorkbenchModel } from "./model";
import { SIDE_BAR_DEFAULT, SideBar } from "./SideBar";
import { StatusBar } from "./StatusBar";
import type { LayoutControls } from "./StatusBar";
import type { ViewId } from "./views";

// Stable registry: dockview keys components by name, so this object must not change between renders.
const PANELS = {
  board: BoardView, agent_feed: AgentFeedPanel, ledger: LedgerBottomPanel, connection: ConnectionEditor, capacity: CapacityPanel,
  intake: IntakePanel, story: StoryPanel,
  conversation: ConversationPanel, needs_you: NeedsYouPanel, terminal: TerminalPanel, diff: DiffPanel, file: FilePanel,
};

type Props = { model: AppModel };

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
  /** The last view other than Learn, which Learn ranks its topics for. */
  const [lastView, setLastView] = useState<ViewId>("board");
  const [learnTopic, setLearnTopic] = useState<string | null>(null);
  const [sideOpen, setSideOpen] = useState(true);
  const [width, setWidth] = useState(SIDE_BAR_DEFAULT);
  const dockRef = useRef<DockApi | null>(null);

  const running = model.runs.filter((r) => r.status === "running").length;
  const pending = model.pending.length;
  const notices = intakeNotices(model);
  const gates = model.gate ? model.gate.evaluations.filter((g) => g.outcome !== "pass").length : 0;
  /** Everything waiting on the Owner: agent actions, open plan decisions and the gates of a stopped move. */
  const waiting = pending + notices.reduce((a, n) => a + n.decisions, 0) + gates;

  const showView = (v: ViewId) => {
    // The Board view's home is the Board tab: bring it back if it was closed.
    if (v === "board") dockRef.current?.focus("board");
    setView(v);
    if (v !== "learn") setLastView(v);
    setSideOpen(true);
  };
  /** The activity bar's action: the active view's button hides the side bar, or shows it again. */
  const selectView = (v: ViewId) => {
    if (v === view && sideOpen) {
      if (v === "board") dockRef.current?.focus("board");
      setSideOpen(false);
      return;
    }
    showView(v);
  };
  const stripShown = pending > 0 || notices.length > 0 || model.gate !== null;
  /** What the polite live region last said. */
  const [announcement, setAnnouncement] = useState("");
  const announceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(announceTimer.current), []);
  /**
   * A strip card's "More context": shows the Needs-you tab, leaving focus on the button the Owner pressed, and says
   * so in the live region, since nothing near the button changes.
   */
  const moreContext = () => {
    const from = document.activeElement;
    dockRef.current?.focus("needs_you");
    if (from instanceof HTMLElement && from.isConnected && document.activeElement !== from) from.focus();
    setAnnouncement("Opened Needs you");
    // Cleared after a while, so pressing it again later is announced again.
    clearTimeout(announceTimer.current);
    announceTimer.current = setTimeout(() => setAnnouncement(""), 3000);
  };
  const openLearn = (topicId: string) => {
    setLearnTopic(topicId);
    showView("learn");
  };

  const [dockReady, setDockReady] = useState(false);
  const [layoutName, setLayoutName] = useState("Guided");
  const [savedLayouts, setSavedLayouts] = useState<string[]>([]);
  const onDockReady = useCallback((api: DockApi) => {
    dockRef.current = api;
    setLayoutName(api.currentName());
    setSavedLayouts(api.savedNames());
    api.onNameChange(setLayoutName);
    setDockReady(true);
  }, []);

  const layout: LayoutControls = {
    current: layoutName,
    saved: savedLayouts,
    applyPreset: (p) => dockRef.current?.applyPreset(p),
    applySaved: (n) => dockRef.current?.applySaved(n),
    saveAs: (n) => {
      const dock = dockRef.current;
      if (!dock) return;
      dock.saveAs(n);
      setSavedLayouts(dock.savedNames());
    },
  };

  // A restored layout can hold diff and file tabs of runs deleted since: once the dock is ready, ask the server
  // about each run they name and close the tabs of runs it answers 404 for (and malformed ones). A failed check
  // keeps the tab.
  const { runExists } = model;
  const runsPruned = useRef(false);
  useEffect(() => {
    const dock = dockRef.current;
    if (runsPruned.current || !dockReady || !dock) return;
    runsPruned.current = true;
    const runIds = runsOfPanels(dock.panelIds());
    void Promise.all(runIds.map(async (id) => ((await runExists(id).catch(() => true)) ? [id] : []))).then((found) => {
      for (const id of staleRunPanels(dock.panelIds(), found.flat())) dock.closeQuietly(id as DockPanelId);
    });
  }, [dockReady, runExists]);

  // A restored layout can hold tabs for connections removed since: close them once, on the first successful
  // load. Later removals leave the tab saying the connection no longer exists.
  const { loaded, list, catalog } = model.connections;
  const pruned = useRef(false);
  useEffect(() => {
    const dock = dockRef.current;
    if (pruned.current || !dockReady || !loaded || !dock) return;
    pruned.current = true;
    for (const id of staleConnectionPanels(dock.panelIds(), list, catalog)) dock.closeQuietly(id as DockPanelId);
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

  const shellModel: WorkbenchModel = {
    ...model,
    onOpenDiff: (runId, path) => dockRef.current?.open(diffPanelId(runId, path), basename(path), "main"),
    onOpenFile: (runId, path) => dockRef.current?.open(filePanelId(runId, path), basename(path), "main"),
  };
  const ctx: ShellContextValue = {
    model: shellModel,
    dock: () => dockRef.current,
    selectView,
    showView,
    openLearn,
    learnTopic,
    contextView: view === "learn" ? lastView : view,
    stripShown,
  };

  return (
    <ShellContext.Provider value={ctx}>
      <div className="workbench">
        <div className="workbench-body">
          <ActivityBar active={sideOpen ? view : null} running={running} pending={waiting} onSelect={selectView} />
          {sideOpen && <SideBar view={view} width={width} onResize={setWidth} />}
          <main className="main-column">
            <p className="sr-only" aria-live="polite">
              {announcement}
            </p>
            {stripShown && (
              <section className="needs-you" aria-label="Needs you">
                <h2>Needs you</h2>
                {model.gate !== null && (
                  <GateCards
                    key={`${model.gate.cardId}:${model.gate.to}`}
                    gate={model.gate}
                    onResolve={model.onResolveGate}
                    onCancel={model.onCancelGate}
                  />
                )}
                <IntakeNotices notices={notices} />
                {model.pending.map((a) => (
                  <DecisionCard key={a.id} action={a} projectName={a.projectName} onDecide={model.onDecide} onMore={moreContext} />
                ))}
              </section>
            )}
            <div className="dock">
              <Dock panels={PANELS} onReady={onDockReady} layoutKey={LAYOUT_KEY} />
            </div>
          </main>
        </div>
        <StatusBar
          status={model.status}
          running={running}
          pending={waiting}
          onSelectView={showView}
          onResetLayout={() => dockRef.current?.reset()}
          layout={layout}
        />
      </div>
    </ShellContext.Provider>
  );
}
