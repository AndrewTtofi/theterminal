import { useMemo, useRef } from "react";
import { innerEntry, jobTitle, narrate, progressPercent, visibleControls } from "@theterminal/shared";
import type { LedgerEntry, Narration, NarrationContext } from "@theterminal/shared";
import { ADAPTER_NAMES, onMachine } from "../components/AgentPanel";
import { ProgressBar, StepChecklist } from "../components/ProgressBar";
import { OverrideTag, RawRecord, entryClass, isOverride } from "../components/LedgerPanel";
import { clip, stripAnsiDeep } from "../components/text";
import { namesRun, useShell } from "../shell/model";
import { useFollowBottom } from "./use-follow-bottom";

/** The most items the Agent feed paints: the newest ones. */
export const FEED_LIMIT = 500;
const PROMPT_CLIP = 40;

/** True for what the feed shows: what agents did and said (here or on a linked machine), and the Owner's overrides. */
const inFeed = (e: LedgerEntry) => innerEntry(e).type.startsWith("agent.") || isOverride(e);

/**
 * The marker an entry's line starts with, as a class: `prompt` for the ask that started a run, `done` for a step or
 * run that completed. The marker itself is drawn by the stylesheet, so the recorded text is untouched.
 */
function markClass(e: LedgerEntry): string | undefined {
  const inner = innerEntry(e);
  const p = typeof inner.payload === "object" && inner.payload !== null ? (inner.payload as Record<string, unknown>) : {};
  if (inner.type === "agent.started") return "prompt";
  if (inner.type === "agent.action.completed" && p.ok === true) return "done";
  if (inner.type === "agent.finished" && p.status === "completed") return "done";
  return undefined;
}

const itemClass = (e: LedgerEntry, attention: boolean): string | undefined =>
  [entryClass(e, attention), markClass(e)].filter(Boolean).join(" ") || undefined;

/** The project's agent.* and override.* entries, oldest first, of one run or of every run. */
export function feedEntries(entries: LedgerEntry[], runId: string | null): LedgerEntry[] {
  return entries.filter((e) => inFeed(e) && (runId === null || namesRun(e, runId))).sort((a, b) => a.seq - b.seq);
}

/**
 * Narrates entries, remembering each one's narration by seq while the context stays the same, so a new entry costs
 * one narration rather than the whole list again. Terminal codes are stripped from the payload first, so headlines
 * read as plain text before narration makes hidden characters visible.
 */
function useNarrations(list: LedgerEntry[], ctx: NarrationContext): { e: LedgerEntry; n: Narration }[] {
  const memo = useRef<{ ctx: NarrationContext; bySeq: Map<number, Narration> }>({ ctx, bySeq: new Map() });
  return useMemo(() => {
    const known = memo.current.ctx === ctx ? memo.current.bySeq : new Map<number, Narration>();
    const bySeq = new Map<number, Narration>();
    const out = list.map((e) => {
      const n = known.get(e.seq) ?? narrate({ ...e, payload: stripAnsiDeep(e.payload) }, ctx);
      bySeq.set(e.seq, n);
      return { e, n };
    });
    memo.current = { ctx, bySeq };
    return out;
  }, [list, ctx]);
}

/** The run the Agent feed and the Terminal follow, shared by both: every run of the project, or one. */
export function FollowSelect() {
  const { model } = useShell();
  return (
    <select
      aria-label="Follow"
      value={model.feedRunId ?? ""}
      onChange={(e) => model.onFollowRun(e.target.value === "" ? null : e.target.value)}
    >
      <option value="">All runs</option>
      {model.runs.map((r) => (
        <option key={r.id} value={r.id}>
          {`${ADAPTER_NAMES[r.adapter]}${onMachine(r, model.narration?.machineName)} · ${clip(visibleControls(r.prompt), PROMPT_CLIP)}`}
        </option>
      ))}
    </select>
  );
}

/** Bottom tab: what the project's agents did and said, and its overrides, from the ledger, newest last. */
export function AgentFeedPanel() {
  const { model } = useShell();
  const { projectEntries, feedRunId, narration, runs } = model;
  const all = useMemo(() => feedEntries(projectEntries, feedRunId), [projectEntries, feedRunId]);
  const shown = useMemo(() => all.slice(-FEED_LIMIT), [all]);
  const items = useNarrations(shown, narration);
  const follow = useFollowBottom<HTMLUListElement>(items.map(({ e }) => String(e.seq)));
  const followed = feedRunId === null ? undefined : runs.find((r) => r.id === feedRunId);
  const plan = followed?.progress && followed.progress.steps.length > 0 ? followed.progress : null;
  const working = runs.some((r) => r.status === "running" && (feedRunId === null || r.id === feedRunId));

  return (
    <section className="agent-feed" aria-label="Agent feed">
      <div className="feed-head">
        <FollowSelect />
        {all.length > FEED_LIMIT && <p className="note">Showing the latest {FEED_LIMIT}</p>}
      </div>
      {followed && plan && (
        <div className="feed-progress">
          <ProgressBar key={followed.id} percent={progressPercent(plan)} label={jobTitle(followed)} />
          <StepChecklist progress={plan} />
        </div>
      )}
      {items.length === 0 ? (
        <p className="empty">Nothing to show yet. Start an agent in the Agents view or the Conversation tab.</p>
      ) : (
        <ul className="feed-items" aria-label="Agent feed entries" tabIndex={0} ref={follow.ref} onScroll={follow.onScroll}>
          {items.map(({ e, n }) => (
            <li key={e.seq} data-key={e.seq} className={itemClass(e, n.attention)}>
              <time dateTime={e.ts}>{new Date(e.ts).toLocaleTimeString()}</time> · <OverrideTag entry={e} headline={n.headline} />
              <span className="headline">{n.headline}</span>
              <RawRecord headline={n.headline} detail={n.detail} payload={e.payload} override={isOverride(e)} />
            </li>
          ))}
        </ul>
      )}
      {working && (
        <p className="live">
          <span role="status">Working…</span> <span className="cursor" aria-hidden="true" />
        </p>
      )}
      {follow.away && (
        <button type="button" className="jump" onClick={follow.jump}>
          Jump to latest <span role="status">({follow.fresh} new)</span>
        </button>
      )}
    </section>
  );
}
