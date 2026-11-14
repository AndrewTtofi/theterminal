import { useState } from "react";
import type { ActionKind, AdapterId, AgentAction, AgentRun } from "@theterminal/shared";

const KIND_ICON: Record<ActionKind, string> = {
  file_read: "📄",
  file_write: "✏️",
  file_edit: "✏️",
  shell: "⌨️",
  web: "🌐",
  mcp: "🔌",
  other: "•",
};

type Props = {
  adapters: AdapterId[];
  runs: AgentRun[];
  selectedRunId: string | null;
  actions: AgentAction[];
  /** Resolve false (or reject) when starting failed, so the prompt is kept. */
  onStart: (adapter: AdapterId, prompt: string) => Promise<boolean | void> | void;
  onSelectRun: (runId: string | null) => void;
  onStop: (runId: string) => void;
};

const cost = (r: AgentRun) => (r.costUsd == null ? "" : ` · $${r.costUsd.toFixed(2)}`);
const decidedBy = (a: AgentAction) => (a.decidedBy ? ` · decided by ${a.decidedBy}` : "");

export function AgentPanel({ adapters, runs, selectedRunId, actions, onStart, onSelectRun, onStop }: Props) {
  const [adapter, setAdapter] = useState<AdapterId | "">("");
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  const chosen = adapter || adapters[0] || "";
  const selected = runs.find((r) => r.id === selectedRunId);

  return (
    <section className="agent-panel" aria-label="Agents">
      <h2>Agents</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!chosen || !prompt.trim() || starting) return;
          setStarting(true);
          void Promise.resolve(onStart(chosen, prompt.trim()))
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
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label>
          Prompt
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} maxLength={20000} />
        </label>
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
      {selected && (
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
