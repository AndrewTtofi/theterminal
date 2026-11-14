import { useCallback, useEffect, useRef, useState } from "react";
import type { AdapterId, AgentAction, AgentRun, Board as BoardData, LedgerEntry, Project, Stage } from "@theterminal/shared";
import { api, errorMessage, subscribeLedger } from "./api";
import type { AgentsInfo, Health } from "./api";
import { AgentPanel } from "./components/AgentPanel";
import { ClaudeAuthSetting } from "./components/ClaudeAuthSetting";
import { DecisionCard } from "./components/DecisionCard";
import { Board } from "./components/Board";
import { LedgerPanel } from "./components/LedgerPanel";
import { ProjectList } from "./components/ProjectList";

/** Coalesced runner: at most one task in flight plus one trailing; stops once cancelled. */
function coalesced(task: () => Promise<void>, isCancelled: () => boolean): () => void {
  let inFlight = false;
  let trailing = false;
  const run = async (): Promise<void> => {
    if (isCancelled()) return;
    if (inFlight) {
      trailing = true;
      return;
    }
    inFlight = true;
    try {
      await task();
    } catch {
      // keep the current data; the next refresh retries
    } finally {
      inFlight = false;
      if (trailing && !isCancelled()) {
        trailing = false;
        void run();
      }
    }
  };
  return () => void run();
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  const refreshAgents = useRef<() => void>(() => {});
  const selectedRunRef = useRef<string | null>(null);
  const [agentsInfo, setAgentsInfo] = useState<AgentsInfo | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [pending, setPending] = useState<AgentAction[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runActions, setRunActions] = useState<AgentAction[]>([]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    try {
      setError(null);
      await action();
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void run(async () => {
      setHealth(await api.health());
      setProjects(await api.listProjects());
    });
    void api.getAgents().then(setAgentsInfo, () => {});
  }, [run]);

  useEffect(() => {
    selectedRunRef.current = selectedRunId;
    refreshAgents.current();
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setRuns([]);
    setPending([]);
    setRunActions([]);
    setSelectedRunId(null);
    selectedRunRef.current = null;
    const refresh = coalesced(async () => {
      const runId = selectedRunRef.current;
      const [r, p, detail] = await Promise.all([
        api.listRuns(selectedId),
        api.listPendingActions(selectedId),
        runId ? api.getRun(runId) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setRuns(r);
      setPending(p);
      setRunActions(detail ? detail.actions : []);
    }, () => cancelled);
    refreshAgents.current = refresh;
    refresh();
    return () => {
      cancelled = true;
      refreshAgents.current = () => {};
    };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    let unsubscribe = () => {};
    const refresh = coalesced(async () => {
      const b = await api.getBoard(selectedId);
      if (!cancelled) setBoard(b);
    }, () => cancelled);
    refreshRef.current = refresh;
    setBoard(null);
    setEntries([]);
    // Board and ledger load independently, so one failing does not hide the other.
    void run(async () => {
      const initialBoard = await api.getBoard(selectedId);
      if (!cancelled) setBoard(initialBoard);
    });
    void run(async () => {
      const initial = await api.listLedger(selectedId);
      if (cancelled) return;
      setEntries(initial);
      const lastSeq = initial.length ? initial[initial.length - 1]!.seq : 0;
      unsubscribe = subscribeLedger(lastSeq, (e) => {
        if (e.projectId !== selectedId) return;
        setEntries((prev) => (prev.some((p) => p.seq === e.seq) ? prev : [...prev, e]));
        refresh();
        if (e.type.startsWith("agent.")) refreshAgents.current();
      });
    });
    return () => {
      cancelled = true;
      refreshRef.current = () => {};
      unsubscribe();
    };
  }, [selectedId, run]);

  return (
    <div className="app">
      {health?.integrity === "broken" && (
        <div className="banner" role="alert">
          Ledger integrity check failed at entry #{health.brokenAtSeq} — workspace is read-only
        </div>
      )}
      {error && (
        <div className="error" role="status">
          {error}
        </div>
      )}
      <div className="layout">
        <ProjectList
          projects={projects}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCreate={(name) =>
            void run(async () => {
              const p = await api.createProject({ name });
              setProjects((prev) => [...prev, p]);
              setSelectedId(p.id);
            })
          }
        />
        <main>
          {selectedId && pending.length > 0 && (
            <section className="needs-you" aria-label="Needs you">
              <h2>Needs you</h2>
              {pending.map((a) => (
                <DecisionCard
                  key={a.id}
                  action={a}
                  onDecide={async (id, decision, reason) => {
                    try {
                      await api.decideAction(id, decision, reason);
                    } finally {
                      refreshAgents.current();
                    }
                  }}
                />
              ))}
            </section>
          )}
          {board && selectedId ? (
            <>
              <h1>{board.project.name}</h1>
              <Board
                board={board}
                onAddCard={(stage: Stage, title) =>
                  void run(async () => {
                    await api.addCard(selectedId, { title, stage });
                    refreshRef.current();
                  })
                }
                onMoveCard={(cardId, to) =>
                  void run(async () => {
                    await api.moveCard(cardId, to);
                    refreshRef.current();
                  })
                }
              />
              {agentsInfo && (
                <AgentPanel
                  adapters={agentsInfo.adapters}
                  runs={runs}
                  selectedRunId={selectedRunId}
                  actions={runActions}
                  onStart={async (adapter: AdapterId, prompt) => {
                    try {
                      setError(null);
                      const started = await api.startRun(selectedId, { adapter, prompt });
                      setSelectedRunId(started.id);
                      refreshAgents.current();
                      return true;
                    } catch (e) {
                      setError(errorMessage(e));
                      return false;
                    }
                  }}
                  onSelectRun={setSelectedRunId}
                  onStop={(runId) =>
                    void run(async () => {
                      await api.stopRun(runId);
                      refreshAgents.current();
                    })
                  }
                />
              )}
            </>
          ) : (
            <p className="empty">Select or create a project.</p>
          )}
        </main>
        {selectedId && (
          <div>
            {agentsInfo && (
              <ClaudeAuthSetting
                key={agentsInfo.claudeAuthMode}
                mode={agentsInfo.claudeAuthMode}
                subscriptionAck={agentsInfo.subscriptionAck}
                onChange={(mode, acknowledgement) =>
                  run(async () => {
                    const res = await api.setClaudeAuth(
                      acknowledgement ? { mode, acknowledgement } : { mode },
                    );
                    setAgentsInfo((prev) => (prev ? { ...prev, claudeAuthMode: res.mode } : prev));
                  })
                }
              />
            )}
            <LedgerPanel entries={entries} />
          </div>
        )}
      </div>
    </div>
  );
}
