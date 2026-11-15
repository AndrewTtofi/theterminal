import type { ActionKind, AdapterId, AgentAction, AgentRun, AuthMode, Card, Connection, Provider } from "@theterminal/shared";
import { runCost } from "./cost";
import { StartRunForm } from "./StartRunForm";

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
  providers?: Partial<Record<Provider, { mode: AuthMode; available: boolean }>>;
  /** Every connection; the enabled cloud accounts and MCP servers are offered to the run. */
  connections?: Connection[];
  /** The project's cards; the run can be tied to one of them. */
  cards?: Card[];
  runs: AgentRun[];
  selectedRunId: string | null;
  /** The selected run's actions; omit them when another panel (the Agent feed) shows them. */
  actions?: AgentAction[];
  /** True when the server inferred that the internet is unreachable; passed to the start form. */
  offline?: boolean;
  /** Resolve false (or reject) when starting failed, so the prompt is kept. `cardId` is passed only when a card is chosen. */
  onStart: (adapter: AdapterId, prompt: string, connectionIds: string[], cardId?: string) => Promise<boolean | void> | void;
  onSelectRun: (runId: string | null) => void;
  onStop: (runId: string) => void;
};

/** ` · $0.50 (estimate)`, with its basis; nothing for a run that reported no cost. */
export const cost = (r: AgentRun) => (r.costUsd == null ? "" : ` · ${runCost(r)}`);
export const decidedBy = (a: AgentAction) => (a.decidedBy ? ` · decided by ${a.decidedBy}` : "");

export function AgentPanel({ adapters, providers, connections = [], cards = [], runs, selectedRunId, actions, offline, onStart, onSelectRun, onStop }: Props) {
  const selected = runs.find((r) => r.id === selectedRunId);

  return (
    <section className="agent-panel" aria-label="Agents">
      <h2>Agents</h2>
      <StartRunForm adapters={adapters} providers={providers} cards={cards} connections={connections} offline={offline} onStart={onStart} />
      <ul className="runs">
        {runs.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className={r.id === selectedRunId ? "selected" : ""}
              aria-pressed={r.id === selectedRunId}
              onClick={() => onSelectRun(r.id === selectedRunId ? null : r.id)}
            >
              {r.adapter}: {r.prompt.slice(0, 40)} ({r.status}
              {cost(r)})
            </button>
            {r.status === "running" && (
              <button type="button" onClick={() => onStop(r.id)}>
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
