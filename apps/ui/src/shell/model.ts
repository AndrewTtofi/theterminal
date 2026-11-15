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

/** Every narration topic, in the order the ledger's filter lists them. */
export const LEDGER_TOPICS: NarrationTopic[] = ["board", "agent", "decision", "gate", "intake", "connection", "settings", "other"];

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
};

export type ShellContextValue = { model: WorkbenchModel; dock: () => DockApi | null; selectView: (view: ViewId) => void };

/** Dock panels render through portals, so they read the model from context rather than props. */
export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside the Workbench");
  return ctx;
}
