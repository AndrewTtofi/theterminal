import {
  ADAPTERS, GATES, GATE_IDS, HIDDEN_BY_DEFAULT, HIDDEN_HARDWARE_LINE, HIDDEN_PROMPTS_LINE, STAGES, adapterLabel, applicableDecisions, dailyDigests, narrate, utcDay,
  type AdapterId, type AgentRun, type Answers, type Ask, type Basis, type CiStatus, type Connection, type DecisionItem,
  type Evidence, type Figure, type GateId, type HardwareInfo, type HistoryDay, type LedgerEntry, type NarrationContext,
  type ReadinessRow, type ShareNumbers, type ShareOptions, type ShareSnapshot, type Stage, type WaitingItem,
  type WorkforceRow,
} from "@theterminal/shared";
import { NotFoundError } from "../board/board-service.js";
import type { Db } from "../db.js";
import { getIntake, listPendingActions, listProjectGateDecisions, listRuns, type IntakeState } from "../events/projections.js";
import type { GateService } from "../gates/service.js";
import type { Ledger, VerifyResult } from "../ledger/ledger.js";
import { narrationContext } from "../story/story.js";
import { cleanSnapshot, type ShareClean } from "./clean.js";
import { PROGRAM_LABELS, evidenceOf, techStack } from "./stack.js";

export { evidenceOf };

export type SnapshotDeps = {
  db: Db;
  ledger: Ledger;
  integrity: () => VerifyResult;
  gates: GateService;
  connections: () => Connection[];
  ci: () => Promise<CiStatus | null>;
  /** This computer's hardware; a value carrying `enabled: false` (the Owner turned it off) is treated as none. */
  hardware: () => HardwareInfo | null;
  clean: ShareClean;
  now?: () => Date;
};

export const SHARE_LIMITS = { decisions: 200, waiting: 50, readinessCards: 20, historyDays: 2000, asksPerDay: 50 } as const;

const PAGE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

type Payload = Record<string, unknown>;
const payloadOf = (e: LedgerEntry): Payload =>
  typeof e.payload === "object" && e.payload !== null && !Array.isArray(e.payload) ? (e.payload as Payload) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const orNull = (s: string): string | null => (s.trim() === "" ? null : s);

type CardRow = { id: string; title: string; stage: Stage; status: string };

/** The project's entries in seq order, read a page at a time; with a broken chain, only those before the break. */
function projectEntries(ledger: Ledger, projectId: string, integrity: VerifyResult): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = ledger.list({ projectId, afterSeq, limit: PAGE });
    if (page.length === 0) break;
    out.push(...page);
    afterSeq = page[page.length - 1]!.seq;
  }
  return integrity.ok ? out : out.filter((e) => e.seq < integrity.brokenAtSeq);
}

/** The most connection.added entries read for the tech stack (`listRows` takes at most 500 seqs). */
const MAX_CONNECTION_ENTRIES = 500;

/**
 * The `connection.added` entries of the enabled connections. They carry no project (a connection belongs to the
 * workspace), so the project's own entries never hold them. Only the entries the integrity check vouches for are
 * kept, and only their seq, hash and time reach the page, as evidence.
 */
function connectionEntries(db: Db, ledger: Ledger, connections: Connection[], integrity: VerifyResult): LedgerEntry[] {
  const ids = connections.filter((c) => c.enabled).map((c) => c.id);
  if (ids.length === 0) return [];
  // CASE guarantees json_valid runs first: json_extract throws on a tampered, unparseable payload.
  const seqs = (db
    .prepare(
      `SELECT seq FROM ledger WHERE type = 'connection.added' AND project_id IS NULL
       AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.connectionId') IN (${ids.map(() => "?").join(", ")}) ELSE 0 END
       ORDER BY seq LIMIT ?`,
    )
    .all(...ids, MAX_CONNECTION_ENTRIES) as { seq: number }[]).map((r) => r.seq);
  if (seqs.length === 0) return [];
  return ledger
    .listRows({ seqs })
    .filter((r): r is LedgerEntry => !("unreadable" in r))
    .filter((e) => integrity.ok || e.seq < integrity.brokenAtSeq);
}

/** A human decision: an intake decision, a gate sign-off or waiver, or a human's decision on an agent action. */
function isDecision(e: LedgerEntry): boolean {
  if (e.type === "intake.decided" || e.type === "gate.signed_off" || e.type === "gate.waived") return true;
  return e.type === "agent.action.decided" && payloadOf(e).by === "human";
}

const unwrap = (intake: IntakeState): Answers =>
  Object.fromEntries(Object.entries(intake.answers).map(([q, a]) => [q, a!.answer])) as Answers;

/** The applicable intake decisions not yet made, while the intake is open. */
function openDecisions(intake: IntakeState | null) {
  if (!intake || intake.intake.status !== "open") return [];
  return applicableDecisions(unwrap(intake)).filter((d) => intake.decisions[d.id] === undefined);
}

function spendOf(runs: AgentRun[]): Figure {
  const costs = runs.map((r) => r.costUsd).filter((c): c is number => c !== null);
  if (costs.length === 0) return { value: null, basis: "not_reported" };
  const value = costs.reduce((a, b) => a + b, 0);
  const reported = runs.every((r) => r.costUsd !== null && (r.adapter === "codex" || r.adapter === "gemini"));
  return { value, basis: reported ? "reported" : "estimate" };
}

function costPerDay(spend: Figure, runs: AgentRun[], now: Date): Figure {
  if (spend.value === null || runs.length === 0) return { value: null, basis: "not_reported" };
  const first = Math.min(...runs.map((r) => Date.parse(r.startedAt)));
  const days = Math.max(1, Math.floor((now.getTime() - first) / DAY_MS));
  return { value: spend.value / days, basis: "estimate" };
}

/** Plan 5B's rule: no value is not_reported; Claude's figure is the SDK's estimate, Codex's and Gemini's the provider's. */
function workforceBasis(adapter: AdapterId, value: number | null): Basis {
  if (value === null) return "not_reported";
  return adapter === "codex" || adapter === "gemini" ? "reported" : "estimate";
}

function sumOrNull(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

function workforce(runs: AgentRun[]): WorkforceRow[] {
  const rows: WorkforceRow[] = [];
  for (const adapter of ADAPTERS) {
    const mine = runs.filter((r) => r.adapter === adapter);
    if (mine.length === 0) continue;
    const cost = sumOrNull(mine.map((r) => r.costUsd));
    rows.push({
      adapter,
      label: PROGRAM_LABELS[adapter],
      runs: mine.length,
      completed: mine.filter((r) => r.status === "completed").length,
      failed: mine.filter((r) => r.status === "failed").length,
      stopped: mine.filter((r) => r.status === "stopped").length,
      costUsd: { value: cost, basis: workforceBasis(adapter, cost) },
      inputTokens: sumOrNull(mine.map((r) => r.inputTokens)),
      outputTokens: sumOrNull(mine.map((r) => r.outputTokens)),
    });
  }
  return rows;
}

function decisionItem(e: LedgerEntry, ctx: NarrationContext): DecisionItem {
  const p = payloadOf(e);
  const kind: DecisionItem["kind"] =
    e.type === "intake.decided" ? "intake" : e.type === "gate.signed_off" ? "gate_sign_off" : e.type === "gate.waived" ? "gate_waiver" : "action";
  const reason = kind === "intake" ? orNull(str(p.rationale)) : kind === "gate_sign_off" ? null : orNull(str(p.reason));
  return { kind, headline: narrate(e, ctx).headline, by: "Owner", at: e.ts, reason, evidence: evidenceOf(e) };
}

function historyOf(entries: LedgerEntry[]): HistoryDay[] {
  const byDay = new Map<string, HistoryDay>();
  for (const e of entries) {
    const day = utcDay(e.ts);
    let h = byDay.get(day);
    if (!h) {
      h = { day, entries: 0, actions: 0, decisions: 0, cardsMoved: 0 };
      byDay.set(day, h);
    }
    h.entries += 1;
    if (e.type === "agent.action.requested") h.actions += 1;
    if (isDecision(e)) h.decisions += 1;
    if (e.type === "card.moved") h.cardsMoved += 1;
  }
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return days.slice(Math.max(0, days.length - SHARE_LIMITS.historyDays));
}

function asksOf(entries: LedgerEntry[], ctx: NarrationContext): Ask[] {
  const perDay = new Map<string, number>();
  const asks: Ask[] = [];
  for (const e of entries) {
    if (e.type !== "agent.started") continue;
    const day = utcDay(e.ts);
    const n = perDay.get(day) ?? 0;
    if (n >= SHARE_LIMITS.asksPerDay) continue;
    perDay.set(day, n + 1);
    const p = payloadOf(e);
    const cardId = str(p.cardId);
    asks.push({
      day, time: e.ts.slice(11, 16), adapterLabel: adapterLabel(p.adapter),
      cardTitle: (cardId !== "" ? ctx.cardTitle?.(cardId) : undefined) ?? null, prompt: str(p.prompt),
    });
  }
  return asks;
}

/** The eight HardwareInfo fields only: never the connection's enabled flag or anything else a caller passed. */
function hardwareOf(h: (HardwareInfo & { enabled?: boolean }) | null): HardwareInfo | null {
  if (!h || h.enabled === false) return null;
  const { cpu, cores, memoryGb, gpu, gpuMemoryGb, platform, wsl, detectedAt } = h;
  return { cpu, cores, memoryGb, gpu, gpuMemoryGb, platform, wsl, detectedAt };
}


/**
 * The share page's content for one project, read from the ledger and its projections, then cleaned: every text
 * passes the share cleaner and is capped at SHARE_TEXT_MAX. It never carries raw output, messages, action input,
 * connection names or config values, or another project's entries; prompts and hardware only when the options say.
 */
export async function buildSnapshot(deps: SnapshotDeps, projectId: string, options: ShareOptions): Promise<ShareSnapshot> {
  const { db, ledger } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const project = db.prepare("SELECT name, pitch, created_at FROM projects WHERE id = ?").get(projectId) as
    | { name: string; pitch: string; created_at: string }
    | undefined;
  if (!project) throw new NotFoundError("project", projectId);

  const integrity = deps.integrity();
  const entries = projectEntries(ledger, projectId, integrity);
  const ctx = narrationContext(db);
  const cards = db
    .prepare("SELECT id, title, stage, status FROM cards WHERE project_id = ? ORDER BY created_at, rowid")
    .all(projectId) as CardRow[];
  const titleOf = new Map(cards.map((c) => [c.id, c.title] as const));
  const runs = listRuns(db, projectId);
  const intake = getIntake(db, projectId);
  const entriesById = new Map(entries.map((e) => [e.id, e] as const));
  const connections = deps.connections();

  // Progress.
  const progress = Object.fromEntries(STAGES.map((s) => [s, { total: 0, done: 0 }])) as ShareSnapshot["progress"];
  for (const c of cards) {
    progress[c.stage].total += 1;
    if (c.status === "done") progress[c.stage].done += 1;
  }
  const currentStage =
    STAGES.find((s) => progress[s].total > progress[s].done) ?? [...STAGES].reverse().find((s) => progress[s].total > 0) ?? null;

  // Waiting on a human.
  const pending = listPendingActions(db, projectId);
  const requested = new Map<string, LedgerEntry>();
  for (const e of entries) if (e.type === "agent.action.requested") requested.set(str(payloadOf(e).actionId), e);
  const runCard = new Map(runs.map((r) => [r.id, r.cardId] as const));
  const undecided = openDecisions(intake);
  const waiting: WaitingItem[] = [
    ...pending.map((a): WaitingItem => {
      const entry = requested.get(a.id);
      const cardId = runCard.get(a.runId) ?? null;
      return {
        kind: "action",
        headline: entry ? narrate(entry, ctx).headline : "An agent is waiting for a decision",
        since: a.requestedAt,
        cardTitle: cardId === null ? null : (titleOf.get(cardId) ?? null),
        assignee: "Owner",
      };
    }),
    ...undecided.map((d): WaitingItem => ({ kind: "intake", headline: `Decide: ${d.question}`, since: null, cardTitle: null, assignee: "Owner" })),
  ].slice(0, SHARE_LIMITS.waiting);

  // Decisions, newest first.
  const allDecisions = entries.filter(isDecision).reverse();
  const decisions = allDecisions.slice(0, SHARE_LIMITS.decisions).map((e) => decisionItem(e, ctx));

  // Headline numbers.
  const spendUsd = spendOf(runs);
  const budget = intake?.answers.budget_usd?.answer;
  let ci: ShareNumbers["ci"] = null;
  try {
    ci = (await deps.ci())?.state ?? null;
  } catch {
    ci = null; // the page says the checks are unknown rather than failing
  }
  const numbers: ShareNumbers = {
    cardsTotal: cards.length,
    cardsDone: cards.filter((c) => c.status === "done").length,
    runsTotal: runs.length,
    runsCompleted: runs.filter((r) => r.status === "completed").length,
    overrides: entries.filter((e) => e.type === "override.command" || e.type === "override.discard").length,
    spendUsd,
    budgetUsd: typeof budget === "number" ? budget : null,
    costPerDayUsd: costPerDay(spendUsd, runs, now),
    decisionsMade: allDecisions.length,
    decisionsWaiting: pending.length + undecided.length,
    ci,
  };

  // Readiness.
  const gateDecisions = listProjectGateDecisions(db, projectId);
  const open = new Map<GateId, { detail: string; cardTitle: string }>();
  for (const c of cards.filter((x) => x.stage === "build" || x.stage === "ship").slice(0, SHARE_LIMITS.readinessCards)) {
    for (const g of deps.gates.evaluate(c.id, c.stage === "build" ? "ship" : "operate")) {
      if (open.has(g.id)) continue;
      const unmet = g.conditions.filter((x) => !x.met).map((x) => x.label);
      open.set(g.id, { detail: unmet.length > 0 ? unmet.join("; ") : "All conditions met; awaiting sign-off", cardTitle: c.title });
    }
  }
  const readiness: ReadinessRow[] = GATE_IDS.map((gateId) => {
    const title = GATES.find((g) => g.id === gateId)!.title;
    const decided = gateDecisions.findLast((d) => d.gateId === gateId);
    if (decided) {
      const entry = entriesById.get(decided.entryId);
      return {
        gateId, title, state: decided.kind, detail: decided.reason, cardTitle: titleOf.get(decided.cardId) ?? null, at: decided.at,
        evidence: entry ? evidenceOf(entry) : null,
      };
    }
    const o = open.get(gateId);
    if (o) return { gateId, title, state: "open", detail: o.detail, cardTitle: o.cardTitle, at: null, evidence: null };
    return { gateId, title, state: "not_reached", detail: null, cardTitle: null, at: null, evidence: null };
  });

  // Digests for the last `digestDays` UTC days, today included; one history line per earlier day.
  const firstDay = utcDay(new Date(now.getTime() - (options.digestDays - 1) * DAY_MS).toISOString());
  const recent = entries.filter((e) => utcDay(e.ts) >= firstDay);
  const earlier = entries.filter((e) => utcDay(e.ts) < firstDay);

  // Audit.
  const headSeq = ledger.headSeq();
  const head = headSeq > 0 ? ledger.listRows({ afterSeq: headSeq - 1, limit: 1 })[0] : undefined;
  const audit: ShareSnapshot["audit"] = integrity.ok
    ? { ok: true, entries: integrity.count, brokenAtSeq: null, headSeq, headHash12: null }
    : // The entries before the break are the ones the check vouches for.
      { ok: false, entries: integrity.brokenAtSeq - 1, brokenAtSeq: integrity.brokenAtSeq, headSeq, headHash12: null };
  audit.headHash12 = head && "hash" in head ? head.hash.slice(0, 12) : null;

  const hidden = HIDDEN_BY_DEFAULT.filter(
    (l) => !(options.includePrompts && l === HIDDEN_PROMPTS_LINE) && !(options.includeHardware && l === HIDDEN_HARDWARE_LINE),
  );

  const raw: ShareSnapshot = {
    version: 1,
    generatedAt: now.toISOString(),
    options: { includePrompts: options.includePrompts, includeHardware: options.includeHardware, digestDays: options.digestDays },
    hidden,
    project: { name: project.name, pitch: project.pitch, createdAt: project.created_at },
    owner: "Owner",
    progress,
    currentStage,
    numbers,
    summary: intake?.intake.summary ?? null,
    idea: intake?.intake.idea ?? null,
    stack: techStack({
      intake, connections, runs,
      entries: [...entries, ...connectionEntries(db, ledger, connections, integrity)].sort((a, b) => a.seq - b.seq),
    }),
    workforce: workforce(runs),
    waiting,
    decisions,
    decisionsOmitted: allDecisions.length - decisions.length,
    readiness,
    digests: dailyDigests(recent, ctx),
    asks: options.includePrompts ? asksOf(recent, ctx) : [],
    history: historyOf(earlier),
    hardware: options.includeHardware ? hardwareOf(deps.hardware()) : null,
    audit,
  };
  return cleanSnapshot(raw, deps.clean);
}

export type { Evidence };
