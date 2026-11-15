import { createContext, useContext } from "react";
import type {
  AdapterId,
  AgentAction,
  AgentRun,
  AuthMode,
  Board,
  CapacityReport,
  CardStory,
  DecisionId,
  DirListing,
  FileContent,
  FileDiff,
  GateDecisionInput,
  GateEvaluation,
  GitHubOverview,
  IntakeAnswer,
  IntakeView,
  LedgerEntry,
  NarrationContext,
  NarrationTopic,
  PendingAgentAction,
  Project,
  Provider,
  QuestionId,
  RunChanges,
  Stage,
} from "@theterminal/shared";
import type { AgentsInfo, Status } from "../api";
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
export const LEDGER_TOPICS: NarrationTopic[] = ["board", "agent", "decision", "gate", "override", "intake", "connection", "settings", "other"];

/** True for an agent.* or override.* entry whose payload names `runId`: what can change that run's working copy. */
export function namesRun(e: LedgerEntry, runId: string): boolean {
  if (!e.type.startsWith("agent.") && !e.type.startsWith("override.")) return false;
  const p = e.payload;
  return typeof p === "object" && p !== null && (p as Record<string, unknown>).runId === runId;
}

/** Everything the shell shows and every action it can take; App owns the data and the API calls. */
export type WorkbenchModel = {
  projects: Project[];
  selectedId: string | null;
  onSelectProject: (id: string) => void;
  onCreateProject: (name: string) => void;

  board: Board | null;
  onAddCard: (stage: Stage, title: string) => void;
  /** Checks the move's gates first: moves at once when every gate passes, else sets `gate`. */
  onMoveCard: (cardId: string, to: Stage) => Promise<void>;
  /**
   * The gated move waiting on the Owner, or null. Its evaluations are fetched again on any agent.*, card.*,
   * intake.* or gate.* entry of the card's project while it is set.
   */
  gate: GatePrompt | null;
  /** Moves with the decisions; true when moved. When the server refuses them, refreshes the evaluations and keeps the card. */
  onResolveGate: (decisions: GateDecisionInput[]) => Promise<boolean>;
  onCancelGate: () => void;
  /** A card's story, read from the server each time. */
  story: (cardId: string) => Promise<CardStory>;
  /** Calls `onEntry` for every new ledger entry of any project until the returned function is called. */
  subscribeEntries: (onEntry: (e: LedgerEntry) => void) => () => void;

  agentsInfo: AgentsInfo | null;
  runs: AgentRun[];
  selectedRunId: string | null;
  runActions: AgentAction[];
  /** Resolves false when starting failed, so the prompt is kept. `cardId` ties the run to a card. */
  onStartRun: (adapter: AdapterId, prompt: string, connectionIds: string[], cardId?: string | null) => Promise<boolean>;
  onSelectRun: (runId: string | null) => void;
  onStopRun: (runId: string) => void;

  pending: PendingAgentAction[];
  onDecide: (id: string, decision: "allow" | "deny", reason?: string) => Promise<unknown>;

  entries: LedgerEntry[];
  ledgerScope: LedgerScope;
  onLedgerScopeChange: (scope: LedgerScope) => void;
  /** Which narration topics the ledger shows; every topic by default. */
  ledgerTopics: NarrationTopic[];
  onLedgerTopicsChange: (topics: NarrationTopic[]) => void;
  /** What narration may know beyond an entry: card titles from the board, adapter names from the runs. */
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
   * Each resolves true when the server recorded it, and false when it was refused, with the refusal shown.
   */
  onOverrideCommand: (runId: string, i: { program: string; args: string[]; cwd?: string; reason: string }) => Promise<boolean>;
  onOverrideDiscard: (runId: string, reason: string) => Promise<boolean>;
  /** Opens (or shows) the diff tab of one file of a run. */
  onOpenDiff: (runId: string, path: string) => void;
  /** Opens (or shows) the read-only tab of one file of a run. */
  onOpenFile: (runId: string, path: string) => void;
};

/** What App provides: the shell adds the actions that open tabs, since it owns the dock. */
export type AppModel = Omit<WorkbenchModel, "onOpenDiff" | "onOpenFile">;

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
};

/** Dock panels render through portals, so they read the model from context rather than props. */
export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside the Workbench");
  return ctx;
}
