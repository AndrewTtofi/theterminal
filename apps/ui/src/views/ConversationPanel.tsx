import { useId, useMemo } from "react";
import { plural, visibleControls } from "@theterminal/shared";
import type { AgentRun, Card, LedgerEntry } from "@theterminal/shared";
import { runCost } from "../components/cost";
import { onMachine } from "../components/AgentPanel";
import { ADAPTER_NAMES, StartRunForm } from "../components/StartRunForm";
import { stripAnsi } from "../components/text";
import { useShell } from "../shell/model";
import { useFollowBottom } from "./use-follow-bottom";

/** One ask in the Conversation: the run, its card's title, what the agent said, and how its actions were decided. */
export type ConversationItem = {
  run: AgentRun;
  cardTitle: string | null;
  messages: string[];
  actions: { total: number; allowed: number; denied: number };
  /** True when older entries are not loaded and this run's start is not among the loaded ones: its counts are unknown. */
  partial: boolean;
};

const OLDER_NOTE = "Older entries are not loaded, so earlier asks may be missing answers or action counts.";
const ASK_NOTE = "Agents do the work. Describe what should change; the agent will ask before anything that affects your files or accounts.";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Recorded text as the Owner reads it: terminal codes dropped, hidden characters shown as escapes. */
const clean = (s: string) => visibleControls(stripAnsi(s));

/**
 * The project's asks and answers: each run, oldest first, with its card's title (null without a card, or when the
 * card has left the project), the agent's messages in ledger order, and its actions counted from the ledger. With
 * `hasOlder` (the server may hold entries before the oldest loaded), a run whose `agent.started` entry is not loaded
 * is `partial`: some of its entries are missing. Pure.
 */
export function conversationThread(runs: AgentRun[], entries: LedgerEntry[], cards: Card[], hasOlder = false): ConversationItem[] {
  const byRun = new Map<string, ConversationItem>();
  const thread = [...runs]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((run) => {
      const item: ConversationItem = {
        run,
        cardTitle: (run.cardId !== null && cards.find((c) => c.id === run.cardId)?.title) || null,
        messages: [],
        actions: { total: 0, allowed: 0, denied: 0 },
        partial: hasOlder,
      };
      byRun.set(run.id, item);
      return item;
    });
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    const p = isRecord(e.payload) ? e.payload : null;
    const item = p && typeof p.runId === "string" ? byRun.get(p.runId) : undefined;
    if (!item || !p) continue;
    if (e.type === "agent.started") item.partial = false;
    else if (e.type === "agent.message" && typeof p.text === "string") item.messages.push(p.text);
    else if (e.type === "agent.action.requested") item.actions.total += 1;
    else if (e.type === "agent.action.decided" && p.decision === "allow") item.actions.allowed += 1;
    else if (e.type === "agent.action.decided" && p.decision === "deny") item.actions.denied += 1;
  }
  return thread;
}

/**
 * `completed · 2 actions, 1 allowed, 1 denied · $0.10 (estimate)`; a running run has no cost yet, and a partial one
 * says its counts are unavailable rather than showing what little was loaded.
 */
function resultLine({ run, actions, partial }: ConversationItem): string {
  const counts = partial
    ? "action counts unavailable"
    : `${plural(actions.total, "action")}, ${actions.allowed} allowed, ${actions.denied} denied`;
  return run.status === "running" ? `${run.status} · ${counts}` : `${run.status} · ${counts} · ${runCost(run)}`;
}

/** Main tab: what the Owner asked the project's agents and what came of it, and a form to ask for a change. */
export function ConversationPanel() {
  const { model, dock, showView } = useShell();
  const { selectedId, board, runs, projectEntries, projectOlder } = model;
  const idBase = useId();
  const cards = useMemo(() => (board ? Object.values(board.columns).flat() : []), [board]);
  const thread = useMemo(
    () => conversationThread(runs, projectEntries, cards, projectOlder.hasOlder),
    [runs, projectEntries, cards, projectOlder.hasOlder],
  );
  const newest = thread[thread.length - 1];
  const follow = useFollowBottom<HTMLOListElement>(
    thread.map((t) => t.run.id),
    newest ? `${newest.messages.length}:${newest.actions.total}:${newest.run.status}` : "",
  );

  if (!selectedId) {
    return (
      <section className="conversation" aria-label="Conversation">
        <p className="empty">Select or create a project.</p>
      </section>
    );
  }

  return (
    <section className="conversation" aria-label="Conversation">
      {projectOlder.hasOlder && (
        <div className="older">
          <p className="note">{OLDER_NOTE}</p>
          <button type="button" disabled={projectOlder.loading} onClick={() => void model.onLoadOlderProject()}>
            Load older
          </button>
          {projectOlder.error !== null && <p role="alert">Older entries could not be loaded: {projectOlder.error}</p>}
        </div>
      )}
      {thread.length === 0 ? (
        <p className="empty">Nothing asked yet. Ask an agent below.</p>
      ) : (
        <ol className="thread" aria-label="Asks and answers" tabIndex={0} ref={follow.ref} onScroll={follow.onScroll}>
          {thread.map((t) => {
            const { run, cardTitle } = t;
            const title = cardTitle === null ? null : clean(cardTitle);
            const headingId = `${idBase}-${run.id}`;
            // A run on a linked machine says so, as the run lists do.
            const where = onMachine(run, model.narration?.machineName);
            return (
              <li key={run.id} data-key={run.id}>
                <article aria-labelledby={headingId}>
                  <header>
                    <h3 id={headingId}>
                      {title === null ? `You asked ${ADAPTER_NAMES[run.adapter]}${where}` : `You asked ${ADAPTER_NAMES[run.adapter]} on "${title}"${where}`}
                    </h3>
                    <time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleTimeString()}</time>
                  </header>
                  <blockquote>{clean(run.prompt)}</blockquote>
                  {t.messages.map((m, i) => (
                    <p key={i} className="agent-says">
                      {clean(m)}
                    </p>
                  ))}
                  <p className="result">{resultLine(t)}</p>
                  <div className="actions">
                    <button
                      type="button"
                      onClick={() => {
                        model.onSelectChangesRun(run.id);
                        showView("changes");
                      }}
                    >
                      Changes
                    </button>
                    {run.cardId !== null && title !== null && (
                      <button type="button" onClick={() => dock()?.open(`story:${run.cardId}`, title, "main")}>
                        Story
                      </button>
                    )}
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
      )}
      {follow.away && (
        <button type="button" className="jump" onClick={follow.jump}>
          Jump to latest{follow.fresh > 0 && <span role="status"> ({follow.fresh} new)</span>}
        </button>
      )}
      <section className="ask" aria-label="Ask an agent">
        <h2>Ask an agent</h2>
        <p className="note">{ASK_NOTE}</p>
        {model.agentsInfo ? (
          <StartRunForm
            adapters={model.agentsInfo.adapters}
            providers={model.agentsInfo.providers}
            cards={cards}
            connections={model.connections.list}
            offline={model.status?.network.state === "offline"}
            submitLabel="Ask"
            startedMessage={(name) => `Asked ${name}.`}
            onStart={model.onStartRun}
            machines={model.machines?.paired ?? []}
            {...(model.machines?.capacity !== undefined && { machineCapacity: model.machines?.capacity })}
          />
        ) : (
          <p className="empty">Loading agents…</p>
        )}
      </section>
    </section>
  );
}
