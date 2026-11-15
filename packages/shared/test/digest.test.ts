import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DIGEST_ITEM_TYPES,
  DIGEST_MAX_ITEMS,
  dailyDigests,
  digestDay,
  eventPayloadSchemas,
  utcDay,
  type Actor,
  type EventType,
  type LedgerEntry,
  type NarrationContext,
} from "../src/index.js";

const owner: Actor = { kind: "human", id: "owner" };
const agent: Actor = { kind: "agent", id: "r1" };
const policy: Actor = { kind: "system", id: "policy" };
const runner: Actor = { kind: "system", id: "runner" };

const OUTPUT = "zq-TESTKEY-e2e-opaque-0000000000";
const DAY = "2026-11-15";

function make(day = DAY) {
  let seq = 0;
  return (type: EventType, payload: unknown, actor: Actor = owner, time = "10:00:00.000"): LedgerEntry => {
    seq += 1;
    return {
      seq,
      id: `e${seq}`,
      ts: `${day}T${time}Z`,
      projectId: "p1",
      actor,
      type,
      payload,
      prevHash: "",
      hash: "",
    };
  };
}

const ctx: NarrationContext = {
  cardTitle: (id) => (id === "c1" ? "Login" : undefined),
  adapterName: (id) => (id === "r1" ? "fake" : undefined),
};

function fixtureDay(): LedgerEntry[] {
  const e = make();
  return [
    e("project.created", { projectId: "p1", name: "Book club", pitch: "" }),
    e("card.created", { cardId: "c1", title: "Login", stage: "plan" }),
    e("card.moved", { cardId: "c1", from: "plan", to: "build" }),
    e("agent.started", {
      runId: "r1",
      adapter: "fake",
      authMode: "none",
      prompt: "secret plan",
      cardId: "c1",
      worktree: "wt/r1",
    }),
    e(
      "agent.action.requested",
      { runId: "r1", actionId: "a1", kind: "shell", tool: "Bash", summary: "Run: nvidia-smi", input: { command: "nvidia-smi" } },
      agent,
    ),
    e("agent.action.decided", { runId: "r1", actionId: "a1", decision: "allow", by: "human", reason: "" }),
    e(
      "agent.action.decided",
      { runId: "r1", actionId: "a2", decision: "deny", by: "policy", reason: "edits outside the project" },
      policy,
    ),
    e("agent.action.completed", { runId: "r1", actionId: "a1", ok: true, output: OUTPUT }, agent),
    e("agent.message", { runId: "r1", text: "All done" }, agent),
    e(
      "agent.finished",
      { runId: "r1", status: "completed", costUsd: 0.25, inputTokens: 10, outputTokens: 20, error: null },
      runner,
    ),
  ];
}

describe("the fixture", () => {
  it("is made of valid payloads", () => {
    for (const entry of fixtureDay()) {
      expect(eventPayloadSchemas[entry.type].safeParse(entry.payload).success, entry.type).toBe(true);
    }
  });
});

describe("utcDay", () => {
  it("is the date part of an ISO timestamp", () => {
    expect(utcDay("2026-11-15T23:59:59.000Z")).toBe("2026-11-15");
    expect(utcDay("2026-11-16T00:00:00.000Z")).toBe("2026-11-16");
  });
});

describe("digestDay", () => {
  const d = digestDay(DAY, fixtureDay(), ctx);

  it("counts the day", () => {
    expect(d.day).toBe(DAY);
    expect(d.counts).toEqual({
      entries: 10,
      actions: 1,
      allowed: 1,
      denied: 0,
      decisions: 1,
      cardsMoved: 1,
      runsStarted: 1,
      runsFinished: 1,
      spendUsd: 0.25,
    });
  });

  it("summarises the day in one exact sentence", () => {
    expect(d.summary).toBe(
      "10 ledger entries: 1 agent action requested, 1 allowed and 0 denied by a human, 1 decision by a human, 1 card moved, 1 agent run started and 1 finished. Agent spend recorded that day: $0.25 (estimate).",
    );
  });

  it("lists no messages, outputs, prompts or policy decisions", () => {
    const types = d.items.map((i) => fixtureDay()[i.seq - 1]!.type);
    expect(types).not.toContain("agent.message");
    expect(types).not.toContain("agent.action.completed");
    expect(d.items.map((i) => i.seq)).not.toContain(7);
    for (const item of d.items) {
      expect(item.headline).not.toContain("secret plan");
      expect(item.headline).not.toContain(OUTPUT);
      expect(item.headline).not.toContain("All done");
    }
    expect(JSON.stringify(d)).not.toContain("secret plan");
    expect(JSON.stringify(d)).not.toContain("TESTKEY");
    expect(d.items.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6, 10]);
    expect(d.more).toBe(0);
  });

  it("names the card an agent started on, never the prompt (Review Focus 5)", () => {
    const started = d.items.find((i) => i.seq === 4);
    expect(started?.headline).toBe('Owner started a Fake agent on "Login"');
    expect(started?.topic).toBe("agent");
  });

  it("says only the adapter when the card does not resolve", () => {
    const noCard = digestDay(DAY, fixtureDay(), {});
    expect(noCard.items.find((i) => i.seq === 4)?.headline).toBe("Owner started a Fake agent");
    expect(JSON.stringify(noCard)).not.toContain("secret plan");
  });

  it("names the person who started an agent, with or without the card", () => {
    const e = make();
    const p1: Actor = { kind: "human", id: "p1" };
    const run = { runId: "r1", adapter: "fake", authMode: "none", prompt: "secret plan", worktree: "wt/r1" };
    const entries = [e("agent.started", { ...run, cardId: "c1" }, p1), e("agent.started", { ...run, runId: "r2", cardId: "c9" }, p1)];
    const named = digestDay(DAY, entries, { ...ctx, personName: (id) => (id === "p1" ? "Reviewer One" : undefined) });
    expect(named.items.map((i) => i.headline)).toEqual(['Reviewer One started a Fake agent on "Login"', "Reviewer One started a Fake agent"]);
    expect(digestDay(DAY, entries, {}).items.map((i) => i.headline)).toEqual(["Someone started a Fake agent", "Someone started a Fake agent"]);
    expect(JSON.stringify(named)).not.toContain("secret plan");
  });

  it("carries the narration's attention and time", () => {
    const requested = d.items.find((i) => i.seq === 5);
    expect(requested?.attention).toBe(true);
    expect(requested?.topic).toBe("agent");
    expect(requested?.time).toBe("10:00");
    expect(d.items.find((i) => i.seq === 6)?.topic).toBe("decision");
  });

  it("ignores entries of other days and sorts by seq whatever the input order", () => {
    const other = make("2026-11-14")("card.created", { cardId: "c9", title: "Other", stage: "plan" });
    const shuffled = [...fixtureDay()].reverse();
    const out = digestDay(DAY, [other, ...shuffled], ctx);
    expect(out).toEqual(d);
  });

  it("lists the first 100 items and counts the rest", () => {
    const e = make();
    const many = Array.from({ length: 150 }, (_, i) =>
      e("card.created", { cardId: `c${i}`, title: `Card ${i}`, stage: "plan" }),
    );
    const out = digestDay(DAY, many);
    expect(DIGEST_MAX_ITEMS).toBe(100);
    expect(out.items).toHaveLength(100);
    expect(out.more).toBe(50);
    expect(out.items[0]!.seq).toBe(1);
    expect(out.items[99]!.seq).toBe(100);
  });

  it("counts denials and the other decisions, and has no spend line when nothing was spent", () => {
    const e = make();
    const out = digestDay(DAY, [
      e("agent.action.decided", { runId: "r1", actionId: "a1", decision: "deny", by: "human", reason: "no" }),
      e("intake.decided", { intakeId: "i1", decisionId: "hosting", chosen: "local", rationale: "", owner: "owner" }),
      e("agent.finished", { runId: "r1", status: "failed", costUsd: null, error: "boom" }, runner),
    ]);
    expect(out.counts).toMatchObject({ entries: 3, actions: 0, allowed: 0, denied: 1, decisions: 2, runsFinished: 1, spendUsd: null });
    expect(out.summary).toBe(
      "3 ledger entries: 0 agent actions requested, 0 allowed and 1 denied by a human, 2 decisions by a human, 0 cards moved, 0 agent runs started and 1 finished.",
    );
  });

  it("says 1 entry for a single entry", () => {
    const e = make();
    const out = digestDay(DAY, [e("card.moved", { cardId: "c1", from: "plan", to: "build" })]);
    expect(out.summary.startsWith("1 ledger entry: ")).toBe(true);
  });

  it("is deterministic and leaves its input alone", () => {
    const input = fixtureDay();
    const clone = structuredClone(input);
    const a = digestDay(DAY, input, ctx);
    const b = digestDay(DAY, clone, ctx);
    expect(a).toEqual(b);
    expect(digestDay(DAY, input, ctx)).toEqual(a);
    expect(input).toEqual(fixtureDay());
  });
});

describe("dailyDigests", () => {
  it("returns one digest per day, newest first", () => {
    const older = make("2026-11-14")("card.created", { cardId: "c9", title: "Other", stage: "plan" });
    const newer = fixtureDay().map((e) => ({ ...e, seq: e.seq + 1 }));
    const out = dailyDigests([older, ...newer], ctx);
    expect(out.map((d) => d.day)).toEqual(["2026-11-15", "2026-11-14"]);
    expect(out[1]!.counts.entries).toBe(1);
    expect(out[0]!.counts.entries).toBe(10);
  });

  it("is empty for no entries and deterministic", () => {
    expect(dailyDigests([])).toEqual([]);
    const input = fixtureDay();
    expect(dailyDigests(input, ctx)).toEqual(dailyDigests(structuredClone(input), ctx));
  });
});

describe("DIGEST_ITEM_TYPES", () => {
  it("names only event types that exist", () => {
    for (const type of DIGEST_ITEM_TYPES) expect(eventPayloadSchemas[type], type).toBeDefined();
    expect(DIGEST_ITEM_TYPES).not.toContain("agent.message");
    expect(DIGEST_ITEM_TYPES).not.toContain("agent.action.completed");
  });
});

describe("digest.ts purity", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/digest.ts", import.meta.url)), "utf8");
  it("imports only the pure modules", () => {
    const imports = [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(source.match(/^\s*import\b/gm)?.length).toBe(imports.length);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(["./narration.js", "./domain.js", "./agents.js", "./events.js", "./text.js"]).toContain(spec);
    }
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  it("reads no clock, randomness, network or environment", () => {
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/\bfetch\b/);
    expect(source).not.toMatch(/\bprocess\b/);
    expect(source).not.toMatch(/\bglobalThis\b/);
  });
});
