import { dailyDigests, utcDay, type DailyDigest, type DigestDays, type LedgerEntry } from "@theterminal/shared";
import { NotFoundError } from "../board/board-service.js";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { narrationContext } from "../story/story.js";

const PAGE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The project's daily digests for the last `days` UTC days, today included, newest first. The window starts at UTC
 * midnight `days - 1` days ago. Entries are read newest first, a page at a time, and the reading stops at the first
 * entry older than the window, so a long history is never read in full. Like the ledger panel, this is the Owner's
 * own live view: it reads the ledger as it is, while the read-only banner reports a broken chain. `Ledger.list` cuts
 * a page at an unreadable row, so a short page is not the end: the reading goes on to the older pages, and only the
 * rest of the cut page is left out, as the ledger leaves it out.
 */
export function projectDigests(
  db: Db, ledger: Ledger, projectId: string, days: DigestDays, now: () => Date = () => new Date(),
  trim: (e: LedgerEntry) => LedgerEntry = (e) => e,
): DailyDigest[] {
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new NotFoundError("project", projectId);
  const firstDay = utcDay(new Date(now().getTime() - (days - 1) * DAY_MS).toISOString());
  const recent: LedgerEntry[] = [];
  let beforeSeq = ledger.headSeq() + 1;
  for (;;) {
    const page = ledger.list({ projectId, beforeSeq, limit: PAGE });
    if (page.length === 0) break;
    let older = false;
    for (let i = page.length - 1; i >= 0; i--) {
      const e = page[i]!;
      if (utcDay(e.ts) < firstDay) {
        older = true;
        break;
      }
      recent.push(trim(e));
    }
    if (older) break;
    beforeSeq = page[0]!.seq;
  }
  return dailyDigests(recent, narrationContext(db));
}
