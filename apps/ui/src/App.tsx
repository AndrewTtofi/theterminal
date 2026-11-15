import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_SHARE_OPTIONS } from "@theterminal/shared";
import type {
  AgentAction, AgentRun, Board as BoardData, CapacityReport, DailyDigest, DigestDays, GateEvaluation, GitHubOverview, IntakeView,
  LedgerEntry, NarrationContext, NarrationTopic, PendingAgentAction, Project, RunChanges, ShareLink, ShareOptions,
  ShareSnapshotRecord, Stage,
} from "@theterminal/shared";
import { ADAPTER_NAMES } from "./components/AgentPanel";
import { ApiError, LIVE_RUN_CHANGES, api, blockedGates, errorMessage, subscribeLedger } from "./api";
import type { AgentsInfo, Health, ShareAddress, SharePreview, Status } from "./api";
import { Workbench } from "./shell/Workbench";
import { LEDGER_TOPICS, namesRun, runIsLive } from "./shell/model";
import type { OverrideOutcome } from "./shell/model";
import type { AppModel, GatePrompt, LedgerScope } from "./shell/model";
import { LIVE_CAP, appendEntries, batcher, prependEntries } from "./ledger-buffer";
import { useConnections } from "./use-connections";

/** Shown in the strip when the server refused the gate decisions because the conditions changed. */
const GATE_REFRESHED = "Something changed: a condition is no longer met. The checklist was refreshed.";

/** The ledger entry types that can change a gate's checklist while the Owner looks at it. */
const changesGates = (type: string) => ["agent.", "card.", "intake.", "gate."].some((p) => type.startsWith(p));

/** How many ledger entries one request loads: the newest page first, then older pages on request. */
const LEDGER_FETCH = 500;

/** The newest page of a project's ledger (every project's for null), and the head to stream from after it. */
async function newestLedgerPage(projectId: string | null): Promise<{ page: LedgerEntry[]; headSeq: number }> {
  const { headSeq } = await api.health();
  const page = await api.listLedger(projectId, { beforeSeq: headSeq + 1, limit: LEDGER_FETCH });
  return { page, headSeq };
}

/**
 * One ledger scope's loaded entries (ascending seq). `hasOlder`: the server may hold older ones. `paged`: the Owner
 * has paged older entries in, so the stream no longer trims to `LIVE_CAP`. `loading` and `error` describe the
 * older-page request.
 */
type ScopeLedger = { entries: LedgerEntry[]; hasOlder: boolean; paged: boolean; loading: boolean; error: string | null };
const EMPTY_SCOPE: ScopeLedger = { entries: [], hasOlder: false, paged: false, loading: false, error: null };

/** Streamed entries added to a scope: trimmed to the newest `LIVE_CAP` unless the Owner paged older ones in. */
function withStreamed(prev: ScopeLedger, incoming: LedgerEntry[]): ScopeLedger {
  const { entries, trimmed } = appendEntries(prev.entries, incoming, prev.paged ? null : LIVE_CAP);
  return entries === prev.entries ? prev : { ...prev, entries, hasOlder: prev.hasOlder || trimmed };
}

/** A preview the server no longer accepts (changed, expired or gone): the Owner must preview again. */
const stalePreview = (e: unknown) => e instanceof ApiError && (e.code === "preview_stale" || e.code === "preview_not_found");

/** How long a run's changes are reused before they are read again. */
const CHANGES_MEMO_MS = 10_000;

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
  const [projectLedger, setProjectLedger] = useState<ScopeLedger>(EMPTY_SCOPE);
  const entries = projectLedger.entries;
  const [ledgerScope, setLedgerScope] = useState<LedgerScope>("project");
  const [ledgerTopics, setLedgerTopics] = useState<NarrationTopic[]>(LEDGER_TOPICS);
  const [allLedger, setAllLedger] = useState<ScopeLedger>(EMPTY_SCOPE);
  /** Bumped each time a scope's entries are loaded afresh, so an older page asked for before is dropped. */
  const projectLoad = useRef(0);
  const allLoad = useRef(0);
  /** Bumped on each older-page request of a scope, so only the newest request ends its loading state. */
  const projectOlderReq = useRef(0);
  const allOlderReq = useRef(0);
  /** The run the Agent feed and the Terminal follow; null follows every run of the project. */
  const [feedRunId, setFeedRunId] = useState<string | null>(null);
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
  /**
   * True while a gated move is being sent, and the ids of actions whose decision is being sent: a second request
   * meanwhile (a double click, or another copy of the same card) answers false instead of reaching the server.
   */
  const resolvingGate = useRef(false);
  const deciding = useRef(new Set<string>());
  /** The runs whose override is being sent; see overrideAction. */
  const overriding = useRef(new Set<string>());
  gateRef.current = gate;
  const refreshGateRef = useRef<() => void>(() => {});
  /** Listeners for every new ledger entry (the story tabs), fed by the stream from the ledger head. */
  const entryListeners = useRef(new Set<(e: LedgerEntry) => void>());
  /** The run picked in the Changes view; null follows the selected run. */
  const [pickedChangesRun, setPickedChangesRun] = useState<string | null>(null);
  const [changes, setChanges] = useState<{ runId: string; changes: RunChanges | null; error: string | null } | null>(null);
  /** Each run's changes as last asked for, and when, so callers within 10 s share one request. */
  const changesMemo = useRef(new Map<string, { at: number; result: Promise<RunChanges> }>());
  /** The Share view: the options chosen, the preview being read, and the project's saved snapshots and links. */
  const [shareOptions, setShareOptions] = useState<ShareOptions>(DEFAULT_SHARE_OPTIONS);
  const [sharePreview, setSharePreview] = useState<SharePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [shareSnapshots, setShareSnapshots] = useState<ShareSnapshotRecord[]>([]);
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [shareAddresses, setShareAddresses] = useState<ShareAddress[]>([]);
  const refreshShare = useRef<() => void>(() => {});
  /** Bumped when the options or the project change, so a preview asked for before is dropped when it arrives. */
  const previewGen = useRef(0);
  const previewingRef = useRef(false);
  const confirming = useRef(false);
  const [digestDays, setDigestDays] = useState<DigestDays>(7);
  const [digests, setDigests] = useState<DailyDigest[] | null>(null);
  const refreshDigests = useRef<() => void>(() => {});
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
    setProjectLedger(EMPTY_SCOPE);
    setFeedRunId(null);
    const load = ++projectLoad.current;
    projectOlderReq.current++;
    // Streamed entries are applied together, at most every 50 ms, so a burst renders once.
    const stream = batcher<LedgerEntry>((batch) => setProjectLedger((prev) => withStreamed(prev, batch)));
    // Board and ledger load independently, so one failing does not hide the other.
    void run(async () => {
      const initialBoard = await api.getBoard(selectedId);
      if (!cancelled) setBoard(initialBoard);
    });
    void run(async () => {
      const { page, headSeq } = await newestLedgerPage(selectedId);
      if (cancelled || load !== projectLoad.current) return;
      setProjectLedger({ ...EMPTY_SCOPE, entries: page, hasOlder: page.length === LEDGER_FETCH });
      unsubscribe = subscribeLedger(headSeq, (e) => {
        if (e.projectId !== selectedId) return;
        stream.push(e);
        refresh();
        if (e.type.startsWith("agent.")) refreshAgents.current();
        if (e.type.startsWith("intake.") || e.type.startsWith("card.")) refreshIntake.current();
        if (e.type.startsWith("share.")) refreshShare.current();
        refreshDigests.current();
      });
    });
    return () => {
      cancelled = true;
      refreshRef.current = () => {};
      unsubscribe();
      stream.cancel();
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

  // The selected project's saved share snapshots and links; a new project drops the preview being read.
  useEffect(() => {
    previewGen.current++;
    setSharePreview(null);
    setShareSnapshots([]);
    setShareLinks([]);
    if (!selectedId) return;
    let cancelled = false;
    const refresh = coalesced(async () => {
      const [snapshots, links] = await Promise.all([api.listShareSnapshots(selectedId), api.listShareLinks(selectedId)]);
      if (cancelled) return;
      setShareSnapshots(snapshots);
      setShareLinks(links);
    }, () => cancelled);
    refreshShare.current = refresh;
    refresh();
    return () => {
      cancelled = true;
      refreshShare.current = () => {};
    };
  }, [selectedId]);

  // The selected project's daily digests over the chosen window: null while they load.
  useEffect(() => {
    setDigests(null);
    if (!selectedId) return;
    let cancelled = false;
    const refresh = coalesced(async () => {
      const list = await api.getDigests(selectedId, digestDays);
      if (!cancelled) setDigests(list);
    }, () => cancelled);
    refreshDigests.current = refresh;
    refresh();
    return () => {
      cancelled = true;
      refreshDigests.current = () => {};
    };
  }, [selectedId, digestDays]);

  // Asked for by the Share view when it opens; a failure keeps the addresses already known.
  const loadShareAddresses = useCallback(() => {
    void api.listShareAddresses().then(
      (a) => {
        if (mounted.current) setShareAddresses(a);
      },
      () => {},
    );
  }, []);

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

  /** Sends an emergency override; a refusal comes back worded, for the form to show where the Owner is looking. */
  /**
   * Sends one override of `runId`. While one of the run's overrides is being sent, another (a double click, or the
   * other form) answers a refusal without reaching the server, as decisions and gated moves do.
   */
  const overrideAction = async <T extends object>(runId: string, send: () => Promise<T>): Promise<OverrideOutcome<T>> => {
    if (overriding.current.has(runId)) return { ok: false, error: "An override of this run is already being sent" };
    overriding.current.add(runId);
    try {
      return { ok: true, ...(await send()) };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    } finally {
      overriding.current.delete(runId);
    }
  };

  // The "All projects" ledger scope loads and streams every project's entries while it is chosen.
  useEffect(() => {
    if (ledgerScope !== "all") return;
    let cancelled = false;
    let unsubscribe = () => {};
    setAllLedger(EMPTY_SCOPE);
    const load = ++allLoad.current;
    allOlderReq.current++;
    const stream = batcher<LedgerEntry>((batch) => setAllLedger((prev) => withStreamed(prev, batch)));
    void run(async () => {
      const { page, headSeq } = await newestLedgerPage(null);
      if (cancelled || load !== allLoad.current) return;
      setAllLedger({ ...EMPTY_SCOPE, entries: page, hasOlder: page.length === LEDGER_FETCH });
      unsubscribe = subscribeLedger(headSeq, (e) => stream.push(e));
    });
    return () => {
      cancelled = true;
      unsubscribe();
      stream.cancel();
    };
  }, [ledgerScope, run]);

  /**
   * Puts the page before the oldest loaded entry of a scope (every project's, or the selected project's) in front,
   * one request per scope at a time. A failure is kept on the scope for its panel to show; a request overtaken by a
   * reload or a newer request changes nothing when it ends.
   */
  const loadOlder = async (all: boolean): Promise<void> => {
    const projectId = all ? null : selectedId;
    const scope = all ? allLedger : projectLedger;
    const set = all ? setAllLedger : setProjectLedger;
    if ((!all && projectId === null) || scope.entries.length === 0 || scope.loading) return;
    const load = all ? allLoad : projectLoad;
    const req = all ? allOlderReq : projectOlderReq;
    const at = load.current;
    const token = ++req.current;
    const current = () => load.current === at && req.current === token;
    const oldest = scope.entries.reduce((min, e) => Math.min(min, e.seq), Infinity);
    set((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const page = await api.listLedger(projectId, { beforeSeq: oldest, limit: LEDGER_FETCH });
      if (!current()) return;
      set((prev) => ({
        ...prev, entries: prependEntries(page, prev.entries), hasOlder: page.length === LEDGER_FETCH, paged: true, loading: false,
      }));
    } catch (e) {
      if (current()) set((prev) => ({ ...prev, loading: false, error: errorMessage(e) }));
    }
  };

  // A gate belongs to the project it was raised in: choosing another project closes it.
  useEffect(() => setGate(null), [selectedId]);
  // Stable, so a story tab subscribes once.
  const subscribeEntries = useCallback((onEntry: (e: LedgerEntry) => void) => {
    entryListeners.current.add(onEntry);
    return () => {
      entryListeners.current.delete(onEntry);
    };
  }, []);

  // The Changes view's run: the one picked there, else the selected run, else the project's newest.
  const newestRunId = useMemo(
    () => runs.reduce<AgentRun | null>((n, r) => (n === null || r.startedAt > n.startedAt ? r : n), null)?.id ?? null,
    [runs],
  );
  const changesRunId = selectedId ? (pickedChangesRun ?? selectedRunId ?? newestRunId) : null;
  useEffect(() => setPickedChangesRun(null), [selectedId]);

  /** A run's changes, from memory when asked for under 10 s ago (unless `fresh`); a failed read is not kept. */
  const [runChanges] = useState(() => (runId: string, fresh = false): Promise<RunChanges> => {
    const now = Date.now();
    const kept = changesMemo.current.get(runId);
    if (!fresh && kept && now - kept.at < CHANGES_MEMO_MS) return kept.result;
    const result = api.getRunChanges(runId);
    const memo = { at: now, result };
    changesMemo.current.set(runId, memo);
    result.catch(() => {
      if (changesMemo.current.get(runId) === memo) changesMemo.current.delete(runId);
    });
    return result;
  });

  /** True while the Changes run is live: the server refuses its changes, so none are asked for until it ends. */
  const changesLive = runIsLive(runs, changesRunId);
  useEffect(() => {
    if (changesRunId === null) {
      setChanges(null);
      return;
    }
    const runId = changesRunId;
    if (changesLive) {
      // The runs list says when it ends, and this effect then reads the changes.
      setChanges({ runId, changes: null, error: LIVE_RUN_CHANGES });
      return;
    }
    let cancelled = false;
    setChanges({ runId, changes: null, error: null });
    let fresh = false;
    const refresh = coalesced(async () => {
      const read = fresh;
      fresh = true;
      try {
        const c = await runChanges(runId, read);
        if (!cancelled) setChanges({ runId, changes: c, error: null });
      } catch (e) {
        if (!cancelled) setChanges((prev) => ({ runId, changes: prev?.runId === runId ? prev.changes : null, error: errorMessage(e, "changes") }));
      }
    }, () => cancelled);
    refresh();
    const unsubscribe = subscribeEntries((e) => {
      if (namesRun(e, runId)) refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [changesRunId, changesLive, runChanges, subscribeEntries]);

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

  const model: AppModel = {
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
      if (!g || resolvingGate.current) return false;
      resolvingGate.current = true;
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
      } finally {
        resolvingGate.current = false;
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
        setFeedRunId(started.id);
        refreshAgents.current();
        return true;
      } catch (e) {
        setError(errorMessage(e, "run"));
        return false;
      }
    },
    onSelectRun: (runId) => {
      setSelectedRunId(runId);
      // Picking a run in the Agents view follows it in the Agent feed and the Terminal.
      if (runId !== null) setFeedRunId(runId);
    },
    onStopRun: (runId) =>
      void run(async () => {
        await api.stopRun(runId);
        refreshAgents.current();
      }),
    pending,
    onDecide: async (id, decision, reason) => {
      if (deciding.current.has(id)) return false;
      deciding.current.add(id);
      try {
        await api.decideAction(id, decision, reason);
      } finally {
        deciding.current.delete(id);
        refreshPending.current();
        refreshAgents.current();
      }
    },
    entries: ledgerScope === "all" ? allLedger.entries : entries,
    projectEntries: entries,
    feedRunId,
    onFollowRun: setFeedRunId,
    ledgerHasOlder: (ledgerScope === "all" ? allLedger : projectLedger).hasOlder,
    ledgerOlder: {
      loading: (ledgerScope === "all" ? allLedger : projectLedger).loading,
      error: (ledgerScope === "all" ? allLedger : projectLedger).error,
    },
    onLoadOlderLedger: () => loadOlder(ledgerScope === "all"),
    projectOlder: { hasOlder: projectLedger.hasOlder, loading: projectLedger.loading, error: projectLedger.error },
    onLoadOlderProject: () => loadOlder(false),
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
    share: {
      options: shareOptions,
      onOptionsChange: (o) => {
        // What is confirmed must be what was chosen: a preview made with other options goes.
        previewGen.current++;
        setShareOptions(o);
        setSharePreview(null);
      },
      preview: selectedId ? sharePreview : null,
      previewing,
      onPreview: async () => {
        const projectId = selectedId;
        if (!projectId || previewingRef.current) return false;
        previewingRef.current = true;
        setPreviewing(true);
        const gen = ++previewGen.current;
        try {
          const p = await api.previewShare(projectId, shareOptions);
          if (gen !== previewGen.current) return false;
          setSharePreview(p);
          return true;
        } finally {
          previewingRef.current = false;
          setPreviewing(false);
        }
      },
      onConfirm: async () => {
        const projectId = selectedId;
        const p = sharePreview;
        if (!projectId || !p || confirming.current) return false;
        confirming.current = true;
        try {
          await api.confirmShare(projectId, p.previewId, p.contentHash);
          // Saved: the preview is done with, so another save needs a new preview, never the same previewId twice.
          setSharePreview((prev) => (prev?.previewId === p.previewId ? null : prev));
          refreshShare.current();
          return true;
        } catch (e) {
          if (stalePreview(e)) setSharePreview((prev) => (prev?.previewId === p.previewId ? null : prev));
          throw e;
        } finally {
          confirming.current = false;
        }
      },
      snapshots: selectedId ? shareSnapshots : [],
      links: selectedId ? shareLinks : [],
      addresses: shareAddresses,
      loadAddresses: loadShareAddresses,
      onCreateLink: async (shareId, address, ttlMinutes) => {
        if (!selectedId) return null;
        const made = await api.createShareLink(shareId, address, ttlMinutes);
        refreshShare.current();
        return { url: made.url };
      },
      onRevokeLink: async (id) => {
        try {
          await api.revokeShareLink(id);
          return true;
        } finally {
          refreshShare.current();
        }
      },
    },
    digests: { days: digestDays, onDaysChange: setDigestDays, list: selectedId ? digests : null },
    intake: selectedId ? intake : undefined,
    intakeError: selectedId ? intakeError : null,
    onStartIntake: (idea) => intakeAction((id) => api.startIntake(id, idea), "intake"),
    onAnswerIntake: (questionId, answer) => intakeAction((id) => api.answerIntake(id, questionId, answer)),
    onDecideIntake: (decisionId, chosen, rationale) => intakeAction((id) => api.decideIntake(id, decisionId, chosen, rationale)),
    onCompleteIntake: () => intakeAction((id) => api.completeIntake(id)),
    onReopenIntake: (reason) => intakeAction((id) => api.reopenIntake(id, reason), "reopen"),
    runExists: api.runExists,
    changesRunId,
    onSelectChangesRun: setPickedChangesRun,
    changes: changes?.runId === changesRunId ? changes.changes : null,
    changesError: changes?.runId === changesRunId ? changes.error : null,
    runChanges,
    onOverrideCommand: (runId, i) => overrideAction(runId, () => api.overrideCommand(runId, i)),
    onOverrideDiscard: (runId, reason) => overrideAction(runId, () => api.overrideDiscard(runId, reason)),
    dir: api.listRunDir,
    file: api.getRunFile,
    diff: api.getRunDiff,
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
