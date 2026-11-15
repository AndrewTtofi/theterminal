import {
  narrate, type AgentAction, type AgentRun, type CardStory, type LedgerEntry, type NarrationContext, type StoryIntegrity,
  type UnreadableEntry,
} from "@theterminal/shared";
import type { Db } from "../db.js";
import { MAX_RUN_IDS, type Ledger } from "../ledger/ledger.js";
import { requireCard } from "../board/board-service.js";
import { listActions, listGateDecisions, getRun } from "../events/projections.js";

export type { CardStory };

const PAGE = 500;

/** How narration names each adapter. */
const ADAPTER_LABELS: Record<AgentRun["adapter"], string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", fake: "Fake" };

/** Every entry `list` returns for the filter, paged in seq order. (The filter skips unparseable rows.) */
function* pages(ledger: Ledger, q: { cardId?: string; runIds?: string[] }): Generator<LedgerEntry> {
  let afterSeq = 0;
  for (;;) {
    const page = ledger.list({ ...q, afterSeq, limit: PAGE });
    yield* page;
    if (page.length < PAGE) return;
    afterSeq = page[page.length - 1]!.seq;
  }
}

/** The rows at `seqs` that can be read, in chunks `listRows` accepts. */
function entriesAt(ledger: Ledger, seqs: number[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (let i = 0; i < seqs.length; i += PAGE) {
    for (const row of ledger.listRows({ seqs: seqs.slice(i, i + PAGE), limit: PAGE })) {
      if (!("unreadable" in row)) out.push(row);
    }
  }
  return out;
}

/**
 * The plan behind a card, in one query: each `intake.completed` entry that lists it, with the `intake.decided`
 * entries of the same intake that precede it.
 */
function planSeqs(db: Db, cardId: string): number[] {
  const rows = db
    .prepare(
      `WITH completed AS (
         SELECT seq, json_extract(payload, '$.intakeId') AS intake_id FROM ledger
         WHERE type = 'intake.completed' AND CASE WHEN json_valid(payload) THEN EXISTS (
           SELECT 1 FROM json_each(payload, '$.cards') c WHERE json_extract(c.value, '$.cardId') = ?
         ) ELSE 0 END
       )
       SELECT seq FROM completed
       UNION
       SELECT d.seq FROM ledger d JOIN completed c ON d.seq < c.seq
       WHERE d.type = 'intake.decided'
         AND CASE WHEN json_valid(d.payload) THEN json_extract(d.payload, '$.intakeId') = c.intake_id ELSE 0 END
       ORDER BY seq`,
    )
    .all(cardId) as { seq: number }[];
  return rows.map((r) => r.seq);
}

/**
 * Unparseable rows that still name the card or one of its runs in their raw text (payloads are stored as canonical
 * JSON, so an intact `"cardId":"…"` survives a cut). A row that names neither is covered by the integrity flag.
 */
function unreadableRows(db: Db, cardId: string, runIds: string[]): UnreadableEntry[] {
  const needles = [`"cardId":${JSON.stringify(cardId)}`, ...runIds.map((r) => `"runId":${JSON.stringify(r)}`)];
  const rows = db.prepare("SELECT seq, payload FROM ledger WHERE NOT json_valid(payload) ORDER BY seq").all() as {
    seq: number; payload: string;
  }[];
  return rows.filter((r) => needles.some((n) => r.payload.includes(n))).map((r) => ({ seq: r.seq, unreadable: true }));
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
  for (const e of entriesAt(ledger, planSeqs(db, cardId).filter((seq) => !bySeq.has(seq)))) bySeq.set(e.seq, e);
  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);

  const verified = ledger.verify();
  const integrity: StoryIntegrity = verified.ok ? { ok: true } : { ok: false, brokenAtSeq: verified.brokenAtSeq };
  // Unparseable rows break the chain, so they are looked for only when it is broken.
  const unreadable = integrity.ok ? [] : unreadableRows(db, cardId, runIds);

  const reported = runs.map((r) => r.costUsd).filter((c): c is number => c !== null);
  const costUsd = reported.length === 0 ? null : reported.reduce((sum, c) => sum + c, 0);
  return { card, runs, actions, entries, gateDecisions: listGateDecisions(db, cardId), costUsd, integrity, unreadable };
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

/** The headline for an export line; narration failing on one odd entry must not abort the stream. */
function headlineOf(e: LedgerEntry, ctx: NarrationContext): string {
  try {
    return narrate(e, ctx).headline;
  } catch {
    return e.type;
  }
}

/**
 * The audit export as NDJSON lines, produced lazily: a header with the integrity check, then every row up to the
 * header's `headSeq` (so later appends cannot make the snapshot inconsistent), then a trailer. With a project, its
 * own entries plus the `connection.used` entries of its runs, which carry no project. Rows are read a page at a time
 * and are already redacted; the headline is computed here and never written to the ledger. Nothing vanishes
 * silently: a row that cannot be parsed, or a seq with no row, is a `gap` line in every export, and the trailer
 * counts them.
 */
export function* ledgerExportLines(db: Db, ledger: Ledger, projectId: string | null, now: Date = new Date()): Generator<string> {
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  const headSeq = ledger.headSeq();
  const integrity = ledger.verify();
  const projectRuns =
    projectId === null
      ? null
      : new Set((db.prepare("SELECT id FROM agent_runs WHERE project_id = ?").all(projectId) as { id: string }[]).map((r) => r.id));
  const ctx = narrationContext(db);
  yield line({ kind: "header", exportedAt: now.toISOString(), projectId, headSeq, integrity });
  const belongs = (e: LedgerEntry): boolean => {
    if (projectRuns === null || e.projectId === projectId) return true;
    if (e.type !== "connection.used") return false;
    const runId = (e.payload as { runId?: unknown }).runId;
    return typeof runId === "string" && projectRuns.has(runId);
  };
  let lastSeq = 0;
  let gaps = 0;
  for (;;) {
    const page = ledger.listRows({ afterSeq: lastSeq, toSeq: headSeq, limit: PAGE });
    if (page.length === 0) break;
    for (const row of page) {
      for (let missing = lastSeq + 1; missing < row.seq; missing++) {
        gaps++;
        yield line({ kind: "gap", seq: missing, reason: "missing" });
      }
      lastSeq = row.seq;
      if ("unreadable" in row) {
        gaps++;
        yield line({ kind: "gap", seq: row.seq, reason: "unreadable" });
      } else if (belongs(row)) {
        yield line({ kind: "entry", ...row, headline: headlineOf(row, ctx) });
      }
    }
  }
  yield line({ kind: "end", lastSeq, gaps });
}
