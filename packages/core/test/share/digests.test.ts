import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../../src/board/board-service.js";
import { projectDigests } from "../../src/share/digests.js";
import { human, world, type World } from "./setup.js";

let w: World;
let projectId: string;
let otherId: string;
const NOW = () => new Date("2026-11-15T12:00:00.000Z");

beforeEach(() => {
  w = world();
  w.at("2026-11-01T10:00:00.000Z");
  projectId = w.board.createProject(human, { name: "Book Club" }).id;
  otherId = w.board.createProject(human, { name: "Garden Log" }).id;
});

const card = (pid: string, title: string, iso: string) => {
  w.at(iso);
  return w.board.addCard(human, pid, { title, stage: "plan" }).id;
};

describe("projectDigests", () => {
  it("one digest per UTC day of the window, newest first, of this project only", () => {
    card(projectId, "Eight days ago", "2026-11-07T23:59:00.000Z");
    card(projectId, "Monday", "2026-11-13T08:00:00.000Z");
    card(otherId, "Garden bed", "2026-11-13T09:00:00.000Z");
    card(projectId, "Tuesday", "2026-11-14T08:00:00.000Z");
    card(projectId, "Today one", "2026-11-15T00:00:00.000Z");
    card(projectId, "Today two", "2026-11-15T11:00:00.000Z");

    const d = projectDigests(w.db, w.ledger, projectId, 7, NOW);
    expect(d.map((x) => x.day)).toEqual(["2026-11-15", "2026-11-14", "2026-11-13"]);
    expect(d[0]!.counts.entries).toBe(2);
    expect(d[2]!.counts.entries).toBe(1);
    const headlines = d.flatMap((x) => x.items.map((i) => i.headline)).join("\n");
    expect(headlines).toContain("Monday");
    expect(headlines).not.toContain("Garden bed");
    expect(headlines).not.toContain("Eight days ago");
  });

  it("the window starts at UTC midnight days-1 days ago", () => {
    card(projectId, "Before", "2026-11-08T23:59:59.000Z");
    card(projectId, "Edge", "2026-11-09T00:00:00.000Z");
    expect(projectDigests(w.db, w.ledger, projectId, 7, NOW).map((x) => x.day)).toEqual(["2026-11-09"]);
    expect(projectDigests(w.db, w.ledger, projectId, 14, NOW).map((x) => x.day)).toEqual(["2026-11-09", "2026-11-08"]);
  });

  it("pages backwards and stops at the first entry older than the window", () => {
    // 600 old entries, then two in the window: one page reaches back past the window start.
    w.at("2026-10-01T00:00:00.000Z");
    const old = w.board.addCard(human, projectId, { title: "Old", stage: "plan" }).id;
    for (let i = 0; i < 600; i++) w.board.setCardStatus(human, old, i % 2 === 0 ? "done" : "todo");
    card(projectId, "Recent one", "2026-11-15T09:00:00.000Z");
    card(projectId, "Recent two", "2026-11-15T09:30:00.000Z");

    const spy = vi.spyOn(w.ledger, "list");
    const d = projectDigests(w.db, w.ledger, projectId, 7, NOW);
    expect(d.map((x) => x.day)).toEqual(["2026-11-15"]);
    expect(d[0]!.counts.entries).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ projectId, beforeSeq: w.ledger.headSeq() + 1, limit: 500 });
  });

  it("reads every page while the entries are inside the window", () => {
    w.at("2026-11-15T01:00:00.000Z");
    const c = w.board.addCard(human, projectId, { title: "Busy", stage: "plan" }).id;
    for (let i = 0; i < 1100; i++) w.board.setCardStatus(human, c, i % 2 === 0 ? "done" : "todo");
    const spy = vi.spyOn(w.ledger, "list");
    const d = projectDigests(w.db, w.ledger, projectId, 7, NOW);
    expect(d[0]!.counts.entries).toBe(1101);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [q] of spy.mock.calls) expect(q).toHaveProperty("beforeSeq");
  });

  it("an empty window is an empty list, and an unknown project is not found", () => {
    expect(projectDigests(w.db, w.ledger, projectId, 7, NOW)).toEqual([]);
    expect(() => projectDigests(w.db, w.ledger, "nope", 7, NOW)).toThrow(NotFoundError);
  });
});
