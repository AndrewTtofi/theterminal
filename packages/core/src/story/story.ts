import { narrate, type AgentAction, type AgentRun, type CardStory, type LedgerEntry, type NarrationContext } from "@theterminal/shared";
import type { Db } from "../db.js";
import { MAX_RUN_IDS, type Ledger } from "../ledger/ledger.js";
import { requireCard } from "../board/board-service.js";
import { listActions, listGateDecisions, getRun } from "../events/projections.js";

export type { CardStory };

const PAGE = 500;

/** How narration names each adapter. */
const ADAPTER_LABELS: Record<AgentRun["adapter"], string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", fake: "Fake" };

/** Every entry `list` returns for the filter, paged in seq order. */
function* pages(ledger: Ledger, q: { cardId?: string; runIds?: string[] }): Generator<LedgerEntry> {
  let afterSeq = 0;
  for (;;) {
    const page = ledger.list({ ...q, afterSeq, limit: PAGE });
    yield* page;
    if (page.length < PAGE) return;
    afterSeq = page[page.length - 1]!.seq;
  }
}

/** The entry at `seq`, read through `list`, the one place that turns rows into entries. */
function entryAt(ledger: Ledger, seq: number): LedgerEntry | undefined {
  const [e] = ledger.list({ afterSeq: seq - 1, limit: 1 });
  return e?.seq === seq ? e : undefined;
}

/**
 * The plan behind a card: each `intake.completed` entry that lists it, with the `intake.decided` entries of the
 * same intake that precede it.
 */
function planSeqs(db: Db, cardId: string): number[] {
  const completed = db
    .prepare(
      `SELECT seq, json_extract(payload, '$.intakeId') AS intake_id FROM ledger
       WHERE type = 'intake.completed' AND json_valid(payload)
         AND EXISTS (SELECT 1 FROM json_each(payload, '$.cards') c WHERE json_extract(c.value, '$.cardId') = ?)
       ORDER BY seq`,
    )
    .all(cardId) as { seq: number; intake_id: string }[];
  const decided = db.prepare(
    `SELECT seq FROM ledger WHERE type = 'intake.decided' AND seq < ?
       AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.intakeId') = ? ELSE 0 END ORDER BY seq`,
  );
  const seqs: number[] = [];
  for (const c of completed) {
    seqs.push(...(decided.all(c.seq, c.intake_id) as { seq: number }[]).map((r) => r.seq), c.seq);
  }
  return seqs;
}

/** The card, its runs and actions, its gate decisions, and every ledger entry about it, in seq order. */
export function cardStory(db: Db, ledger: Ledger, cardId: string): CardStory {
  const card = requireCard(db, cardId);
  const runIds = (db.prepare("SELECT id FROM agent_runs WHERE card_id = ? ORDER BY started_at, rowid").all(cardId) as { id: string }[])
    .map((r) => r.id);
  const runs = runIds.map((id) => getRun(db, id)).filter((r): r is AgentRun => r !== null);
  const actions: AgentAction[] = runs.flatMap((r) => listActions(db, r.id));

  const bySeq = new Map<number, LedgerEntry>();
  // `list` filters by at most MAX_RUN_IDS runs at once; the card's own entries come with the first batch.
  const batches: string[][] = [];
  for (let i = 0; i < runIds.length; i += MAX_RUN_IDS) batches.push(runIds.slice(i, i + MAX_RUN_IDS));
  if (batches.length === 0) batches.push([]);
  for (const batch of batches) {
    for (const e of pages(ledger, { cardId, runIds: batch })) bySeq.set(e.seq, e);
  }
  for (const seq of planSeqs(db, cardId)) {
    if (bySeq.has(seq)) continue;
    const e = entryAt(ledger, seq);
    if (e) bySeq.set(seq, e);
  }
  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);

  const reported = runs.map((r) => r.costUsd).filter((c): c is number => c !== null);
  const costUsd = reported.length === 0 ? null : reported.reduce((sum, c) => sum + c, 0);
  return { card, runs, actions, entries, gateDecisions: listGateDecisions(db, cardId), costUsd };
}

/** What narration may know beyond an entry: card titles from the board and adapter labels from the runs. */
export function narrationContext(db: Db): NarrationContext {
  const title = db.prepare("SELECT title FROM cards WHERE id = ?");
  const adapter = db.prepare("SELECT adapter FROM agent_runs WHERE id = ?");
  return {
    cardTitle: (cardId) => (title.get(cardId) as { title: string } | undefined)?.title,
    adapterName: (runId) => {
      const r = adapter.get(runId) as { adapter: AgentRun["adapter"] } | undefined;
      return r ? ADAPTER_LABELS[r.adapter] : undefined;
    },
  };
}

/**
 * The audit export as NDJSON lines, produced lazily: a header with the integrity check, then every entry up to the
 * header's `headSeq` (so later appends cannot make the snapshot inconsistent) with its narrated headline. With a
 * project, its own entries plus the `connection.used` entries of its runs, which carry no project. Entries are read
 * a page at a time and are already redacted; the headline is computed here and never written to the ledger.
 */
export function* ledgerExportLines(db: Db, ledger: Ledger, projectId: string | null, now: Date = new Date()): Generator<string> {
  const headSeq = ledger.headSeq();
  const integrity = ledger.verify();
  const projectRuns =
    projectId === null
      ? null
      : new Set((db.prepare("SELECT id FROM agent_runs WHERE project_id = ?").all(projectId) as { id: string }[]).map((r) => r.id));
  const ctx = narrationContext(db);
  yield `${JSON.stringify({ kind: "header", exportedAt: now.toISOString(), projectId, headSeq, integrity })}\n`;
  const belongs = (e: LedgerEntry): boolean => {
    if (projectRuns === null || e.projectId === projectId) return true;
    if (e.type !== "connection.used") return false;
    const runId = (e.payload as { runId?: unknown }).runId;
    return typeof runId === "string" && projectRuns.has(runId);
  };
  let afterSeq = 0;
  while (afterSeq < headSeq) {
    const page = ledger.list({ afterSeq, limit: Math.min(PAGE, headSeq - afterSeq) });
    for (const e of page) {
      if (e.seq > headSeq) return;
      if (belongs(e)) yield `${JSON.stringify({ kind: "entry", ...e, headline: narrate(e, ctx).headline })}\n`;
    }
    // A short page means `list` stopped early (the end, or an unreadable entry): nothing more can be served.
    if (page.length === 0 || page.length < Math.min(PAGE, headSeq - afterSeq)) return;
    afterSeq = page[page.length - 1]!.seq;
  }
}
