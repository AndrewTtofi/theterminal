import { useState } from "react";
import { KIND_LABELS } from "@theterminal/shared";
import type { ActionKind, AdapterId, AgentAction, AgentRun, AuthMode, Connection, Provider } from "@theterminal/shared";
import { CODEX_MCP_NOTE } from "../api";

export const KIND_ICON: Record<ActionKind, string> = {
  file_read: "📄",
  file_write: "✏️",
  file_edit: "✏️",
  shell: "⌨️",
  web: "🌐",
  mcp: "🔌",
  other: "•",
};

export const ADAPTER_NAMES: Record<AdapterId, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", fake: "Fake" };

type Props = {
  adapters: AdapterId[];
  /** Per-provider availability of its bundled program; a missing entry means the adapter is always available. */
  providers?: Partial<Record<Provider, { mode: AuthMode; available: boolean }>>;
  /** Every connection; the enabled cloud accounts and MCP servers are offered to the run. */
  connections?: Connection[];
  runs: AgentRun[];
  selectedRunId: string | null;
  /** The selected run's actions; omit them when another panel (the Agent feed) shows them. */
  actions?: AgentAction[];
  /** Resolve false (or reject) when starting failed, so the prompt is kept. */
  onStart: (adapter: AdapterId, prompt: string, connectionIds: string[]) => Promise<boolean | void> | void;
  onSelectRun: (runId: string | null) => void;
  onStop: (runId: string) => void;
};

export const cost = (r: AgentRun) => (r.costUsd == null ? "" : ` · $${r.costUsd.toFixed(2)}`);
export const decidedBy = (a: AgentAction) => (a.decidedBy ? ` · decided by ${a.decidedBy}` : "");

export function AgentPanel({ adapters, providers, connections = [], runs, selectedRunId, actions, onStart, onSelectRun, onStop }: Props) {
  const [adapter, setAdapter] = useState<AdapterId | "">("");
  const [prompt, setPrompt] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  // Every provider's program ships with The Terminal, so an unavailable one means a broken install.
  const available = (a: AdapterId) => {
    const info = a === "fake" ? undefined : providers?.[a];
    return !info || info.available;
  };
  const chosen = adapter || adapters.find(available) || "";
  const selected = runs.find((r) => r.id === selectedRunId);
  const offered = connections.filter((c) => c.enabled && (c.kind === "cloud" || c.kind === "mcp"));
  // Codex gets no MCP server: a ticked one stays ticked for another agent, but is never sent.
  const usable = (c: Connection) => !(chosen === "codex" && c.kind === "mcp");
  const connectionIds = offered.filter((c) => picked.includes(c.id) && usable(c)).map((c) => c.id);

  return (
    <section className="agent-panel" aria-label="Agents">
      <h2>Agents</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!chosen || !prompt.trim() || starting) return;
          setStarting(true);
          void Promise.resolve(onStart(chosen, prompt.trim(), connectionIds))
            .then((ok) => {
              if (ok !== false) setPrompt("");
            })
            .catch(() => {})
            .finally(() => setStarting(false));
        }}
      >
        <label>
          Agent
          <select value={chosen} onChange={(e) => setAdapter(e.target.value as AdapterId)}>
            {adapters.map((a) => (
              <option key={a} value={a} disabled={!available(a)}>
                {ADAPTER_NAMES[a]}
                {available(a) ? "" : " (unavailable)"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Prompt
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} maxLength={20000} />
        </label>
        {offered.length > 0 && (
          <fieldset className="run-connections">
            <legend>Give this run access to</legend>
            {offered.map((c) => (
              <label key={c.id}>
                <input
                  type="checkbox"
                  checked={picked.includes(c.id) && usable(c)}
                  disabled={!usable(c)}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setPicked((prev) => (on ? [...prev, c.id] : prev.filter((id) => id !== c.id)));
                  }}
                />
                {c.name} ({KIND_LABELS[c.kind]})
              </label>
            ))}
            {chosen === "codex" && offered.some((c) => c.kind === "mcp") && <p className="note">{CODEX_MCP_NOTE}</p>}
          </fieldset>
        )}
        <button type="submit" disabled={!chosen || !prompt.trim() || starting}>
          Start agent
        </button>
      </form>
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
