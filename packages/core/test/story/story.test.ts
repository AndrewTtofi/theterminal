import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATES, narrate, type LedgerEntry } from "@theterminal/shared";
import { NotFoundError } from "../../src/board/board-service.js";
import { cardStory, ledgerExportLines, narrationContext } from "../../src/story/story.js";
import { commitEvents } from "../../src/events/commit.js";
import { completeIntake, emit, finishedRun, human, world, type World } from "../gates/setup.js";
import { acceptMirroredLine } from "../../src/link/mirrored.js";
import { pairAndRequest, remoteRun, type RemoteRun } from "../link/remote-fixtures.js";

let w: World;
let cardId: string;

const all = (): LedgerEntry[] => w.ledger.list({ limit: 500 });
const payload = (e: LedgerEntry) => e.payload as Record<string, unknown>;

/** A run on `cardId` with one shell action, allowed (with output) or denied, finishing with `costUsd`. */
function runWithAction(runId: string, onCard: string, allow: boolean, costUsd: number | null): void {
  const p = w.planned;
  emit(w, p, "agent.started", { runId, adapter: "fake", authMode: "none", prompt: "go", cardId: onCard, worktree: `wt/${runId}` }, human);
  const actionId = `${runId}-a1`;
  emit(w, p, "agent.action.requested", {
    runId, actionId, kind: "shell", tool: "Bash", summary: "run the tests", input: { command: "npm test" },
  });
  emit(w, p, "agent.action.decided", {
    runId, actionId, decision: allow ? "allow" : "deny", by: "human", reason: allow ? "" : "not now",
  }, human);
  if (allow) emit(w, p, "agent.action.completed", { runId, actionId, ok: true, output: "tests passed\n" });
  emit(w, p, "agent.finished", { runId, status: "completed", costUsd, error: null });
}

beforeEach(() => {
  w = world();
  completeIntake(w, w.planned);
  cardId = w.board.addCard(human, w.planned, { title: "Checkout", stage: "build" }).id;
});

describe("cardStory", () => {
  it("tells a card's whole story in seq order: card events, both runs and the waiver", () => {
    const other = w.board.addCard(human, w.planned, { title: "Reading list", stage: "build" }).id;
    runWithAction("run-1", cardId, true, 0.25);
    runWithAction("run-other", other, true, 1);
    runWithAction("run-2", cardId, false, 0.5);
    const ack = GATES.find((g) => g.id === "ready_to_ship")!.acknowledgement;
    emit(w, w.planned, "gate.waived", {
      gateId: "ready_to_ship", cardId, from: "build", to: "ship", unmet: ["Tests have not been run"],
      reason: "A demo for the club tonight", acknowledgement: ack, waivedBy: "owner",
    }, human);
    emit(w, w.planned, "card.moved", { cardId, from: "build", to: "ship" }, human);

    const story = cardStory(w.db, w.ledger, cardId);

    expect(story.card).toMatchObject({ id: cardId, title: "Checkout", stage: "ship" });
    expect(story.runs.map((r) => r.id).sort()).toEqual(["run-1", "run-2"]);
    expect(story.actions.map((a) => [a.runId, a.status])).toEqual(
      expect.arrayContaining([["run-1", "completed"], ["run-2", "denied"]]),
    );
    expect(story.actions).toHaveLength(2);
    expect(story.costUsd).toBeCloseTo(0.75);
    expect(story.gateDecisions).toMatchObject([{ gateId: "ready_to_ship", kind: "waived", cardId }]);

    // Every entry about the card or its runs, and nothing else: no plan entries, since the plan did not list this card.
    const expected = all().filter((e) => {
      const p = payload(e);
      return p.cardId === cardId || p.runId === "run-1" || p.runId === "run-2";
    });
    expect(story.entries.map((e) => e.seq)).toEqual(expected.map((e) => e.seq));
    const seqs = story.entries.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const types = story.entries.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining([
      "card.created", "agent.started", "agent.action.requested",
      "agent.action.decided", "agent.action.completed", "agent.finished", "gate.waived", "card.moved",
    ]));
    expect(story.entries.some((e) => payload(e).runId === "run-other" || payload(e).cardId === other)).toBe(false);
    expect(types.filter((t) => t.startsWith("intake."))).toEqual([]);
  });

  it("includes the intake completion that planned the card, and only that intake's decisions up to it", () => {
    const planned = all().find((e) => e.type === "intake.completed")!;
    const plannedCard = (payload(planned).cards as { cardId: string }[])[0]!.cardId;
    // The other project's intake is not part of this card's story.
    completeIntake(w, w.bare);

    const story = cardStory(w.db, w.ledger, plannedCard);

    const decided = all().filter((e) => e.type === "intake.decided" && e.projectId === w.planned);
    expect(story.entries.filter((e) => e.type.startsWith("intake.")).map((e) => e.seq)).toEqual(
      [...decided.map((e) => e.seq), planned.seq],
    );
    expect(story.entries.map((e) => e.type)).toContain("card.created");
    expect(story.entries.map((e) => e.type)).not.toContain("intake.started");
    expect(story.entries.map((e) => e.type)).not.toContain("intake.answered");
    const seqs = story.entries.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(story.costUsd).toBeNull();
    expect(story.runs).toEqual([]);
  });

  it("pages through more entries than one page holds", () => {
    for (let i = 0; i < 260; i++) emit(w, w.planned, "card.moved", { cardId, from: "build", to: i % 2 ? "build" : "design" }, human);
    finishedRun(w, w.planned, "run-1", 0.1, cardId);
    for (let i = 0; i < 260; i++) emit(w, w.planned, "agent.message", { runId: "run-1", text: `line ${i}` });
    const story = cardStory(w.db, w.ledger, cardId);
    // card.created + 260 moves + started + finished + 260 messages
    expect(story.entries).toHaveLength(1 + 260 + 2 + 260);
    expect(story.costUsd).toBeCloseTo(0.1);
  });

  it("costUsd is null when no run reported a cost, and the sum of those that did otherwise", () => {
    finishedRun(w, w.planned, "run-1", null, cardId);
    expect(cardStory(w.db, w.ledger, cardId).costUsd).toBeNull();
    finishedRun(w, w.planned, "run-2", 0.4, cardId);
    expect(cardStory(w.db, w.ledger, cardId).costUsd).toBeCloseTo(0.4);
  });

  it("an unknown card is NotFoundError", () => {
    expect(() => cardStory(w.db, w.ledger, "nope")).toThrow(NotFoundError);
  });
});

describe("narrationContext", () => {
  it("knows card titles and adapter labels, and nothing it was not given", () => {
    finishedRun(w, w.planned, "run-1", 0.1, cardId);
    const ctx = narrationContext(w.db);
    expect(ctx.cardTitle!(cardId)).toBe("Checkout");
    expect(ctx.adapterName!("run-1")).toBe("Fake");
    expect(ctx.cardTitle!("nope")).toBeUndefined();
    expect(ctx.adapterName!("nope")).toBeUndefined();
  });
});

describe("ledgerExportLines", () => {
  const parse = (l: string) => JSON.parse(l) as Record<string, unknown>;

  it("stops at the header's headSeq even when entries are appended while it streams, and writes nothing", () => {
    const head = w.ledger.headSeq();
    const gen = ledgerExportLines(w.db, w.ledger, null, new Date("2026-11-15T00:00:00.000Z"));
    const header = parse(gen.next().value as string);
    expect(header).toEqual({
      kind: "header", exportedAt: "2026-11-15T00:00:00.000Z", projectId: null, headSeq: head, integrity: { ok: true, count: head },
    });
    const first = parse(gen.next().value as string);
    w.board.addCard(human, w.planned, { title: "Added during the export", stage: "build" });
    const rest = [...gen].map(parse);
    expect(rest.pop()).toEqual({ kind: "end", lastSeq: head, gaps: 0 });
    expect([first, ...rest].map((l) => l.seq)).toEqual(Array.from({ length: head }, (_, i) => i + 1));
    expect(w.ledger.headSeq()).toBe(head + 1); // only the card added above: the export appended nothing
    expect(rest.every((l) => l.kind === "entry" && typeof l.headline === "string")).toBe(true);
  });

  it("a project's export holds its entries and the connection.used entries of its runs, and nothing else", () => {
    finishedRun(w, w.planned, "run-club", 0.1, cardId);
    finishedRun(w, w.bare, "run-garden", 0.1);
    for (const runId of ["run-club", "run-garden"]) {
      commitEvents(w.db, w.ledger, () => ({
        events: [{
          projectId: null, actor: { kind: "system", id: "runner" }, type: "connection.used",
          payload: { connectionId: "conn-1", name: "Payments sandbox", runId, purpose: "api_key" },
        }],
        result: () => undefined,
      }));
    }
    const lines = [...ledgerExportLines(w.db, w.ledger, w.planned)].map(parse).slice(1, -1);
    const expected = all().filter((e) => e.projectId === w.planned || (e.type === "connection.used" && payload(e).runId === "run-club"));
    expect(lines.map((l) => l.seq)).toEqual(expected.map((e) => e.seq));
    expect(lines.filter((l) => l.type === "connection.used")).toHaveLength(1);
  });

  it("pages through a ledger longer than one page", () => {
    for (let i = 0; i < 520; i++) emit(w, w.planned, "card.moved", { cardId, from: "build", to: i % 2 ? "build" : "design" }, human);
    const lines = [...ledgerExportLines(w.db, w.ledger, null)];
    expect(lines).toHaveLength(w.ledger.headSeq() + 2);
    expect(parse(lines.at(-1)!)).toEqual({ kind: "end", lastSeq: w.ledger.headSeq(), gaps: 0 });
  });
});

const parse = (l: string) => JSON.parse(l) as Record<string, unknown>;

/** Rewrites a row's payload, as someone editing the database file by hand would. */
function tamper(seq: number, payload: string): void {
  w.db.exec("DROP TRIGGER IF EXISTS ledger_no_update; DROP TRIGGER IF EXISTS ledger_no_delete;");
  w.db.prepare("UPDATE ledger SET payload = ? WHERE seq = ?").run(payload, seq);
}

describe("the integrity check is memoised", () => {
  /** How many times the whole chain was read since the spy was installed. */
  function chainWalks(): () => number {
    const prepare = vi.spyOn(w.db, "prepare");
    return () => prepare.mock.calls.filter(([sql]) => /SELECT \* FROM ledger ORDER BY seq ASC/.test(String(sql))).length;
  }

  it("a second story request does not re-walk the chain, but one after an append does", () => {
    const walks = chainWalks();
    expect(cardStory(w.db, w.ledger, cardId).integrity).toEqual({ ok: true });
    expect(walks()).toBe(1);
    expect(cardStory(w.db, w.ledger, cardId).integrity).toEqual({ ok: true });
    expect(walks()).toBe(1);
    w.board.moveCard(human, cardId, "design");
    expect(cardStory(w.db, w.ledger, cardId).integrity).toEqual({ ok: true });
    expect(walks()).toBe(2);
  });

  it("tampering after a check is still caught", () => {
    expect(cardStory(w.db, w.ledger, cardId).integrity).toEqual({ ok: true });
    tamper(2, "{not json");
    expect(cardStory(w.db, w.ledger, cardId).integrity).toEqual({ ok: false, brokenAtSeq: 2 });
  });
});

describe("tampering is never hidden", () => {
  it("the story flags a broken chain and lists the card's unreadable entries, keeping those after it", () => {
    w.board.moveCard(human, cardId, "design");
    const moved = w.ledger.headSeq();
    w.board.moveCard(human, cardId, "build");
    w.board.addCard(human, w.planned, { title: "Other", stage: "build" });
    const garbage = w.ledger.headSeq();
    w.board.moveCard(human, cardId, "design");
    // Cut off mid-payload: unparseable, though the card's id is still legible in it.
    tamper(moved, `{"cardId":${JSON.stringify(cardId)},"from":"build"`);
    tamper(garbage, "not json at all");

    const story = cardStory(w.db, w.ledger, cardId);

    expect(story.integrity).toEqual({ ok: false, brokenAtSeq: moved });
    expect(story.unreadable).toEqual([{ seq: moved, unreadable: true }]);
    expect(story.entries.map((e) => e.seq)).not.toContain(moved);
    expect(story.entries.filter((e) => e.type === "card.moved")).toHaveLength(2);
    expect(story.entries.at(-1)!.seq).toBe(w.ledger.headSeq());
  });

  it("an intact story says so", () => {
    expect(cardStory(w.db, w.ledger, cardId)).toMatchObject({ integrity: { ok: true }, unreadable: [] });
  });

  it("the export marks a gap, carries on to headSeq and ends with a trailer", () => {
    w.board.moveCard(human, cardId, "design");
    const moved = w.ledger.headSeq();
    w.board.moveCard(human, cardId, "build");
    const head = w.ledger.headSeq();
    tamper(moved, "{not json");

    const out = [...ledgerExportLines(w.db, w.ledger, null)].map(parse);

    expect(out[0]).toMatchObject({ kind: "header", headSeq: head, integrity: { ok: false, brokenAtSeq: moved } });
    expect(out).toContainEqual({ kind: "gap", seq: moved, reason: "unreadable" });
    const entries = out.filter((l) => l.kind === "entry");
    expect(entries).toHaveLength(head - 1);
    expect(entries.at(-1)!.seq).toBe(head);
    expect(out.at(-1)).toEqual({ kind: "end", lastSeq: head, gaps: 1 });
    // The gap sits in seq order.
    expect(out.slice(1, -1).map((l) => l.seq)).toEqual(Array.from({ length: head }, (_, i) => i + 1));
  });

  it("a deleted row is a missing gap", () => {
    w.board.moveCard(human, cardId, "design");
    const moved = w.ledger.headSeq();
    w.board.moveCard(human, cardId, "build");
    w.db.exec("DROP TRIGGER IF EXISTS ledger_no_update; DROP TRIGGER IF EXISTS ledger_no_delete;");
    w.db.prepare("DELETE FROM ledger WHERE seq = ?").run(moved);
    const out = [...ledgerExportLines(w.db, w.ledger, null)].map(parse);
    expect(out[0]).toMatchObject({ integrity: { ok: false, brokenAtSeq: moved + 1 } });
    expect(out).toContainEqual({ kind: "gap", seq: moved, reason: "missing" });
    expect(out.at(-1)).toEqual({ kind: "end", lastSeq: moved + 1, gaps: 1 });
  });

  it("a project's export also marks gaps", () => {
    w.board.moveCard(human, cardId, "design");
    const moved = w.ledger.headSeq();
    tamper(moved, "{not json");
    const out = [...ledgerExportLines(w.db, w.ledger, w.planned)].map(parse);
    expect(out).toContainEqual({ kind: "gap", seq: moved, reason: "unreadable" });
    expect(out.at(-1)).toMatchObject({ kind: "end", gaps: 1 });
  });
});

describe("cardStory with many runs", () => {
  it("batches more than 200 runs", () => {
    for (let i = 0; i < 205; i++) finishedRun(w, w.planned, `run-${i}`, 0.01, cardId);
    const story = cardStory(w.db, w.ledger, cardId);
    expect(story.runs).toHaveLength(205);
    expect(story.entries).toHaveLength(1 + 205 * 2);
    const seqs = story.entries.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(story.costUsd).toBeCloseTo(2.05);
  });
});

describe("a run on a linked machine in the story and the export", () => {
  const SECRET = "sk-ant-TESTKEY-0000000000";
  let remote: RemoteRun;

  beforeEach(async () => {
    remote = await remoteRun("run-on-gpu-box", w.planned);
    pairAndRequest(w.db, w.ledger, remote, "GPU box", cardId);
    for (const e of [
      remote.started(cardId),
      remote.connectionUsed(),
      remote.message(`I found the key ${SECRET} in the config`),
      remote.requested("remote-act-1", `curl -H "x-api-key: ${SECRET}" https://example.com`),
    ]) {
      expect(acceptMirroredLine(w.db, w.ledger, remote.runId, remote.line(e)).ok).toBe(true);
    }
  });

  const mirroredTypes = (entries: LedgerEntry[]) =>
    entries.filter((e) => e.type === "link.mirrored").map((e) => (payload(e).origin as { type: string }).type);

  it("the card's story has the worker's entries, mirrored, and the run", () => {
    const story = cardStory(w.db, w.ledger, cardId);
    expect(story.runs.map((r) => [r.id, r.machineId])).toEqual([[remote.runId, remote.machineId]]);
    expect(mirroredTypes(story.entries)).toEqual(["agent.started", "connection.used", "agent.message", "agent.action.requested"]);
    expect(story.actions.map((a) => [a.id, a.status])).toEqual([["remote-act-1", "pending"]]);
  });

  it("the story shows mirrored text through this machine's own cleaner, and the ledger keeps what was signed", () => {
    const story = cardStory(w.db, w.ledger, cardId);
    expect(JSON.stringify(story.entries)).not.toContain("TESTKEY");
    for (const e of story.entries) expect(narrate(e).headline + (narrate(e).detail ?? "")).not.toContain("TESTKEY");
    const custom = cardStory(w.db, w.ledger, cardId, (t) => t.replaceAll("config", "[CLEANED]"));
    expect(JSON.stringify(custom.entries)).toContain("[CLEANED]");
    expect(JSON.stringify(all())).toContain("TESTKEY");
  });

  it("the project export has every mirrored entry, the null-project connection.used too, redacted and marked as cleaned", () => {
    const out = [...ledgerExportLines(w.db, w.ledger, w.planned)].map((l) => JSON.parse(l) as Record<string, unknown>);
    const entries = out.filter((l) => l.kind === "entry") as unknown as (LedgerEntry & { headline: string; cleaned?: true })[];
    expect(mirroredTypes(entries)).toEqual(["agent.started", "connection.used", "agent.message", "agent.action.requested"]);
    expect(out.map((l) => JSON.stringify(l)).join("\n")).not.toContain("TESTKEY");
    const message = entries.find((e) => e.type === "link.mirrored" && (payload(e).origin as { type: string }).type === "agent.message")!;
    expect(message.headline).toMatch(/^On a linked machine: The Fake agent said: "I found the key \[REDACTED\]/);
    expect(message.cleaned).toBe(true);
    const started = entries.find((e) => e.type === "link.mirrored")!;
    expect(started.cleaned).toBeUndefined();
    expect(out.at(-1)).toMatchObject({ kind: "end", gaps: 0 });
  });
});
