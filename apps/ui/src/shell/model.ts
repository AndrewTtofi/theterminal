import { createContext, useContext } from "react";
import type {
  AdapterId,
  AgentAction,
  AgentRun,
  AuthMode,
  Board,
  LedgerEntry,
  PendingAgentAction,
  Project,
  Provider,
  Stage,
} from "@theterminal/shared";
import type { AgentsInfo } from "../api";
import type { ConnectionsModel } from "../use-connections";
import type { DockApi } from "./Dock";

export type LedgerScope = "project" | "all";

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
  onStartRun: (adapter: AdapterId, prompt: string) => Promise<boolean>;
  onSelectRun: (runId: string | null) => void;
  onStopRun: (runId: string) => void;

  pending: PendingAgentAction[];
  onDecide: (id: string, decision: "allow" | "deny", reason?: string) => Promise<unknown>;

  entries: LedgerEntry[];
  ledgerScope: LedgerScope;
  onLedgerScopeChange: (scope: LedgerScope) => void;

  /** Resolves true when the server accepted the change. */
  onProviderAuthChange: (provider: Provider, mode: AuthMode, acknowledgement?: string) => Promise<boolean>;

  connections: ConnectionsModel;
};

export type ShellContextValue = { model: WorkbenchModel; dock: () => DockApi | null };

/** Dock panels render through portals, so they read the model from context rather than props. */
export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside the Workbench");
  return ctx;
}
