import { createContext, useContext } from "react";
import type {
  AdapterId,
  AgentAction,
  AgentRun,
  AuthMode,
  Board,
  CapacityReport,
  CardInfo,
  CardMoveRequest,
  CardStory,
  DailyDigest,
  DecisionId,
  DigestDays,
  DirListing,
  FileContent,
  FileDiff,
  GateDecisionInput,
  GateEvaluation,
  GitHubOverview,
  HomeRuns,
  ProjectFiles,
  IntakeAnswer,
  IntakeView,
  LedgerEntry,
  MachineCapacity,
  MachinePresence,
  NarrationContext,
  NarrationTopic,
  PendingAgentAction,
  Project,
  Provider,
  QuestionId,
  RunChanges,
  ShareLink,
  ShareOptions,
  ShareSnapshotRecord,
  Stage,
} from "@theterminal/shared";
import type { Invite, Me, Person, PresenceEntry, Role } from "@theterminal/shared";
import { ROLE_LABELS, atLeast, innerEntry, runIdOf } from "@theterminal/shared";
import type { AgentsInfo, LinkOverview, RemoteInfo, ShareAddress, SharePreview, Status } from "../api";
import type { ConnectionsModel } from "../use-connections";
import type { DockApi } from "./Dock";
import type { ViewId } from "./views";

export type LedgerScope = "project" | "all";

/**
 * A card move the readiness gates stopped, waiting on the Owner in the Needs-you strip. `note` explains a refresh
 * after the server refused the decisions; `revision` goes up on every refusal, which drops the decisions made so
 * far; `refreshing` is true while the checklist is read again after one.
 */
export type GatePrompt = {
  cardId: string;
  cardTitle: string;
  to: Stage;
  evaluations: GateEvaluation[];
  note: string | null;
  revision: number;
  refreshing: boolean;
};

/** Every narration topic, in the order the ledger filter lists them. Overrides are always shown, whatever is chosen. */
export const LEDGER_TOPICS: NarrationTopic[] = [
  "board", "agent", "decision", "gate", "override", "share", "intake", "connection", "settings", "machine", "people", "remote", "other",
];

/**
 * True for an agent.* or override.* entry whose payload names `runId`: what can change that run's working copy. A
 * linked machine's mirrored entry counts as the worker entry it carries.
 */
export function namesRun(e: LedgerEntry, runId: string): boolean {
  const inner = innerEntry(e);
  if (!inner.type.startsWith("agent.") && !inner.type.startsWith("override.")) return false;
  return runIdOf(inner) === runId;
}

/**
 * True when `runs` lists `runId` as running. The server refuses every view of a live run's working copy (409
 * run_active), so nothing asks for one until the run is stopped or finished; an unknown run is asked about.
 */
export function runIsLive(runs: readonly AgentRun[], runId: string | null): boolean {
  return runId !== null && runs.some((r) => r.id === runId && r.status === "running");
}

/** What an emergency override request came to: recorded, or refused with a message for the Owner. */
export type OverrideOutcome<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Everything the shell shows and every action it can take; App owns the data and the API calls. */
export type WorkbenchModel = {
  projects: Project[];
  selectedId: string | null;
  onSelectProject: (id: string) => void;
  onCreateProject: (name: string) => void;
  /** A project made from a source (files, GitHub, a folder): added to the list and selected. */
  onProjectCreated: (p: Project) => void;
  /** Home's runs: the selected project's, or every project's in the "all" scope; reloaded on agent.*, run.* and link.mirrored entries. */
  home: { data: HomeRuns | null; error: string | null; scope: "project" | "all"; setScope(s: "project" | "all"): void; refresh(): void };
  /** The selected project's top-level files; reloaded on project.* entries and run.accepted. */
  projectFiles: { data: ProjectFiles | null; error: string | null; refresh(): void };
  /** Accepts a finished run's changes into the project; true when the server did it, else the error is shown. */
  onAcceptRun: (runId: string) => Promise<boolean>;

  board: Board | null;
  onAddCard: (stage: Stage, title: string) => void;
  /** Checks the move's gates first: moves at once when every gate passes, else sets `gate`. */
  onMoveCard: (cardId: string, to: Stage) => Promise<void>;
  /**
   * The gated move waiting on the Owner, or null. Its evaluations are fetched again on any agent.*, card.*,
   * intake.* or gate.* entry of the card's project while it is set.
   */
  gate: GatePrompt | null;
  /**
   * Moves with the decisions; true when moved. When the server refuses them, refreshes the evaluations and keeps the
   * card. False at once, sending nothing, while an earlier call is still in flight.
   */
  onResolveGate: (decisions: GateDecisionInput[]) => Promise<boolean>;
  onCancelGate: () => void;
  /** The selected project's cards with their run, progress and note counts; reloaded 500 ms after a card.*, agent.* or preview.screenshot entry. */
  cardInfos: { data: Record<string, CardInfo>; refresh(): void };
  /** Selects the request's project, then asks for its move through `onMoveCard`, so the gate card and its sign-off do it. */
  onReviewMove: (r: CardMoveRequest) => Promise<void>;
  /** Records that the person declined an agent's move request; true when the server did it. */
  onDeclineMove: (cardId: string) => Promise<boolean>;
  /** A card's story, read from the server each time. */
  story: (cardId: string) => Promise<CardStory>;
  /** Calls `onEntry` for every new ledger entry of any project until the returned function is called. */
  subscribeEntries: (onEntry: (e: LedgerEntry) => void) => () => void;

  agentsInfo: AgentsInfo | null;
  runs: AgentRun[];
  selectedRunId: string | null;
  runActions: AgentAction[];
  /**
   * Resolves false when starting failed, so the prompt is kept. `cardId` ties the run to a card; `machineId` sends the
   * run to that linked machine.
   */
  onStartRun: (
    adapter: AdapterId,
    prompt: string,
    connectionIds: string[],
    cardId?: string | null,
    machineId?: string,
    /** `autoCard` has the server make the job's card at its start (a job started from Home). */
    opts?: { autoCard?: boolean },
  ) => Promise<boolean>;
  onSelectRun: (runId: string | null) => void;
  onStopRun: (runId: string) => void;

  pending: PendingAgentAction[];
  /** Sends the decision; resolves false at once, sending nothing, while a decision on the same action is in flight. */
  onDecide: (id: string, decision: "allow" | "deny", reason?: string) => Promise<unknown>;

  /** The entries the ledger panel shows: the selected project's, or every project's, by `ledgerScope`. */
  entries: LedgerEntry[];
  /** The selected project's stream, whatever the ledger scope: what the Agent feed and the Terminal are made from. */
  projectEntries: LedgerEntry[];
  /** The run the Agent feed and the Terminal follow; null follows every run of the project. */
  feedRunId: string | null;
  onFollowRun: (runId: string | null) => void;
  /** True while the server may hold entries older than the oldest loaded for the ledger scope. */
  ledgerHasOlder: boolean;
  /** Fetches the 500 entries before the oldest loaded for the ledger scope and puts them in front. */
  onLoadOlderLedger: () => Promise<void>;
  /** The ledger scope's older-page request: in flight, and why the last one failed (null when it did not). */
  ledgerOlder: { loading: boolean; error: string | null };
  /**
   * The same for the selected project's stream (`projectEntries`), whatever the ledger scope: whether older entries
   * may exist, the older-page request in flight, and why the last one failed.
   */
  projectOlder: { hasOlder: boolean; loading: boolean; error: string | null };
  /** Fetches the 500 entries before the oldest loaded of the selected project's stream and puts them in front. */
  onLoadOlderProject: () => Promise<void>;
  ledgerScope: LedgerScope;
  onLedgerScopeChange: (scope: LedgerScope) => void;
  /** Which narration topics the ledger shows; every topic by default. */
  ledgerTopics: NarrationTopic[];
  onLedgerTopicsChange: (topics: NarrationTopic[]) => void;
  /**
   * What narration may know beyond an entry: card titles from the board, adapter names from the runs, the names of
   * linked machines (what the run lists, the feed and the decision cards show for a run on one, too).
   */
  narration: NarrationContext;

  /** Resolves true when the server accepted the change. */
  onProviderAuthChange: (provider: Provider, mode: AuthMode, acknowledgement?: string) => Promise<boolean>;

  connections: ConnectionsModel;

  /** The server's status counts for the status bar; null until the first answer. */
  status: Status | null;

  /** The GitHub view's data: the last overview, or the error code of the last failed load. */
  github: { overview: GitHubOverview | null; error: string | null; refresh: () => void };

  /** The Capacity view's data: the last report, or the error code of the last failed load. */
  capacity: { report: CapacityReport | null; error: string | null; refresh: () => void };

  /**
   * The Machines view's data: this computer, the linked machines and those found on the network, or the error code of
   * the last failed load. The view and the Link a machine tab ask for it; any machine.* entry reloads it once asked.
   */
  machines: {
    overview: LinkOverview | null;
    error: string | null;
    refresh: () => void;
    /** What one linked machine offers a run (its agents and connections), from the server's 30 s cache. */
    capacity?: (machineId: string) => Promise<MachineCapacity>;
    /**
     * The paired machines as last seen, loaded while any is paired without asking them or browsing the network (names
     * and the Run on picker); `refreshPaired` reads them again.
     */
    paired?: MachinePresence[];
    refreshPaired?: () => void;
  };

  /**
   * The Share view's data for the selected project. Snapshots and links reload on any share.* entry of the project;
   * the addresses load when the Share view opens (`loadAddresses`). Changing the options drops the preview, so what
   * is confirmed is always what was chosen.
   */
  share: {
    options: ShareOptions;
    onOptionsChange(o: ShareOptions): void;
    preview: SharePreview | null;
    previewing: boolean;
    /**
     * Generates the page for the Owner to read: true once the preview is shown; false, sending nothing, with no
     * project or while a preview is being made. A refusal rejects with the server's error.
     */
    onPreview(): Promise<boolean>;
    /**
     * Saves the previewed page: true once saved, and the preview is dropped (another save needs a new preview);
     * false, sending nothing, with no preview or while a confirm is in flight. A refusal rejects with the server's
     * error; a stale or expired preview is dropped first.
     */
    onConfirm(): Promise<boolean>;
    snapshots: ShareSnapshotRecord[];
    links: ShareLink[];
    addresses: ShareAddress[];
    /** The error code of the last failed address load, or null; cleared by a load that succeeds. */
    addressesError: string | null;
    loadAddresses(): void;
    /** The new link's url, shown once; null, sending nothing, with no project. A refusal rejects with the error. */
    onCreateLink(shareId: string, address: string, ttlMinutes: number): Promise<{ url: string } | null>;
    /** True once revoked. A refusal rejects with the server's error. */
    onRevokeLink(id: string): Promise<boolean>;
  };

  /**
   * The selected project's daily digests over the last `days`; null while loading. The Daily digest tab calls
   * `watch` when it mounts and the returned function when it unmounts: digests load when a watcher appears and
   * reload on the project's entries (coalesced) only while one is there, never while the tab is closed.
   */
  digests: { days: DigestDays; onDaysChange(d: DigestDays): void; list: DailyDigest[] | null; watch(): () => void };

  /**
   * The selected project's guided intake: null when it has none, undefined while loading. Reloaded on any
   * intake.* or card.* entry of the selected project.
   */
  intake: IntakeView | null | undefined;
  /** Why the intake cannot load (the project no longer exists), shown instead of loading; absent otherwise. */
  intakeError?: string | null;
  /** Each resolves true when the server accepted the change; a refusal is shown as the error message. */
  onStartIntake: (idea: string) => Promise<boolean>;
  onAnswerIntake: (questionId: QuestionId, answer: IntakeAnswer) => Promise<boolean>;
  onDecideIntake: (decisionId: DecisionId, chosen: string, rationale?: string) => Promise<boolean>;
  onCompleteIntake: () => Promise<boolean>;
  onReopenIntake: (reason: string) => Promise<boolean>;

  /** False when the server answers 404 for the run; used to close restored diff and file tabs of deleted runs. */
  runExists: (runId: string) => Promise<boolean>;

  /** The run the Changes view shows: the one picked there, else the selected run, else the project's newest. */
  changesRunId: string | null;
  /** Picks the Changes view's run; null goes back to following the selected run. */
  onSelectChangesRun: (runId: string | null) => void;
  /** What `changesRunId` changed; reloaded on any agent.* or override.* entry naming it. Null while loading. */
  changes: RunChanges | null;
  /** Why the changes could not load, worded for the Owner; null otherwise. */
  changesError: string | null;
  /** A run's changes, remembered for 10 s per run. */
  runChanges: (runId: string) => Promise<RunChanges>;
  dir: (runId: string, path: string) => Promise<DirListing>;
  file: (runId: string, path: string) => Promise<FileContent>;
  diff: (runId: string, path: string) => Promise<FileDiff>;
  /**
   * Emergency override: runs a program as the Owner in the run's working copy, or drops its uncommitted changes.
   * Each resolves `ok: true` when the server recorded it (a discard with how many uncommitted files it dropped), and
   * `ok: false` with the refusal worded for the Owner, for the form to show.
   */
  onOverrideCommand: (runId: string, i: { program: string; args: string[]; cwd?: string; reason: string }) => Promise<OverrideOutcome>;
  onOverrideDiscard: (runId: string, reason: string) => Promise<OverrideOutcome<{ files: number }>>;
  /** Opens (or shows) the diff tab of one file of a run. */
  onOpenDiff: (runId: string, path: string) => void;
  /** Opens (or shows) the read-only tab of one file of a run. */
  onOpenFile: (runId: string, path: string) => void;
  /** Opens (or shows) the Preview tab `preview:<runId>` in the main group. */
  openPreview: (runId: string) => void;

  /**
   * Who is signed in; absent or null (not known) counts as a viewer. The UI disables what the role cannot do; the
   * server is the real guard.
   */
  me?: Me | null;
  /** Who is here now and what they look at, as the event stream last said. */
  presence?: PresenceEntry[];
  /** Everyone in the workspace (removed people excluded). */
  people?: Person[];
  /** The pending invitations: the Owner's only. */
  invites?: Invite[];
  /** `GET /api/remote`: the whole state for the Owner, on/off for anyone else; null until read. */
  remote?: RemoteInfo | null;
  /** Reads me, people, invitations and remote access again (after a change made on the People view). */
  refreshPeople?: () => void;
  /** The server answered with the person's new `Me` (a credential added, a rename). */
  onMeChange?: (me: Me) => void;
  /** After the Owner changed who may sign a gate: the open gate's checklist is read again. */
  onRequirementChanged?: () => void;
  /** The view the person is looking at changed: what presence reports. */
  onViewChange?: (view: ViewId) => void;
};

/**
 * The role the UI acts for: the signed-in person's. Without one (no model, `me` absent or null) it is a viewer, so the
 * display fails closed; the server is the real guard either way.
 */
export function roleOf(model: Pick<WorkbenchModel, "me"> | null | undefined): Role {
  return model?.me?.role ?? "viewer";
}

/** What a gate card needs to know of the person at it, and of everyone (to name a requirement's person). */
export function gateAccess(model: WorkbenchModel) {
  const role = roleOf(model);
  return {
    viewer: { personId: model.me?.personId ?? "owner", role },
    people: model.people ?? [],
    ...(model.selectedId !== null && { projectId: model.selectedId }),
    ...(model.onRequirementChanged !== undefined && { onRequirementChanged: model.onRequirementChanged }),
  };
}

/** The title on a control the role cannot use. */
export const roleTitle = (role: Role): string => `Your role (${ROLE_LABELS[role]}) cannot do this.`;

/** `disabled` and `title` for a control that needs `min`: nothing when the role has it. */
export function gateFor(role: Role, min: Role): { disabled: boolean; title?: string } {
  return atLeast(role, min) ? { disabled: false } : { disabled: true, title: roleTitle(role) };
}

/**
 * The role a component rendered outside the shell acts for (a card on its own); without it, and without a shell, the
 * role is a viewer's.
 */
export const RoleContext = createContext<Role | null>(null);

/** The role of whoever is at the shell, else the one RoleContext gives, else a viewer's. */
export function useViewerRole(): Role {
  const shell = useContext(ShellContext);
  const given = useContext(RoleContext);
  if (shell) return roleOf(shell.model);
  return given ?? "viewer";
}

/** What App provides: the shell adds the actions that open tabs, since it owns the dock. */
export type AppModel = Omit<WorkbenchModel, "onOpenDiff" | "onOpenFile" | "openPreview">;

export type ShellContextValue = {
  model: WorkbenchModel;
  dock: () => DockApi | null;
  /** The activity bar's action: selecting the active view again hides the side bar. */
  selectView: (view: ViewId) => void;
  /** Shows a view in the side bar and never hides it: for every navigation that is not the activity bar. */
  showView: (view: ViewId) => void;
  /** Shows the Learn view open on the topic. */
  openLearn: (topicId: string) => void;
  /** The topic the last openLearn named, or null. */
  learnTopic: string | null;
  /** The view the Owner is looking at: the active view, or the last one before Learn while Learn is shown. */
  contextView: ViewId;
  /**
   * True while the Needs-you strip above the dock is showing (anything pending, a plan waiting or a stopped move):
   * other copies of its cards are then read-only, so each decision is made in one place.
   */
  stripShown: boolean;
};

/** Dock panels render through portals, so they read the model from context rather than props. */
export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside the Workbench");
  return ctx;
}
