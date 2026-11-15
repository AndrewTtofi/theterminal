import { createContext, useContext } from "react";
import type {
  AdapterId,
  AgentAction,
  AgentRun,
  AuthMode,
  Board,
  CapacityReport,
  GitHubOverview,
  LedgerEntry,
  NarrationContext,
  NarrationTopic,
  PendingAgentAction,
  Project,
  Provider,
  Stage,
} from "@theterminal/shared";
import type { AgentsInfo, Status } from "../api";
import type { ConnectionsModel } from "../use-connections";
import type { DockApi } from "./Dock";
import type { ViewId } from "./views";

export type LedgerScope = "project" | "all";

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
  onMoveCard: (cardId: string, to: Stage) => void;

  agentsInfo: AgentsInfo | null;
  runs: AgentRun[];
  selectedRunId: string | null;
  runActions: AgentAction[];
  /** Resolves false when starting failed, so the prompt is kept. */
  onStartRun: (adapter: AdapterId, prompt: string, connectionIds: string[]) => Promise<boolean>;
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
};

export type ShellContextValue = { model: WorkbenchModel; dock: () => DockApi | null; selectView: (view: ViewId) => void };

/** Dock panels render through portals, so they read the model from context rather than props. */
export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside the Workbench");
  return ctx;
}
