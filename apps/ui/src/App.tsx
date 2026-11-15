import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentAction, AgentRun, Board as BoardData, GitHubOverview, LedgerEntry, PendingAgentAction, Project } from "@theterminal/shared";
import { ApiError, api, errorMessage, subscribeLedger } from "./api";
import type { AgentsInfo, Health, Status } from "./api";
import { Workbench } from "./shell/Workbench";
import type { LedgerScope, WorkbenchModel } from "./shell/model";
import { useConnections } from "./use-connections";

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
  const [ledgerScope, setLedgerScope] = useState<LedgerScope>("project");
  const [allEntries, setAllEntries] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  const refreshAgents = useRef<() => void>(() => {});
  const refreshPending = useRef<() => void>(() => {});
  const selectedRunRef = useRef<string | null>(null);
  const [agentsInfo, setAgentsInfo] = useState<AgentsInfo | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [pending, setPending] = useState<PendingAgentAction[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runActions, setRunActions] = useState<AgentAction[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [github, setGitHub] = useState<{ overview: GitHubOverview | null; error: string | null }>({ overview: null, error: null });
  const connections = useConnections();
  const refreshConnections = useRef(connections.refresh);
  refreshConnections.current = connections.refresh;

  const run = useCallback(async (action: () => Promise<unknown>) => {
    try {
      setError(null);
      await action();
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    // "Needs you" covers every project: stream from the ledger head and refetch on any agent entry.
    const refresh = coalesced(async () => {
      const p = await api.listAllPendingActions();
      if (!cancelled) setPending(p);
    }, () => cancelled);
    refreshPending.current = refresh;
    // Status bar numbers: refetched on any ledger entry and every 30 s (spend and run counts change quietly too).
    const refreshStatus = coalesced(async () => {
      const s = await api.getStatus();
      if (!cancelled) setStatus(s);
    }, () => cancelled);
    const timer = setInterval(refreshStatus, 30_000);
    void run(async () => {
      const h = await api.health();
      if (cancelled) return;
      setHealth(h);
      unsubscribe = subscribeLedger(h.headSeq, (e) => {
        refreshStatus();
        if (e.type.startsWith("agent.")) refresh();
        // Tests, enables and removals change a connection's status: reread the list from the server.
        if (e.type.startsWith("connection.")) refreshConnections.current();
      });
      refresh();
      refreshStatus();
      setProjects(await api.listProjects());
    });
    void api.getAgents().then(setAgentsInfo, () => {});
    return () => {
      cancelled = true;
      refreshPending.current = () => {};
      clearInterval(timer);
      unsubscribe();
    };
  }, [run]);

  // The GitHub view asks for this when it opens and every 60 s while it stays open. Made once, during the first
  // render, so the view can call it from its own mount effect (which runs before this component's effects).
  const mounted = useRef(true);
  const [refreshGitHub] = useState(() =>
    coalesced(async () => {
      try {
        const overview = await api.getGitHubOverview();
        if (mounted.current) setGitHub({ overview, error: null });
      } catch (e) {
        if (mounted.current) setGitHub({ overview: null, error: e instanceof ApiError ? e.code : "github_unavailable" });
      }
    }, () => !mounted.current),
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    selectedRunRef.current = selectedRunId;
    refreshAgents.current();
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setRuns([]);
    setRunActions([]);
    setSelectedRunId(null);
    selectedRunRef.current = null;
    const refresh = coalesced(async () => {
      const runId = selectedRunRef.current;
      const [r, detail] = await Promise.all([
        api.listRuns(selectedId),
        runId ? api.getRun(runId) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setRuns(r);
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

  // The "All projects" ledger scope loads and streams every project's entries while it is chosen.
  useEffect(() => {
    if (ledgerScope !== "all") return;
    let cancelled = false;
    let unsubscribe = () => {};
    setAllEntries([]);
    void run(async () => {
      const initial = await api.listLedger(null);
      if (cancelled) return;
      setAllEntries(initial);
      const lastSeq = initial.length ? initial[initial.length - 1]!.seq : 0;
      unsubscribe = subscribeLedger(lastSeq, (e) => {
        setAllEntries((prev) => (prev.some((p) => p.seq === e.seq) ? prev : [...prev, e]));
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [ledgerScope, run]);

  const model: WorkbenchModel = {
    projects,
    selectedId,
    onSelectProject: setSelectedId,
    onCreateProject: (name) =>
      void run(async () => {
        const p = await api.createProject({ name });
        setProjects((prev) => [...prev, p]);
        setSelectedId(p.id);
      }),
    board: selectedId ? board : null,
    onAddCard: (stage, title) =>
      void run(async () => {
        if (!selectedId) return;
        await api.addCard(selectedId, { title, stage });
        refreshRef.current();
      }),
    onMoveCard: (cardId, to) =>
      void run(async () => {
        await api.moveCard(cardId, to);
        refreshRef.current();
      }),
    agentsInfo,
    runs,
    selectedRunId,
    runActions,
    onStartRun: async (adapter, prompt, connectionIds) => {
      if (!selectedId) return false;
      try {
        setError(null);
        const started = await api.startRun(selectedId, { adapter, prompt, ...(connectionIds.length > 0 && { connectionIds }) });
        setSelectedRunId(started.id);
        refreshAgents.current();
        return true;
      } catch (e) {
        setError(errorMessage(e, "run"));
        return false;
      }
    },
    onSelectRun: setSelectedRunId,
    onStopRun: (runId) =>
      void run(async () => {
        await api.stopRun(runId);
        refreshAgents.current();
      }),
    pending,
    onDecide: async (id, decision, reason) => {
      try {
        await api.decideAction(id, decision, reason);
      } finally {
        refreshPending.current();
        refreshAgents.current();
      }
    },
    entries: ledgerScope === "all" ? allEntries : entries,
    ledgerScope,
    onLedgerScopeChange: setLedgerScope,
    onProviderAuthChange: async (provider, mode, acknowledgement) => {
      try {
        setError(null);
        const res = await api.setProviderAuth(acknowledgement ? { provider, mode, acknowledgement } : { provider, mode });
        setAgentsInfo((prev) =>
          prev
            ? { ...prev, providers: { ...prev.providers, [provider]: { ...prev.providers[provider], mode: res.mode } } }
            : prev,
        );
        return true;
      } catch (e) {
        setError(errorMessage(e));
        // Re-sync with the server's actual mode.
        void api.getAgents().then(setAgentsInfo, () => {});
        return false;
      }
    },
    connections,
    status,
    github: { ...github, refresh: refreshGitHub },
  };

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
      <Workbench model={model} />
    </div>
  );
}
