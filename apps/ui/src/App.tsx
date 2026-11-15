import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentAction, AgentRun, Board as BoardData, CapacityReport, GateEvaluation, GitHubOverview, IntakeView, LedgerEntry,
  NarrationContext, NarrationTopic, PendingAgentAction, Project, Stage,
} from "@theterminal/shared";
import { ADAPTER_NAMES } from "./components/AgentPanel";
import { ApiError, api, blockedGates, errorMessage, subscribeLedger } from "./api";
import type { AgentsInfo, Health, Status } from "./api";
import { Workbench } from "./shell/Workbench";
import { LEDGER_TOPICS } from "./shell/model";
import type { GatePrompt, LedgerScope, WorkbenchModel } from "./shell/model";
import { useConnections } from "./use-connections";

/** Shown in the strip when the server refused the gate decisions because the conditions changed. */
const GATE_REFRESHED = "Something changed: a condition is no longer met. The checklist was refreshed.";

/** The ledger entry types that can change a gate's checklist while the Owner looks at it. */
const changesGates = (type: string) => ["agent.", "card.", "intake.", "gate."].some((p) => type.startsWith(p));

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
  const [intake, setIntake] = useState<IntakeView | null | undefined>(undefined);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const refreshIntake = useRef<() => void>(() => {});
  /** The selected project as of the latest render, so a late intake answer for another project is dropped. */
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [ledgerScope, setLedgerScope] = useState<LedgerScope>("project");
  const [ledgerTopics, setLedgerTopics] = useState<NarrationTopic[]>(LEDGER_TOPICS);
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
  const [capacity, setCapacity] = useState<{ report: CapacityReport | null; error: string | null }>({ report: null, error: null });
  /** Set once the Capacity view or tab has asked for the report: from then on, usage changes refresh it too. */
  const capacityWanted = useRef(false);
  const refreshCapacityRef = useRef<() => void>(() => {});
  /** The gated move waiting on the Owner, with the project of its card. */
  const [gate, setGate] = useState<(GatePrompt & { projectId: string }) | null>(null);
  const gateRef = useRef(gate);
  gateRef.current = gate;
  const refreshGateRef = useRef<() => void>(() => {});
  /** Listeners for every new ledger entry (the story tabs), fed by the stream from the ledger head. */
  const entryListeners = useRef(new Set<(e: LedgerEntry) => void>());
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
        // Spend, rate limits, budgets and hardware change the Capacity report.
        const usage = e.type === "agent.finished" || e.type === "agent.rate_limited" || e.type.startsWith("connection.");
        if (usage && capacityWanted.current) refreshCapacityRef.current();
        const g = gateRef.current;
        if (g && e.projectId === g.projectId && changesGates(e.type)) refreshGateRef.current();
        for (const listener of [...entryListeners.current]) listener(e);
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
  // The Capacity view and tab ask for this when they open and every 60 s while open; made once, like refreshGitHub.
  const [refreshCapacity] = useState(() => {
    const load = coalesced(async () => {
      try {
        const report = await api.getCapacity();
        if (mounted.current) setCapacity({ report, error: null });
      } catch (e) {
        if (mounted.current) setCapacity((prev) => ({ report: prev.report, error: e instanceof ApiError ? e.code : "request_failed" }));
      }
    }, () => !mounted.current);
    return () => {
      capacityWanted.current = true;
      load();
    };
  });
  refreshCapacityRef.current = refreshCapacity;
  // The open gate's checklist, read again; made once, like refreshGitHub.
  const [refreshGate] = useState(() =>
    coalesced(async () => {
      const g = gateRef.current;
      if (!g) return;
      const evaluations = await api.getCardGates(g.cardId, g.to);
      if (!mounted.current) return;
      setGate((prev) => (prev && prev.cardId === g.cardId && prev.to === g.to ? { ...prev, evaluations } : prev));
    }, () => !mounted.current),
  );
  refreshGateRef.current = refreshGate;
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
        if (e.type.startsWith("intake.") || e.type.startsWith("card.")) refreshIntake.current();
      });
    });
    return () => {
      cancelled = true;
      refreshRef.current = () => {};
      unsubscribe();
    };
  }, [selectedId, run]);

  // The selected project's guided intake: undefined while it loads, null when the project has none.
  useEffect(() => {
    setIntake(undefined);
    setIntakeError(null);
    if (!selectedId) return;
    let cancelled = false;
    const refresh = coalesced(async () => {
      let view: IntakeView | null;
      try {
        view = await api.getIntake(selectedId);
      } catch (e) {
        // A project that no longer exists will not come back on a retry: say so instead of loading forever.
        if (!cancelled && e instanceof ApiError && e.status === 404 && e.code === "not_found") {
          setIntake(undefined);
          setIntakeError(errorMessage(e, "intake"));
        }
        throw e;
      }
      if (!cancelled) {
        setIntake(view);
        setIntakeError(null);
      }
    }, () => cancelled);
    refreshIntake.current = refresh;
    refresh();
    return () => {
      cancelled = true;
      refreshIntake.current = () => {};
    };
  }, [selectedId]);

  /** Runs an intake change for the selected project and shows the view the server returns; false when refused. */
  const intakeAction = async (
    change: (projectId: string) => Promise<IntakeView>,
    context?: "intake" | "reopen",
  ): Promise<boolean> => {
    const projectId = selectedId;
    if (!projectId) return false;
    try {
      setError(null);
      const view = await change(projectId);
      if (selectedRef.current === projectId) setIntake(view);
      return true;
    } catch (e) {
      setError(errorMessage(e, context));
      return false;
    }
  };

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

  // A gate belongs to the project it was raised in: choosing another project closes it.
  useEffect(() => setGate(null), [selectedId]);
  // Stable, so a story tab subscribes once.
  const subscribeEntries = useCallback((onEntry: (e: LedgerEntry) => void) => {
    entryListeners.current.add(onEntry);
    return () => {
      entryListeners.current.delete(onEntry);
    };
  }, []);
  const gatePrompt = useMemo(() => {
    if (!gate) return null;
    const { projectId: _projectId, ...prompt } = gate;
    return prompt;
  }, [gate]);

  const titles = useMemo(
    () => new Map(board ? Object.values(board.columns).flat().map((c) => [c.id, c.title] as const) : []),
    [board],
  );
  // Kept stable while the board and runs are unchanged, so the ledger's narration is not redone every render.
  const narration = useMemo<NarrationContext>(() => {
    const adapters = new Map(runs.map((r) => [r.id, ADAPTER_NAMES[r.adapter]] as const));
    return { cardTitle: (id) => titles.get(id), adapterName: (id) => adapters.get(id) };
  }, [titles, runs]);

  /** Applies `change` to the open gate when it is still the move for `cardId` and `to`. */
  const updateGate = (cardId: string, to: Stage, change: (prev: GatePrompt) => Partial<GatePrompt>) =>
    setGate((prev) => (prev && prev.cardId === cardId && prev.to === to ? { ...prev, ...change(prev) } : prev));

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
    onMoveCard: async (cardId, to) => {
      const projectId = selectedId;
      if (!projectId) return;
      const open = (evaluations: GateEvaluation[]) =>
        setGate({
          projectId, cardId, cardTitle: titles.get(cardId) ?? "this card", to, evaluations, note: null, revision: 0, refreshing: false,
        });
      try {
        setError(null);
        const evaluations = await api.getCardGates(cardId, to);
        if (!evaluations.every((g) => g.outcome === "pass")) return open(evaluations);
        try {
          await api.moveCard(cardId, to);
        } catch (e) {
          // Something changed between the check and the move: the server sends the gates back.
          const gates = blockedGates(e);
          if (gates === null) throw e;
          return open(gates);
        }
        refreshRef.current();
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    gate: gatePrompt,
    onResolveGate: async (decisions) => {
      const g = gateRef.current;
      if (!g) return false;
      try {
        setError(null);
        await api.moveCard(g.cardId, g.to, decisions);
        setGate((prev) => (prev && prev.cardId === g.cardId && prev.to === g.to ? null : prev));
        refreshRef.current();
        return true;
      } catch (e) {
        const gates = blockedGates(e);
        if (gates !== null) {
          updateGate(g.cardId, g.to, (prev) => ({ evaluations: gates, note: GATE_REFRESHED, revision: prev.revision + 1 }));
        } else if (e instanceof ApiError && e.code === "gate_not_met") {
          // The decisions are dropped and the move stays disabled until the checklist has been read again.
          updateGate(g.cardId, g.to, (prev) => ({ note: GATE_REFRESHED, revision: prev.revision + 1, refreshing: true }));
          try {
            const evaluations = await api.getCardGates(g.cardId, g.to);
            updateGate(g.cardId, g.to, () => ({ evaluations, refreshing: false }));
          } catch (err) {
            updateGate(g.cardId, g.to, () => ({ refreshing: false }));
            setError(errorMessage(err));
          }
        } else {
          setError(errorMessage(e));
        }
        return false;
      }
    },
    onCancelGate: () => setGate(null),
    story: (cardId) => api.getCardStory(cardId),
    subscribeEntries,
    agentsInfo,
    runs,
    selectedRunId,
    runActions,
    onStartRun: async (adapter, prompt, connectionIds, cardId) => {
      if (!selectedId) return false;
      try {
        setError(null);
        const started = await api.startRun(selectedId, {
          adapter,
          prompt,
          ...(cardId && { cardId }),
          ...(connectionIds.length > 0 && { connectionIds }),
        });
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
    ledgerTopics,
    onLedgerTopicsChange: setLedgerTopics,
    narration,
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
    capacity: { ...capacity, refresh: refreshCapacity },
    intake: selectedId ? intake : undefined,
    intakeError: selectedId ? intakeError : null,
    onStartIntake: (idea) => intakeAction((id) => api.startIntake(id, idea), "intake"),
    onAnswerIntake: (questionId, answer) => intakeAction((id) => api.answerIntake(id, questionId, answer)),
    onDecideIntake: (decisionId, chosen, rationale) => intakeAction((id) => api.decideIntake(id, decisionId, chosen, rationale)),
    onCompleteIntake: () => intakeAction((id) => api.completeIntake(id)),
    onReopenIntake: (reason) => intakeAction((id) => api.reopenIntake(id, reason), "reopen"),
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
