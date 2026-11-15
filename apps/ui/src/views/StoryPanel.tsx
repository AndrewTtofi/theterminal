import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatUsd, narrate, visibleControls } from "@theterminal/shared";
import type { CardStory, LedgerEntry, NarrationContext } from "@theterminal/shared";
import { ADAPTER_NAMES } from "../components/AgentPanel";
import { stageLabel } from "../components/Board";
import { RawRecord } from "../components/LedgerPanel";
import { useShell } from "../shell/model";

/** The entries that record a human decision, and the reason given with it. */
function decisionReason(e: LedgerEntry): { reason: string } | null {
  const p = typeof e.payload === "object" && e.payload !== null ? (e.payload as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  switch (e.type) {
    case "agent.action.decided":
      return p.by === "human" || (p.by === undefined && e.actor.kind === "human") ? { reason: text(p.reason) } : null;
    case "gate.waived":
      return { reason: text(p.reason) };
    case "gate.signed_off":
      return { reason: "" };
    case "intake.decided":
      return { reason: text(p.rationale) };
    default:
      return null;
  }
}

/** The warning for a story whose ledger rows failed the chain check or could not be read; never hidden. */
function integrityWarning(story: CardStory): string | null {
  if (story.integrity.ok && story.unreadable.length === 0) return null;
  let text = "Part of this card's record could not be read.";
  if (!story.integrity.ok) text += ` The ledger's integrity check failed at entry #${story.integrity.brokenAtSeq}.`;
  if (story.unreadable.length > 0) text += ` Unreadable entries: ${story.unreadable.map((u) => `#${u.seq}`).join(", ")}.`;
  return text;
}

/** A tab telling one card's story from the ledger: what happened, the decisions and why, and what agents cost. */
export function StoryPanel({ id }: { id: string }) {
  const { model } = useShell();
  const cardId = id.slice("story:".length);
  const [story, setStory] = useState<CardStory | null>(null);
  const [failed, setFailed] = useState(false);
  /** The runs of the story as last loaded, so an entry about one of them reloads it. */
  const runIds = useRef<Set<string>>(new Set());
  const load = useRef<() => void>(() => {});
  const storyOf = model.story;
  const headingId = useId();

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let again = false;
    const run = async (): Promise<void> => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      try {
        const s = await storyOf(cardId);
        if (cancelled) return;
        runIds.current = new Set(s.runs.map((r) => r.id));
        setStory(s);
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        inFlight = false;
        if (again && !cancelled) {
          again = false;
          void run();
        }
      }
    };
    load.current = () => void run();
    load.current();
    return () => {
      cancelled = true;
      load.current = () => {};
    };
    // storyOf comes from App's model, which is rebuilt each render; the card alone decides when to load.
  }, [cardId]);

  const subscribe = model.subscribeEntries;
  useEffect(
    () =>
      subscribe((e) => {
        const { refs } = narrate(e);
        if (refs.cardId === cardId || (refs.runId !== undefined && runIds.current.has(refs.runId))) load.current();
      }),
    [cardId, subscribe],
  );

  const narrated = useMemo(() => {
    if (!story) return [];
    const adapters = new Map(story.runs.map((r) => [r.id, ADAPTER_NAMES[r.adapter]] as const));
    const ctx: NarrationContext = {
      cardTitle: (c) => (c === story.card.id ? story.card.title : undefined),
      adapterName: (r) => adapters.get(r),
    };
    return [...story.entries].sort((a, b) => a.seq - b.seq).map((e) => ({ e, n: narrate(e, ctx) }));
  }, [story]);

  if (!story) {
    return <p className="empty">{failed ? "This card's story could not be loaded." : "Loading the story…"}</p>;
  }

  const title = visibleControls(story.card.title);
  const warning = integrityWarning(story);
  const decisions = narrated.flatMap(({ e, n }) => {
    const d = decisionReason(e);
    return d === null ? [] : [{ e, n, reason: d.reason }];
  });
  const nothingYet = narrated.every(({ e }) => e.type === "card.created");

  return (
    <section className="story" aria-label={`Story: ${title}`}>
      <header>
        <h2>{title}</h2>
        <p>
          {stageLabel(story.card.stage)} · {visibleControls(story.card.status)}
        </p>
        <p>{story.costUsd === null ? "No agent cost recorded" : `Agent cost so far: ${formatUsd(story.costUsd)} (estimate)`}</p>
      </header>
      {warning !== null && (
        <p className="banner" role="alert">
          {warning}
        </p>
      )}
      {failed && <p className="note">The story could not be refreshed; this is the last one loaded.</p>}
      <h3 id={`${headingId}-happened`}>What happened</h3>
      {nothingYet && <p className="empty">Nothing has happened on this card yet.</p>}
      <ol aria-labelledby={`${headingId}-happened`}>
        {narrated.map(({ e, n }) => (
          <li key={e.seq} className={n.attention ? "attention" : undefined}>
            <time dateTime={e.ts}>{new Date(e.ts).toLocaleString()}</time> · <span className="headline">{n.headline}</span>
            <RawRecord headline={n.headline} detail={n.detail} payload={e.payload} />
          </li>
        ))}
      </ol>
      <h3 id={`${headingId}-decisions`}>Decisions and why</h3>
      {decisions.length === 0 ? (
        <p className="empty">No decisions recorded yet.</p>
      ) : (
        <ul aria-labelledby={`${headingId}-decisions`}>
          {decisions.map(({ e, n, reason }) => (
            <li key={e.seq}>
              <span className="headline">{n.headline}</span>
              {reason !== "" && <p className="reason">Why: {visibleControls(reason)}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
