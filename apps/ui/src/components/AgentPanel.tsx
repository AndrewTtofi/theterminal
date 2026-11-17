import { jobTitle, progressPercent, visibleControls } from "@theterminal/shared";
import type {
  ActionKind, AdapterId, AgentAction, AgentRun, AuthMode, Card, ConnectionSummary, MachineCapacity, MachinePresence, Provider, Role,
} from "@theterminal/shared";
import { runCost } from "./cost";
import { ProgressBar, progressKey } from "./ProgressBar";
import { StartRunForm } from "./StartRunForm";
import { gateFor } from "../shell/model";

export const KIND_ICON: Record<ActionKind, string> = {
  file_read: "📄",
  file_write: "✏️",
  file_edit: "✏️",
  shell: "⌨️",
  web: "🌐",
  mcp: "🔌",
  other: "•",
};

/** Re-exported for the panels that name adapters. */
export { ADAPTER_NAMES } from "./StartRunForm";

type Props = {
  adapters: AdapterId[];
  /** Per-provider availability of its bundled program; a missing entry means the adapter is always available. */
  providers?: Partial<Record<Provider, { available: boolean; mode?: AuthMode }>>;
  /** Every connection, in full or as summaries; the enabled cloud accounts and MCP servers are offered to the run. */
  connections?: ConnectionSummary[];
  /** Who is at the panel; the Owner when absent. Below the Owner, the start form says runs use the Owner's API key. */
  viewer?: { role: Role };
  /** The project's cards; the run can be tied to one of them. */
  cards?: Card[];
  runs: AgentRun[];
  selectedRunId: string | null;
  /** The selected run's actions; omit them when another panel (the Agent feed) shows them. */
  actions?: AgentAction[];
  /** True when the server inferred that the internet is unreachable; passed to the start form. */
  offline?: boolean;
  /** Resolve false (or reject) when starting failed, so the prompt is kept. `cardId` is passed only when a card is chosen. */
  onStart: (adapter: AdapterId, prompt: string, connectionIds: string[], cardId?: string, machineId?: string) => Promise<boolean | void> | void;
  onSelectRun: (runId: string | null) => void;
  onStop: (runId: string) => void;
  /** The paired machines, for the start form's `Run on`, and what one offers a run when it is chosen. */
  machines?: MachinePresence[];
  machineCapacity?: (machineId: string) => Promise<MachineCapacity>;
  /** This computer's name for a linked machine, shown after the adapter of a run on it. */
  machineName?: (machineId: string) => string | undefined;
};

/** ` on GPU box` for a run on a linked machine (`a linked machine` when its name is unknown); nothing otherwise. */
export function onMachine(r: AgentRun, machineName?: (machineId: string) => string | undefined): string {
  if (r.machineId === null) return "";
  return ` on ${visibleControls(machineName?.(r.machineId) ?? "a linked machine")}`;
}

/** ` · $0.50 (estimate)`, with its basis; nothing for a run that reported no cost. */
export const cost = (r: AgentRun) => (r.costUsd == null ? "" : ` · ${runCost(r)}`);
export const decidedBy = (a: AgentAction) => (a.decidedBy ? ` · decided by ${a.decidedBy}` : "");

export function AgentPanel({
  adapters, providers, connections = [], cards = [], runs, selectedRunId, actions, offline, onStart, onSelectRun, onStop, machines,
  machineCapacity, machineName, viewer,
}: Props) {
  const selected = runs.find((r) => r.id === selectedRunId);
  const mayStop = gateFor(viewer?.role ?? "owner", "maintainer");

  return (
    <section className="agent-panel" aria-label="Agents">
      <h2>Agents</h2>
      <StartRunForm
        adapters={adapters} providers={providers} cards={cards} connections={connections} offline={offline} onStart={onStart}
        {...(machines !== undefined && { machines })} {...(machineCapacity !== undefined && { machineCapacity })}
        {...(viewer !== undefined && { viewerRole: viewer.role })}
      />
      <ul className="runs">
        {runs.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className={r.id === selectedRunId ? "selected" : ""}
              aria-pressed={r.id === selectedRunId}
              onClick={() => onSelectRun(r.id === selectedRunId ? null : r.id)}
            >
              {r.adapter}
              {onMachine(r, machineName)}: {r.prompt.slice(0, 40)} ({r.status}
              {cost(r)})
            </button>
            {r.status === "running" && <ProgressBar key={progressKey(r.id, r.progress?.steps.length ?? 0)} percent={progressPercent(r.progress)} label={jobTitle(r)} />}
            {r.status === "running" && (
              <button type="button" disabled={mayStop.disabled} title={mayStop.title} onClick={() => onStop(r.id)}>
                Stop
              </button>
            )}
          </li>
        ))}
      </ul>
      {selected && actions && (
        <ul className="run-actions" aria-label="Run actions">
          {actions.map((a) => (
            <li key={a.id}>
              <span aria-hidden="true">{KIND_ICON[a.kind]}</span> {a.summary} · {a.status}
              {decidedBy(a)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
