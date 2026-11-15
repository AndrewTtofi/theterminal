/**
 * Daily digests: one plain-language account per UTC day of a project's ledger, built from fixed templates.
 *
 * Pure and deterministic: it reads only its arguments (no clock, randomness, network or environment) and the
 * same entries always give the same digests. It lists only the entry types in `DIGEST_ITEM_TYPES`, narrated by
 * headline; it never lists what agents said, what actions returned, or the prompt a run was given.
 */
import type { AgentEventType } from "./agents.js";
import type { LedgerEntry } from "./domain.js";
import type { EventType } from "./events.js";
import { adapterLabel, narrate, type NarrationContext, type NarrationTopic } from "./narration.js";
import { formatUsd, plural } from "./text.js";

export const DIGEST_MAX_ITEMS = 100;

/** Entry types a digest narrates. Everything else counts but is not listed. */
export const DIGEST_ITEM_TYPES: readonly EventType[] = [
  "project.created",
  "card.created",
  "card.moved",
  "card.status_changed",
  "agent.started",
  "agent.finished",
  "agent.action.requested",
  "agent.action.decided",
  "agent.rate_limited",
  "intake.started",
  "intake.decided",
  "intake.completed",
  "intake.reopened",
  "gate.blocked",
  "gate.signed_off",
  "gate.waived",
  "connection.added",
  "connection.removed",
  "override.command",
  "override.discard",
  "override.completed",
  "share.confirmed",
  "share.link_created",
  "share.revoked",
  "share.expired",
  "share.stopped",
];

export type DigestItem = { seq: number; time: string; headline: string; topic: NarrationTopic; attention: boolean };
export type DigestCounts = {
  entries: number;
  actions: number;
  allowed: number;
  denied: number;
  decisions: number;
  cardsMoved: number;
  runsStarted: number;
  runsFinished: number;
  spendUsd: number | null;
};
export type DailyDigest = { day: string; summary: string; counts: DigestCounts; items: DigestItem[]; more: number };

type Payload = Record<string, unknown>;

const isRecord = (v: unknown): v is Payload => typeof v === "object" && v !== null && !Array.isArray(v);
const payloadOf = (e: LedgerEntry): Payload => (isRecord(e.payload) ? e.payload : {});
const LISTED = new Set<string>(DIGEST_ITEM_TYPES);
const DECIDED: AgentEventType = "agent.action.decided";
const STARTED: AgentEventType = "agent.started";

/** The UTC day (`YYYY-MM-DD`) of an ISO timestamp. */
export function utcDay(ts: string): string {
  return ts.slice(0, 10);
}

/** `HH:MM` (UTC) of an ISO timestamp. */
const utcTime = (ts: string): string => ts.slice(11, 16);

const bySeq = (a: LedgerEntry, b: LedgerEntry): number => a.seq - b.seq;

/** Whether an `agent.action.decided` entry is a human's decision; the policy's are counted but never listed. */
const byHuman = (e: LedgerEntry): boolean => payloadOf(e).by === "human";

function countDay(entries: readonly LedgerEntry[]): DigestCounts {
  const counts: DigestCounts = {
    entries: entries.length,
    actions: 0,
    allowed: 0,
    denied: 0,
    decisions: 0,
    cardsMoved: 0,
    runsStarted: 0,
    runsFinished: 0,
    spendUsd: null,
  };
  for (const e of entries) {
    const p = payloadOf(e);
    switch (e.type) {
      case "agent.action.requested":
        counts.actions += 1;
        break;
      case "agent.action.decided":
        if (byHuman(e)) {
          if (p.decision === "allow") counts.allowed += 1;
          if (p.decision === "deny") counts.denied += 1;
          counts.decisions += 1;
        }
        break;
      case "intake.decided":
      case "gate.signed_off":
      case "gate.waived":
        counts.decisions += 1;
        break;
      case "card.moved":
        counts.cardsMoved += 1;
        break;
      case "agent.started":
        counts.runsStarted += 1;
        break;
      case "agent.finished":
        counts.runsFinished += 1;
        if (typeof p.costUsd === "number" && Number.isFinite(p.costUsd)) {
          counts.spendUsd = (counts.spendUsd ?? 0) + p.costUsd;
        }
        break;
      default:
        break;
    }
  }
  return counts;
}

function summarise(c: DigestCounts): string {
  const sentence =
    `${plural(c.entries, "ledger entry", "ledger entries")}: ` +
    `${plural(c.actions, "agent action")} requested, ${c.allowed} allowed and ${c.denied} denied by a human, ` +
    `${plural(c.decisions, "decision")} by the Owner, ${plural(c.cardsMoved, "card")} moved, ` +
    `${plural(c.runsStarted, "agent run")} started and ${c.runsFinished} finished.`;
  return c.spendUsd === null ? sentence : `${sentence} Agent spend recorded that day: ${formatUsd(c.spendUsd)} (estimate).`;
}

function listed(e: LedgerEntry): boolean {
  if (!LISTED.has(e.type)) return false;
  return e.type !== DECIDED || byHuman(e);
}

function itemOf(e: LedgerEntry, ctx: NarrationContext): DigestItem {
  const n = narrate(e, ctx);
  let headline = n.headline;
  if (e.type === STARTED) {
    // Narration falls back to the prompt when the card does not resolve; a digest never shows a prompt.
    const p = payloadOf(e);
    const cardId = typeof p.cardId === "string" ? p.cardId : undefined;
    const title = cardId !== undefined && ctx.cardTitle ? ctx.cardTitle(cardId) : undefined;
    if (!title) headline = `Owner started a ${adapterLabel(p.adapter)} agent`;
  }
  return { seq: e.seq, time: utcTime(e.ts), headline, topic: n.topic, attention: n.attention };
}

/** The digest of one UTC day: the entries of that day (in any order, others ignored), items in seq order. */
export function digestDay(day: string, entries: LedgerEntry[], ctx: NarrationContext = {}): DailyDigest {
  const ofDay = entries.filter((e) => utcDay(e.ts) === day).sort(bySeq);
  const counts = countDay(ofDay);
  const all = ofDay.filter(listed);
  const items = all.slice(0, DIGEST_MAX_ITEMS).map((e) => itemOf(e, ctx));
  return { day, summary: summarise(counts), counts, items, more: all.length - items.length };
}

/** One digest per UTC day present in the entries, newest day first. */
export function dailyDigests(entries: LedgerEntry[], ctx: NarrationContext = {}): DailyDigest[] {
  const days = [...new Set(entries.map((e) => utcDay(e.ts)))].sort().reverse();
  return days.map((day) => digestDay(day, entries, ctx));
}
