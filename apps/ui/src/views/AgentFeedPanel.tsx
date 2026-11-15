import { useMemo } from "react";
import { narrate, visibleControls } from "@theterminal/shared";
import type { LedgerEntry } from "@theterminal/shared";
import { ADAPTER_NAMES } from "../components/AgentPanel";
import { OverrideTag, RawRecord, entryClass, isOverride } from "../components/LedgerPanel";
import { clip } from "../components/text";
import { namesRun, useShell } from "../shell/model";
import { useFollowBottom } from "./use-follow-bottom";

/** The most items the Agent feed paints: the newest ones. */
export const FEED_LIMIT = 500;
const PROMPT_CLIP = 40;

/** True for what the feed shows: what agents did and said, and the Owner's overrides. */
const inFeed = (e: LedgerEntry) => e.type.startsWith("agent.") || isOverride(e);

/** The project's agent.* and override.* entries, oldest first, of one run or of every run. */
export function feedEntries(entries: LedgerEntry[], runId: string | null): LedgerEntry[] {
  return entries.filter((e) => inFeed(e) && (runId === null || namesRun(e, runId))).sort((a, b) => a.seq - b.seq);
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
          {`${ADAPTER_NAMES[r.adapter]} · ${clip(visibleControls(r.prompt), PROMPT_CLIP)}`}
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
  const items = useMemo(() => all.slice(-FEED_LIMIT).map((e) => ({ e, n: narrate(e, narration) })), [all, narration]);
  const follow = useFollowBottom<HTMLUListElement>(items.map(({ e }) => String(e.seq)));
  const working = runs.some((r) => r.status === "running" && (feedRunId === null || r.id === feedRunId));

  return (
    <section className="agent-feed" aria-label="Agent feed">
      <div className="feed-head">
        <FollowSelect />
        {all.length > FEED_LIMIT && <p className="note">Showing the latest {FEED_LIMIT}</p>}
      </div>
      {items.length === 0 ? (
        <p className="empty">Nothing to show yet. Start an agent in the Agents view or the Conversation tab.</p>
      ) : (
        <ul className="feed-items" ref={follow.ref} onScroll={follow.onScroll}>
          {items.map(({ e, n }) => (
            <li key={e.seq} className={entryClass(e, n.attention)}>
              <time dateTime={e.ts}>{new Date(e.ts).toLocaleTimeString()}</time> · <OverrideTag entry={e} headline={n.headline} />
              <span className="headline">{n.headline}</span>
              <RawRecord headline={n.headline} detail={n.detail} payload={e.payload} override={isOverride(e)} />
            </li>
          ))}
        </ul>
      )}
      {working && <p className="live">Working…</p>}
      {follow.away && (
        <button type="button" className="jump" onClick={follow.jump}>
          Jump to latest ({follow.fresh} new)
        </button>
      )}
    </section>
  );
}
