import { useCallback, useEffect, useRef, useState } from "react";
import type { Board as BoardData, LedgerEntry, Project, Stage } from "@theterminal/shared";
import { api, errorMessage, subscribeLedger } from "./api";
import type { Health } from "./api";
import { Board } from "./components/Board";
import { LedgerPanel } from "./components/LedgerPanel";
import { ProjectList } from "./components/ProjectList";

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refreshRef = useRef<() => void>(() => {});

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
  }, [run]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    let unsubscribe = () => {};
    // Coalesced refresh: at most one getBoard in flight plus one trailing; stale results are dropped.
    let inFlight = false;
    let trailing = false;
    const refresh = async () => {
      if (cancelled) return;
      if (inFlight) {
        trailing = true;
        return;
      }
      inFlight = true;
      try {
        const b = await api.getBoard(selectedId);
        if (!cancelled) setBoard(b);
      } catch {
        // keep the current board; the next refresh retries
      } finally {
        inFlight = false;
        if (trailing && !cancelled) {
          trailing = false;
          void refresh();
        }
      }
    };
    refreshRef.current = () => void refresh();
    setBoard(null);
    setEntries([]);
    void run(async () => {
      const [initialBoard, initial] = await Promise.all([api.getBoard(selectedId), api.listLedger(selectedId)]);
      if (cancelled) return;
      setBoard(initialBoard);
      setEntries(initial);
      const lastSeq = initial.length ? initial[initial.length - 1]!.seq : 0;
      unsubscribe = subscribeLedger(lastSeq, (e) => {
        if (e.projectId !== selectedId) return;
        setEntries((prev) => (prev.some((p) => p.seq === e.seq) ? prev : [...prev, e]));
        void refresh();
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
            </>
          ) : (
            <p className="empty">Select or create a project.</p>
          )}
        </main>
        {selectedId && <LedgerPanel entries={entries} />}
      </div>
    </div>
  );
}
