import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SHARE_OPTIONS, HIDDEN_BY_DEFAULT, type ShareSnapshot } from "@theterminal/shared";
import {
  EMAIL, SHARE_TEXT_MAX, ShareNotCleanError, assertClean, cleanSnapshot, shareCleaner,
} from "../../src/share/clean.js";
import { renderShareHtml } from "../../src/share/render.js";

const SECRET = "zq-TESTKEY-e2e-opaque-0000000000";
const dataDir = join(tmpdir(), "theterminal-share-clean-data");
const clean = shareCleaner({ dataDir, secrets: () => [SECRET], username: "alice", home: "/Users/alice" });
const text = (s: string) => clean.text(s, 4000);

/** Usernames that are also words of the page's template, its enums or its fixed labels. */
const WORD_USERNAMES = ["data", "owner", "root", "work", "user", "open", "build", "claude"];
const cleanerFor = (username: string) => shareCleaner({ dataDir, secrets: () => [SECRET], username, home: join("/Users", username) });

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

/** A project with nothing in it yet: what every Owner's first preview is made from. */
function emptyProject(): ShareSnapshot {
  return {
    ...snapshot(),
    numbers: { ...snapshot().numbers, decisionsMade: 0 },
    decisions: [],
    readiness: [
      { gateId: "plan_approved", title: "Plan approved", state: "not_reached", detail: null, cardTitle: null, at: null, evidence: null },
    ],
  };
}

/** A project whose enum-typed fields hold the words that are also usernames. */
function enumHeavy(): ShareSnapshot {
  return {
    ...snapshot(),
    currentStage: "build",
    progress: { ...snapshot().progress, build: { total: 2, done: 1 } },
    numbers: { ...snapshot().numbers, ci: "open" as never },
    workforce: [{
      adapter: "claude", label: "Claude Code", runs: 1, completed: 1, failed: 0, stopped: 0, costUsd: { value: null, basis: "not_reported" },
      inputTokens: null, outputTokens: null,
    }],
    waiting: [{ kind: "action", headline: "An agent wants to open a file", since: null, cardTitle: null, assignee: "Owner" }],
    readiness: [
      { gateId: "ready_to_ship", title: "Ready to ship", state: "open", detail: "work left: build the login", cardTitle: "Login", at: null, evidence: null },
    ],
    digests: [{
      day: "2026-11-15", summary: "1 ledger entry.", counts: { entries: 1, actions: 0, allowed: 0, denied: 0, decisions: 0, cardsMoved: 0, runsStarted: 0, runsFinished: 0, spendUsd: null },
      items: [{ seq: 1, time: "10:00", headline: "Owner created the project", topic: "board", attention: false }], more: 0,
    }],
    asks: [{ day: "2026-11-15", time: "10:00", adapterLabel: "Claude Code", cardTitle: "Login", prompt: "build it" }],
    hardware: { cpu: "Apple M1", cores: 8, memoryGb: 16, gpu: null, gpuMemoryGb: null, platform: "darwin", wsl: false, detectedAt: "2026-11-15T09:00:00.000Z" },
  };
}

describe("shareCleaner", () => {
  it("redacts secrets, scrubs the home path and the username, and replaces email addresses", () => {
    expect(text(`key ${SECRET} in /Users/alice/x by alice, mail someone@example.test`)).toBe(
      "key [REDACTED] in ~/x by <user>, mail [email]",
    );
  });

  it("replaces an address whose local part is the username, domain included", () => {
    expect(text("mail alice@example.test")).toBe("mail [email]");
  });

  it("scrubs the data folder as <data>", () => {
    expect(text(`log at ${join(dataDir, "logs", "a.log")}`)).toBe(`log at ${join("<data>", "logs", "a.log")}`);
  });

  it("cuts a long text at the cap after redaction: a secret past the cut is gone, not half-present", () => {
    const long = `${"a".repeat(4100)}${SECRET}${"b".repeat(5000 - 4100 - SECRET.length)}`;
    expect(long).toHaveLength(5000);
    const out = clean.text(long, SHARE_TEXT_MAX);
    expect(out).toHaveLength(4000);
    expect(out).not.toContain("zq-");
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("a secret straddling the cut leaves no fragment of itself", () => {
    const long = `${"a".repeat(3985)}${SECRET}${"b".repeat(1000)}`;
    const out = clean.text(long, SHARE_TEXT_MAX);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).not.toContain("zq-");
    expect(out).not.toContain("TESTKEY");
  });

  it("reads the secrets on every call", () => {
    const secrets: string[] = [];
    const c = shareCleaner({ dataDir, secrets: () => secrets, username: "", home: "/Users/alice" });
    expect(c.text("token later-TESTKEY-value-1234", 100)).toBe("token later-TESTKEY-value-1234");
    secrets.push("later-TESTKEY-value-1234");
    expect(c.text("token later-TESTKEY-value-1234", 100)).toBe("token [REDACTED]");
  });

  it("EMAIL matches an address and not a bare at sign", () => {
    expect("a.b+c@mail.example.org".match(EMAIL)).toEqual(["a.b+c@mail.example.org"]);
    expect("meet @ noon".match(EMAIL)).toBeNull();
  });

  it("scrubs the username once: cleaning a cleaned text changes nothing, even for the username user", () => {
    const c = cleanerFor("user");
    const once = c.text("a user signs in, then <user> signs out", 4000);
    expect(once).toBe("a <user> signs in, then <user> signs out");
    expect(c.text(once, 4000)).toBe(once);
    const d = cleanerFor("data");
    expect(d.text(`log at ${join(dataDir, "logs")} by data`, 4000)).toBe(`log at ${join("<data>", "logs")} by <user>`);
  });

  it("markup: redacts secrets, email addresses and paths, never the username and never cut", () => {
    expect(clean.markup(`<p>${SECRET} someone@example.test /Users/alice/notes</p>`)).toBe("<p>[REDACTED] [email] ~/notes</p>");
    expect(clean.markup("<p>by alice</p>")).toBe("<p>by alice</p>");
    const long = "x".repeat(SHARE_TEXT_MAX + 100);
    expect(clean.markup(long)).toBe(long);
  });
});

describe("cleanSnapshot", () => {
  it("cleans a free-text field and leaves numbers, keys, dates, ids and fixed copy alone", () => {
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

  it("caps every free text, an oversized one included", () => {
    const s = snapshot();
    s.project.pitch = "x".repeat(10_000);
    expect(cleanSnapshot(s, clean).project.pitch).toHaveLength(SHARE_TEXT_MAX);
  });

  it("cleans every free-text field: names, pitch, summary, idea, headlines, reasons, details, titles, prompts and hardware", () => {
    const s = enumHeavy();
    const mark = (x: string) => `${x} by alice`;
    s.project.name = mark("Book Club");
    s.project.pitch = mark("Reading lists");
    s.summary = mark("A list app");
    s.idea = mark("Lists");
    s.stack = [{ layer: "Scope", choice: mark("Small"), why: mark("Sooner"), licence: null, evidence: null }];
    s.waiting[0]!.headline = mark("Wants to open");
    s.waiting[0]!.cardTitle = mark("Login");
    s.decisions[0]!.headline = mark("Waived");
    s.readiness[0]!.detail = mark("work left");
    s.readiness[0]!.cardTitle = mark("Login");
    s.digests[0]!.summary = mark("1 entry");
    s.digests[0]!.items[0]!.headline = mark("Created");
    s.asks[0]!.cardTitle = mark("Login");
    s.asks[0]!.prompt = mark("build it");
    s.hardware!.cpu = mark("M1");
    s.hardware!.gpu = mark("GPU");
    const out = cleanSnapshot(s, clean);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/\balice\b/);
    expect(out.project.name).toBe("Book Club by <user>");
    expect(out.hardware!.gpu).toBe("GPU by <user>");
    expect(out.asks[0]!.prompt).toBe("build it by <user>");
  });

  describe.each(WORD_USERNAMES)("with the username %s", (username) => {
    const c = cleanerFor(username);

    it("leaves enums, ids, numbers and fixed labels exactly as they are", () => {
      const s = enumHeavy();
      const out = cleanSnapshot(s, c);
      expect(out.currentStage).toBe("build");
      expect(out.owner).toBe("Owner");
      expect(out.numbers.ci).toBe("open");
      expect(out.workforce[0]!.adapter).toBe("claude");
      expect(out.workforce[0]!.label).toBe("Claude Code");
      expect(out.waiting[0]!.kind).toBe("action");
      expect(out.waiting[0]!.assignee).toBe("Owner");
      expect(out.decisions[0]!.kind).toBe("gate_waiver");
      expect(out.decisions[0]!.by).toBe("Owner");
      expect(out.readiness[0]!.gateId).toBe("ready_to_ship");
      expect(out.readiness[0]!.state).toBe("open");
      expect(out.readiness[0]!.title).toBe("Ready to ship");
      expect(out.digests[0]!.items[0]!.topic).toBe("board");
      expect(out.asks[0]!.adapterLabel).toBe("Claude Code");
      expect(out.hardware!.platform).toBe("darwin");
      expect(out.hidden).toEqual(s.hidden);
      expect(out.options).toEqual(s.options);
      expect(out.audit).toEqual(s.audit);
      expect(out.progress).toEqual(s.progress);
    });

    it("scrubs the username from a free-text field", () => {
      const s = enumHeavy();
      s.project.pitch = `made by ${username} for ${username}'s club`;
      s.decisions[0]!.reason = `${username} said so`;
      const out = cleanSnapshot(s, c);
      expect(out.project.pitch).toBe("made by <user> for <user>'s club");
      expect(out.decisions[0]!.reason).toBe("<user> said so");
    });

    it("lets an empty project's page through, and a project full of its own words too", () => {
      for (const make of [emptyProject, enumHeavy]) {
        const cleaned = cleanSnapshot(make(), c);
        const html = renderShareHtml(cleaned);
        expect(() => assertClean(html, c, cleaned)).not.toThrow();
        expect(html).toContain("<h1>Book Club</h1>");
      }
    });

    it("still refuses a page whose free text holds the username, a secret, an email or a home path", () => {
      const s = emptyProject();
      s.project.pitch = `by ${username}`;
      // Not cleaned: the check must catch it.
      expect(() => assertClean(renderShareHtml(s), c, s)).toThrow(ShareNotCleanError);
      for (const bad of [SECRET, "someone@example.test", `/Users/${username}/notes`]) {
        const t = emptyProject();
        t.project.pitch = bad;
        expect(() => assertClean(renderShareHtml(t), c, t)).toThrow(ShareNotCleanError);
      }
    });
  });
});

describe("assertClean", () => {
  it("throws ShareNotCleanError for a page that still holds a secret, and passes a clean one", () => {
    expect(() => assertClean("<p>sk-ant-TESTKEY-0000000000</p>", clean)).toThrow(ShareNotCleanError);
    expect(() => assertClean("<p>sk-ant-TESTKEY-0000000000</p>", clean)).toThrow("the share page could not be proven clean");
    expect(() => assertClean("<p>Book Club, by the Owner</p>", clean)).not.toThrow();
  });

  it("throws for an email address or a home path in the markup", () => {
    for (const html of ["<p>someone@example.test</p>", "<p>/Users/alice/notes</p>"]) {
      expect(() => assertClean(html, clean)).toThrow(ShareNotCleanError);
    }
  });

  it("checks the username in the snapshot's free text, not in the markup", () => {
    // The template's own words are not content: a username that is one of them does not fail the page.
    expect(() => assertClean("<meta content=\"img-src data:\"><p>Owner · Open · root</p>", cleanerFor("data"))).not.toThrow();
    expect(() => assertClean("<p>by alice</p>", clean)).not.toThrow();
    const s = snapshot();
    s.project.pitch = "by alice";
    expect(() => assertClean("<p>clean markup</p>", clean, s)).toThrow(ShareNotCleanError);
    const cleaned = cleanSnapshot(s, clean);
    expect(() => assertClean("<p>clean markup</p>", clean, cleaned)).not.toThrow();
  });
});
