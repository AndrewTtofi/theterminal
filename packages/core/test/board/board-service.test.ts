import { describe, it, expect, beforeEach } from "vitest";
import { STAGES } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger, LedgerReadOnlyError } from "../../src/ledger/ledger.js";
import { homedir } from "node:os";
import { BoardService, NotFoundError } from "../../src/board/board-service.js";
import { RecordedText, SecretInTextError } from "../../src/intake/service.js";
import { applyEvent } from "../../src/events/projections.js";

const human = { kind: "human", id: "owner" } as const;
const agent = { kind: "agent", id: "a1" } as const;

let db: Db;
let ledger: Ledger;
let board: BoardService;

beforeEach(() => {
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  board = new BoardService(db, ledger);
});

describe("BoardService", () => {
  it("createProject returns a project and writes one project.created entry", () => {
    const p = board.createProject(human, { name: "Acme", pitch: "p" });
    const entries = ledger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("project.created");
    expect(entries[0]!.projectId).toBe(p.id);
    expect(p).toMatchObject({ name: "Acme", pitch: "p", createdAt: entries[0]!.ts });
    expect(board.listProjects()).toEqual([p]);
  });

  it("defaults pitch to empty and rejects invalid input without writing", () => {
    expect(board.createProject(human, { name: "X" }).pitch).toBe("");
    expect(() => board.createProject(human, { name: "" })).toThrow();
    expect(ledger.list()).toHaveLength(1);
  });

  it("listProjects is newest first", () => {
    const a = board.createProject(human, { name: "A" });
    const b = board.createProject(human, { name: "B" });
    expect(board.listProjects().map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it("getBoard on a new project has all stage keys empty", () => {
    const p = board.createProject(human, { name: "A" });
    const b = board.getBoard(p.id);
    expect(Object.keys(b.columns)).toEqual([...STAGES]);
    for (const s of STAGES) expect(b.columns[s]).toEqual([]);
  });

  it("adds and moves cards, recording the actor", () => {
    const p = board.createProject(human, { name: "A" });
    const c1 = board.addCard(human, p.id, { title: "one", stage: "plan" });
    board.addCard(human, p.id, { title: "two", stage: "plan" });
    expect(c1.status).toBe("todo");
    const moved = board.moveCard(agent, c1.id, "build");
    expect(moved.stage).toBe("build");
    const b = board.getBoard(p.id);
    expect(b.columns.plan).toHaveLength(1);
    expect(b.columns.build.map((c) => c.id)).toEqual([c1.id]);
    const last = ledger.list({ projectId: p.id }).at(-1)!;
    expect(last.type).toBe("card.moved");
    expect(last.actor).toEqual(agent);
    expect(last.payload).toEqual({ cardId: c1.id, from: "plan", to: "build" });
  });

  it("moving to the same stage writes no entry", () => {
    const p = board.createProject(human, { name: "A" });
    const c = board.addCard(human, p.id, { title: "one", stage: "plan" });
    const before = ledger.list().length;
    expect(board.moveCard(human, c.id, "plan")).toEqual(c);
    expect(ledger.list()).toHaveLength(before);
  });

  it("setCardStatus updates status and records an entry", () => {
    const p = board.createProject(human, { name: "A" });
    const c = board.addCard(human, p.id, { title: "one", stage: "plan" });
    expect(board.setCardStatus(agent, c.id, "active").status).toBe("active");
    const last = ledger.list().at(-1)!;
    expect(last.type).toBe("card.status_changed");
    expect(last.payload).toEqual({ cardId: c.id, from: "todo", to: "active" });
  });

  it("unknown ids throw NotFoundError and write nothing", () => {
    const p = board.createProject(human, { name: "A" });
    const n = ledger.list().length;
    expect(() => board.moveCard(human, "nope", "build")).toThrow(NotFoundError);
    expect(() => board.setCardStatus(human, "nope", "done")).toThrow(NotFoundError);
    expect(() => board.addCard(human, "nope", { title: "t", stage: "plan" })).toThrow(NotFoundError);
    expect(() => board.getBoard("nope")).toThrow(NotFoundError);
    expect(ledger.list()).toHaveLength(n);
    expect(p).toBeTruthy();
  });

  it("rebuildProjections reproduces identical boards", () => {
    const p1 = board.createProject(human, { name: "A", pitch: "x" });
    const p2 = board.createProject(human, { name: "B" });
    const c1 = board.addCard(human, p1.id, { title: "one", stage: "plan" });
    const c2 = board.addCard(agent, p1.id, { title: "two", stage: "design" });
    board.addCard(agent, p2.id, { title: "three", stage: "ship" });
    board.moveCard(human, c1.id, "build");
    board.setCardStatus(agent, c2.id, "blocked");
    board.setCardStatus(agent, c1.id, "done");
    const snap = () => ({ projects: board.listProjects(), boards: [p1, p2].map((p) => board.getBoard(p.id)) });
    const before = snap();
    board.rebuildProjections();
    expect(snap()).toEqual(before);
  });

  it("rolls back the ledger entry when applyEvent throws, and does not notify", () => {
    const failing = new BoardService(db, ledger, {
      applyEvent: (d, e) => {
        if (e.type === "card.created") throw new Error("boom");
        applyEvent(d, e);
      },
    });
    const p = failing.createProject(human, { name: "A" });
    const n = ledger.list().length;
    const seen: unknown[] = [];
    ledger.onAppend((e) => seen.push(e));
    expect(() => failing.addCard(human, p.id, { title: "t", stage: "plan" })).toThrow("boom");
    expect(ledger.list()).toHaveLength(n);
    expect(seen).toHaveLength(0);
    expect(failing.getBoard(p.id).columns.plan).toEqual([]);
  });

  it("notifies listeners after commit and propagates LedgerReadOnlyError", () => {
    const seen: string[] = [];
    ledger.onAppend((e) => seen.push(e.type));
    const p = board.createProject(human, { name: "A" });
    expect(seen).toEqual(["project.created"]);
    ledger.readOnly = true;
    expect(() => board.addCard(human, p.id, { title: "t", stage: "plan" })).toThrow(LedgerReadOnlyError);
  });
});

describe("names and titles are recorded text", () => {
  const SECRET = "sk-ant-TESTKEY-0000000000";
  const bearing = "clubuser!Hunter2Pass";
  let recorded: RecordedText;
  beforeEach(() => {
    recorded = new RecordedText({ username: "clubuser", secrets: () => [bearing] });
    board = new BoardService(db, ledger, { recorded });
  });

  it("refuses a secret in a project name or a card title, writing nothing", () => {
    expect(() => board.createProject(human, { name: `Club ${SECRET}` })).toThrow(SecretInTextError);
    const p = board.createProject(human, { name: "Club" });
    const head = ledger.headSeq();
    expect(() => board.addCard(human, p.id, { title: `Log in with ${SECRET}`, stage: "build" })).toThrow(SecretInTextError);
    expect(ledger.headSeq()).toBe(head);
    expect(JSON.stringify(ledger.list())).not.toContain("TESTKEY");
  });

  it("refuses a secret that contains the username, which the scrubber would otherwise rewrite", () => {
    expect(() => board.createProject(human, { name: `Club ${bearing}` })).toThrow(SecretInTextError);
    const p = board.createProject(human, { name: "Club" });
    expect(() => board.addCard(human, p.id, { title: `password ${bearing}`, stage: "plan" })).toThrow(SecretInTextError);
    expect(JSON.stringify(ledger.list())).not.toContain("Hunter2Pass");
  });

  it("checks and scrubs the pitch too, which may stay empty", () => {
    expect(() => board.createProject(human, { name: "Club", pitch: `key ${SECRET}` })).toThrow(SecretInTextError);
    expect(() => board.createProject(human, { name: "Club", pitch: `ask ${bearing}` })).toThrow(SecretInTextError);
    expect(ledger.headSeq()).toBe(0);
    expect(board.createProject(human, { name: "Club" }).pitch).toBe("");
    expect(board.createProject(human, { name: "Club", pitch: "   " }).pitch).toBe("");
    expect(board.createProject(human, { name: "Club", pitch: `notes in ${homedir()}/club by clubuser` }).pitch).toBe(
      "notes in ~/club by <user>",
    );
    expect(() => board.createProject(human, { name: "Club", pitch: "x".repeat(501) })).toThrow();
    expect(JSON.stringify(ledger.list())).not.toContain("TESTKEY");
  });

  it("scrubs paths and the username from names and titles", () => {
    const p = board.createProject(human, { name: `  clubuser in ${homedir()}/club  ` });
    expect(p.name).toBe("<user> in ~/club");
    const c = board.addCard(human, p.id, { title: `Read ${homedir()}/notes.md`, stage: "plan" });
    expect(c.title).toBe("Read ~/notes.md");
    expect(JSON.stringify(ledger.list())).not.toContain(homedir());
  });
});
