import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SHARE_OPTIONS, HIDDEN_BY_DEFAULT, type ShareSnapshot } from "@theterminal/shared";
import {
  EMAIL, SHARE_TEXT_MAX, ShareNotCleanError, assertClean, cleanSnapshot, shareCleaner,
} from "../../src/share/clean.js";

const SECRET = "zq-TESTKEY-e2e-opaque-0000000000";
const dataDir = join(tmpdir(), "theterminal-share-clean-data");
const clean = shareCleaner({ dataDir, secrets: () => [SECRET], username: "alice", home: "/Users/alice" });

function snapshot(): ShareSnapshot {
  return {
    version: 1,
    generatedAt: "2026-11-15T12:00:00.000Z",
    options: { ...DEFAULT_SHARE_OPTIONS },
    hidden: [...HIDDEN_BY_DEFAULT],
    project: { name: "Book Club", pitch: "Reading lists", createdAt: "2026-11-14T09:00:00.000Z" },
    owner: "Owner",
    progress: {
      plan: { total: 0, done: 0 }, design: { total: 0, done: 0 }, build: { total: 0, done: 0 }, ship: { total: 0, done: 0 },
      operate: { total: 0, done: 0 },
    },
    currentStage: null,
    numbers: {
      cardsTotal: 0, cardsDone: 0, runsTotal: 0, runsCompleted: 0, overrides: 0, spendUsd: { value: null, basis: "not_reported" },
      budgetUsd: null, costPerDayUsd: { value: null, basis: "not_reported" }, decisionsMade: 1, decisionsWaiting: 0, ci: null,
    },
    summary: null,
    idea: null,
    stack: [],
    workforce: [],
    waiting: [],
    decisions: [{
      kind: "gate_waiver", headline: "Owner waived a gate", by: "Owner", at: "2026-11-15T10:00:00.000Z",
      reason: `Tested by alice from /Users/alice/club with ${SECRET}`, evidence: { seq: 3, hash12: "a1b2c3d4e5f6", at: "2026-11-15T10:00:00.000Z" },
    }],
    decisionsOmitted: 0,
    readiness: [],
    digests: [],
    asks: [],
    history: [],
    hardware: null,
    audit: { ok: true, entries: 40, brokenAtSeq: null, headSeq: 40, headHash12: "9f8e7d6c5b4a" },
  };
}

describe("shareCleaner", () => {
  it("redacts secrets, scrubs the home path and the username, and replaces email addresses", () => {
    expect(clean(`key ${SECRET} in /Users/alice/x by alice, mail someone@example.test`, 4000)).toBe(
      "key [REDACTED] in ~/x by <user>, mail [email]",
    );
  });

  it("replaces an address whose local part is the username, domain included", () => {
    expect(clean("mail alice@example.test", 4000)).toBe("mail [email]");
  });

  it("scrubs the data folder as <data>", () => {
    expect(clean(`log at ${join(dataDir, "logs", "a.log")}`, 4000)).toBe(`log at ${join("<data>", "logs", "a.log")}`);
  });

  it("cuts a long text at the cap after redaction: a secret past the cut is gone, not half-present", () => {
    const long = `${"a".repeat(4100)}${SECRET}${"b".repeat(5000 - 4100 - SECRET.length)}`;
    expect(long).toHaveLength(5000);
    const out = clean(long, SHARE_TEXT_MAX);
    expect(out).toHaveLength(4000);
    expect(out).not.toContain("zq-");
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("a secret straddling the cut leaves no fragment of itself", () => {
    const long = `${"a".repeat(3985)}${SECRET}${"b".repeat(1000)}`;
    const out = clean(long, SHARE_TEXT_MAX);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).not.toContain("zq-");
    expect(out).not.toContain("TESTKEY");
  });

  it("reads the secrets on every call", () => {
    const secrets: string[] = [];
    const c = shareCleaner({ dataDir, secrets: () => secrets, username: "", home: "/Users/alice" });
    expect(c("token later-TESTKEY-value-1234", 100)).toBe("token later-TESTKEY-value-1234");
    secrets.push("later-TESTKEY-value-1234");
    expect(c("token later-TESTKEY-value-1234", 100)).toBe("token [REDACTED]");
  });

  it("EMAIL matches an address and not a bare at sign", () => {
    expect("a.b+c@mail.example.org".match(EMAIL)).toEqual(["a.b+c@mail.example.org"]);
    expect("meet @ noon".match(EMAIL)).toBeNull();
  });
});

describe("cleanSnapshot", () => {
  it("cleans a nested string and leaves numbers, keys and plain strings alone", () => {
    const s = snapshot();
    const out = cleanSnapshot(s, clean);
    expect(out.decisions[0]!.reason).toBe("Tested by <user> from ~/club with [REDACTED]");
    expect(out.audit.headSeq).toBe(40);
    expect(typeof out.audit.headSeq).toBe("number");
    expect(out.decisions[0]!.evidence).toEqual(s.decisions[0]!.evidence);
    expect(out.generatedAt).toBe(s.generatedAt);
    expect(out.hidden).toEqual(s.hidden);
    expect(Object.keys(out)).toEqual(Object.keys(s));
    // The input is not changed.
    expect(s.decisions[0]!.reason).toContain(SECRET);
  });

  it("caps every string, an oversized one included", () => {
    const s = snapshot();
    s.project.pitch = "x".repeat(10_000);
    expect(cleanSnapshot(s, clean).project.pitch).toHaveLength(SHARE_TEXT_MAX);
  });
});

describe("assertClean", () => {
  it("throws ShareNotCleanError for a page that still holds a secret, and passes a clean one", () => {
    expect(() => assertClean("<p>sk-ant-TESTKEY-0000000000</p>", clean)).toThrow(ShareNotCleanError);
    expect(() => assertClean("<p>sk-ant-TESTKEY-0000000000</p>", clean)).toThrow("the share page could not be proven clean");
    expect(() => assertClean("<p>Book Club, by the Owner</p>", clean)).not.toThrow();
  });

  it("throws for an email address, a home path or the username", () => {
    for (const html of ["<p>someone@example.test</p>", "<p>/Users/alice/notes</p>", "<p>by alice</p>"]) {
      expect(() => assertClean(html, clean)).toThrow(ShareNotCleanError);
    }
  });
});
