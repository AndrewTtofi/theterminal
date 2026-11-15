import { useEffect, useRef, useState } from "react";
import { KIND_LABELS, visibleControls } from "@theterminal/shared";
import type { AdapterId, AuthMode, Card, Connection, ConnectionSummary, MachineCapacity, MachinePresence, Provider, Role } from "@theterminal/shared";
import { CODEX_MCP_NOTE, GEMINI_MCP_NOTE, LOCAL_MODEL_NOTE } from "../api";
import { gateFor, useViewerRole } from "../shell/model";

export const OFFLINE_NOTE = "You seem to be offline. Cloud models will not answer; a local model will.";

export const ADAPTER_NAMES: Record<AdapterId, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", fake: "Fake" };

type Props = {
  adapters: AdapterId[];
  /** Per-provider availability of its bundled program; a missing entry means the adapter is always available. */
  providers?: Partial<Record<Provider, { available: boolean; mode?: AuthMode }>>;
  /** The project's cards; the run can be tied to one of them. */
  cards: Card[];
  /** Every connection (in full or as summaries); the enabled cloud accounts, MCP servers and local models are offered to the run. */
  connections: ConnectionSummary[];
  /** The role of the person at the form; below the Owner, a note says their runs use the Owner's API key. */
  viewerRole?: Role;
  /** The card chosen when the form opens; one no longer in `cards` is not sent. */
  defaultCardId?: string | null;
  /** True when the server inferred that the internet is unreachable; adds a note for cloud runs, never blocks one. */
  offline?: boolean;
  /** The submit button's label; `Start agent` by default. */
  submitLabel?: string;
  /** What a polite status announces once a run started (`Asked Claude.`), given the adapter's name; nothing when absent. */
  startedMessage?: (adapterName: string) => string;
  /** The paired machines; with any, a `Run on` picker offers them beside this computer (an offline one disabled). */
  machines?: MachinePresence[];
  /** What a linked machine offers a run (its agents and connections), asked when it is chosen. */
  machineCapacity?: (machineId: string) => Promise<MachineCapacity>;
  /**
   * Resolve false (or reject) when starting failed, so the prompt is kept. `cardId` is passed only when a card is chosen,
   * and `machineId` (after it, `cardId` then possibly undefined) only when the run goes to a linked machine.
   */
  onStart: (adapter: AdapterId, prompt: string, connectionIds: string[], cardId?: string, machineId?: string) => Promise<boolean | void> | void;
};

/** A connection a run can be given: one of this computer's, or one a linked machine says it has. */
type Offer = Pick<Connection, "id" | "kind" | "provider" | "name">;

/** Starts an agent run: the agent, an optional card, the prompt and the connections the run may use. */
export function StartRunForm({
  adapters, providers, cards, connections, defaultCardId, offline = false, submitLabel = "Start agent", startedMessage, machines = [],
  machineCapacity, onStart, viewerRole: givenRole,
}: Props) {
  // The role given, else the shell's: starting a run is a maintainer's.
  const shellRole = useViewerRole();
  const viewerRole: Role = givenRole ?? shellRole;
  const may = gateFor(viewerRole, "maintainer");
  const [adapter, setAdapter] = useState<AdapterId | "">("");
  const [prompt, setPrompt] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  // "" is this computer; otherwise a paired machine's id, and what it said it offers (null while asking, or failed).
  const [runOn, setRunOn] = useState("");
  const [offer, setOffer] = useState<{ machineId: string; caps: MachineCapacity | null; failed: boolean } | null>(null);
  const [cardId, setCardId] = useState(defaultCardId ?? "");
  const [starting, setStarting] = useState(false);
  const [announced, setAnnounced] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const target = runOn === "" ? null : (machines.find((m) => m.id === runOn) ?? null);
  const targetName = target === null ? "" : visibleControls(target.name);
  const caps = target !== null && offer?.machineId === target.id ? offer.caps : null;
  useEffect(() => {
    if (runOn === "" || !machineCapacity) return;
    let live = true;
    setOffer({ machineId: runOn, caps: null, failed: false });
    machineCapacity(runOn).then(
      (c) => live && setOffer({ machineId: runOn, caps: c, failed: false }),
      () => live && setOffer({ machineId: runOn, caps: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [runOn, machineCapacity]);
  // Every provider's program ships with The Terminal, so an unavailable one means a broken install. On a linked
  // machine, an agent is available when the machine said it has it.
  const available = (a: AdapterId) => {
    if (target !== null) return caps === null || caps.adapters.includes(a);
    const info = a === "fake" ? undefined : providers?.[a];
    return !info || info.available;
  };
  const chosen = adapter && available(adapter) ? adapter : adapters.find(available) || adapter || "";
  // On a linked machine the run gets that machine's connections, never this computer's (no credential crosses).
  const pool: Offer[] = target === null ? connections.filter((c) => c.enabled) : (caps?.connections ?? []);
  const shown = (c: Offer) => (target === null ? c.name : visibleControls(c.name));
  const offered = pool.filter((c) => c.kind === "cloud" || c.kind === "mcp");
  // Codex and Gemini get no MCP server: a ticked one stays ticked for another agent, but is never sent.
  const noMcpNote = chosen === "codex" ? CODEX_MCP_NOTE : chosen === "gemini" ? GEMINI_MCP_NOTE : null;
  const usable = (c: Offer) => !(noMcpNote !== null && c.kind === "mcp");
  // A local model runs only with Codex, and a run uses at most one: choosing one replaces the other.
  const locals = pool.filter((c) => c.provider === "local_model");
  const localUsable = chosen === "codex";
  const connectionIds = [
    ...offered.filter((c) => picked.includes(c.id) && usable(c)).map((c) => c.id),
    ...(localUsable ? locals.filter((c) => picked.includes(c.id)).map((c) => c.id) : []),
  ];
  // Offline, a cloud model will not answer: say so unless the run goes to the fake agent or a local model. The state
  // is this computer's own inference; nothing is known of a linked machine's internet, so the note is for runs here.
  const localChosen = localUsable && locals.some((c) => picked.includes(c.id));
  const offlineNote = target === null && offline && chosen !== "" && chosen !== "fake" && !localChosen;
  /** A collaborator's run is on the Owner's API key for the provider, never on anyone's subscription or login. */
  const apiKeyNote = viewerRole !== "owner" && chosen !== "" && chosen !== "fake" && !localChosen
    ? `Runs you start use the Owner's API key for ${ADAPTER_NAMES[chosen]}, never a personal subscription.`
    : null;
  /** The linked machine answered, and none of the agent programs is available there: nothing can start. */
  const noAgentThere = target !== null && caps !== null && !adapters.some(available);

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
        const started = target !== null
          ? onStart(chosen, prompt.trim(), connectionIds, card || undefined, target.id)
          : card ? onStart(chosen, prompt.trim(), connectionIds, card) : onStart(chosen, prompt.trim(), connectionIds);
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
      {machines.length > 0 && (
        <label>
          Run on
          <select
            aria-label="Run on"
            value={target === null ? "" : target.id}
            onChange={(e) => {
              // Connection ids belong to one machine: what was ticked for another is dropped.
              setPicked([]);
              setRunOn(e.target.value);
            }}
          >
            <option value="">This computer</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id} disabled={m.online === false || m.problem !== null}>
                {visibleControls(m.name)}
                {m.problem === "key_mismatch" ? " (key changed)" : m.online === false ? " (offline)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
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
      {apiKeyNote !== null && <p className="note api-key-note">{apiKeyNote}</p>}
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
          <legend>{target === null ? "Give this run access to" : `Give this run access to (on ${targetName})`}</legend>
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
              {shown(c)} ({KIND_LABELS[c.kind]})
            </label>
          ))}
          {noMcpNote !== null && offered.some((c) => c.kind === "mcp") && <p className="note">{noMcpNote}</p>}
        </fieldset>
      )}
      {locals.length > 0 && (
        <fieldset className="run-connections">
          <legend>{target === null ? "Run on a local model" : `Run on a local model (on ${targetName})`}</legend>
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
              {shown(c)}
            </label>
          ))}
          {!localUsable && <p className="note">{LOCAL_MODEL_NOTE}</p>}
        </fieldset>
      )}
      {target !== null && offer?.machineId === target.id && offer.failed && (
        <p className="note" role="status">Could not ask {targetName} what it offers.</p>
      )}
      {offlineNote && <p className="note offline-note">{OFFLINE_NOTE}</p>}
      {noAgentThere && <p className="note" role="status">{`${targetName} reports no agent program available, so nothing can start there.`}</p>}
      <button type="submit" disabled={!chosen || !prompt.trim() || starting || may.disabled} title={may.title}>
        {submitLabel}
      </button>
      <p className="started" role="status" aria-live="polite">
        {announced}
      </p>
    </form>
  );
}
