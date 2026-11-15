import { useRef, useState } from "react";
import { KIND_LABELS, visibleControls } from "@theterminal/shared";
import type { AdapterId, AuthMode, Card, Connection, Provider } from "@theterminal/shared";
import { CODEX_MCP_NOTE, GEMINI_MCP_NOTE, LOCAL_MODEL_NOTE } from "../api";

export const OFFLINE_NOTE = "You seem to be offline. Cloud models will not answer; a local model will.";

export const ADAPTER_NAMES: Record<AdapterId, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", fake: "Fake" };

type Props = {
  adapters: AdapterId[];
  /** Per-provider availability of its bundled program; a missing entry means the adapter is always available. */
  providers?: Partial<Record<Provider, { mode: AuthMode; available: boolean }>>;
  /** The project's cards; the run can be tied to one of them. */
  cards: Card[];
  /** Every connection; the enabled cloud accounts, MCP servers and local models are offered to the run. */
  connections: Connection[];
  /** The card chosen when the form opens; one no longer in `cards` is not sent. */
  defaultCardId?: string | null;
  /** True when the server inferred that the internet is unreachable; adds a note for cloud runs, never blocks one. */
  offline?: boolean;
  /** The submit button's label; `Start agent` by default. */
  submitLabel?: string;
  /** What a polite status announces once a run started (`Asked Claude.`), given the adapter's name; nothing when absent. */
  startedMessage?: (adapterName: string) => string;
  /** Resolve false (or reject) when starting failed, so the prompt is kept. `cardId` is passed only when a card is chosen. */
  onStart: (adapter: AdapterId, prompt: string, connectionIds: string[], cardId?: string) => Promise<boolean | void> | void;
};

/** Starts an agent run: the agent, an optional card, the prompt and the connections the run may use. */
export function StartRunForm({
  adapters, providers, cards, connections, defaultCardId, offline = false, submitLabel = "Start agent", startedMessage, onStart,
}: Props) {
  const [adapter, setAdapter] = useState<AdapterId | "">("");
  const [prompt, setPrompt] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [cardId, setCardId] = useState(defaultCardId ?? "");
  const [starting, setStarting] = useState(false);
  const [announced, setAnnounced] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  // Every provider's program ships with The Terminal, so an unavailable one means a broken install.
  const available = (a: AdapterId) => {
    const info = a === "fake" ? undefined : providers?.[a];
    return !info || info.available;
  };
  const chosen = adapter || adapters.find(available) || "";
  const offered = connections.filter((c) => c.enabled && (c.kind === "cloud" || c.kind === "mcp"));
  // Codex and Gemini get no MCP server: a ticked one stays ticked for another agent, but is never sent.
  const noMcpNote = chosen === "codex" ? CODEX_MCP_NOTE : chosen === "gemini" ? GEMINI_MCP_NOTE : null;
  const usable = (c: Connection) => !(noMcpNote !== null && c.kind === "mcp");
  // A local model runs only with Codex, and a run uses at most one: choosing one replaces the other.
  const locals = connections.filter((c) => c.enabled && c.provider === "local_model");
  const localUsable = chosen === "codex";
  const connectionIds = [
    ...offered.filter((c) => picked.includes(c.id) && usable(c)).map((c) => c.id),
    ...(localUsable ? locals.filter((c) => picked.includes(c.id)).map((c) => c.id) : []),
  ];
  // Offline, a cloud model will not answer: say so unless the run goes to the fake agent or a local model.
  const localChosen = localUsable && locals.some((c) => picked.includes(c.id));
  const offlineNote = offline && chosen !== "" && chosen !== "fake" && !localChosen;

  return (
    <form
      className="start-run"
      onSubmit={(e) => {
        e.preventDefault();
        if (!chosen || !prompt.trim() || starting) return;
        setStarting(true);
        setAnnounced("");
        const name = ADAPTER_NAMES[chosen];
        // A card that left the project since it was chosen is not sent.
        const card = cards.some((c) => c.id === cardId) ? cardId : "";
        const started = card ? onStart(chosen, prompt.trim(), connectionIds, card) : onStart(chosen, prompt.trim(), connectionIds);
        void Promise.resolve(started)
          .then((ok) => {
            if (ok === false) return;
            setPrompt("");
            if (startedMessage) setAnnounced(startedMessage(name));
            // Ready for the next one: the button the Owner pressed is disabled until a new prompt is typed.
            promptRef.current?.focus();
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
        Card (optional)
        <select value={cardId} onChange={(e) => setCardId(e.target.value)}>
          <option value="">No card</option>
          {cards.map((c) => (
            <option key={c.id} value={c.id}>
              {visibleControls(c.title)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Prompt
        <textarea ref={promptRef} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} maxLength={20000} />
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
          {noMcpNote !== null && offered.some((c) => c.kind === "mcp") && <p className="note">{noMcpNote}</p>}
        </fieldset>
      )}
      {locals.length > 0 && (
        <fieldset className="run-connections">
          <legend>Run on a local model</legend>
          {locals.map((c) => (
            <label key={c.id}>
              <input
                type="checkbox"
                checked={picked.includes(c.id) && localUsable}
                disabled={!localUsable}
                onChange={(e) => {
                  const on = e.target.checked;
                  const others = new Set(locals.map((l) => l.id));
                  setPicked((prev) => (on ? [...prev.filter((id) => !others.has(id)), c.id] : prev.filter((id) => id !== c.id)));
                }}
              />
              {c.name}
            </label>
          ))}
          {!localUsable && <p className="note">{LOCAL_MODEL_NOTE}</p>}
        </fieldset>
      )}
      {offlineNote && <p className="note offline-note">{OFFLINE_NOTE}</p>}
      <button type="submit" disabled={!chosen || !prompt.trim() || starting}>
        {submitLabel}
      </button>
      <p className="started" role="status" aria-live="polite">
        {announced}
      </p>
    </form>
  );
}
