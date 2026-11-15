import { HIDDEN_BY_DEFAULT, type ShareSnapshot } from "@theterminal/shared";

/**
 * A hand-written share snapshot for a made-up project, `Book Club`: a completed intake for a private,
 * no-payments idea with a budget of $25, five cards with one done, two fake runs (one completed, costing an
 * estimated $0.10), card `Login` moved to Ship under a waiver of `ready_to_ship`, and one action waiting on the
 * Owner. The render tests use it without a database. Each call returns a fresh copy, so a test may change it.
 */
export const WAIVER_EVIDENCE = { seq: 31, hash12: "a1b2c3d4e5f6", at: "2026-11-15T10:20:00.000Z" } as const;

export function bookClubSnapshot(): ShareSnapshot {
  return {
    version: 1,
    generatedAt: "2026-11-15T12:00:00.000Z",
    options: { includePrompts: false, includeHardware: false, digestDays: 7 },
    hidden: [...HIDDEN_BY_DEFAULT],
    project: { name: "Book Club", pitch: "Reading lists for a club, [email]", createdAt: "2026-11-14T09:00:00.000Z" },
    owner: "Owner",
    progress: {
      plan: { total: 1, done: 1 },
      design: { total: 0, done: 0 },
      build: { total: 3, done: 0 },
      ship: { total: 1, done: 0 },
      operate: { total: 0, done: 0 },
    },
    currentStage: "build",
    numbers: {
      cardsTotal: 5,
      cardsDone: 1,
      runsTotal: 2,
      runsCompleted: 1,
      overrides: 0,
      spendUsd: { value: 0.1, basis: "estimate" },
      budgetUsd: 25,
      costPerDayUsd: { value: 0.1, basis: "estimate" },
      decisionsMade: 4,
      decisionsWaiting: 1,
      ci: null,
    },
    summary: "A private reading list app for one book club. No payments.",
    idea: "Reading lists for a club",
    stack: [
      {
        layer: "Scope",
        choice: "The smallest version that works",
        why: "Fewer features, sooner.",
        licence: null,
        evidence: { seq: 8, hash12: "0123456789ab", at: "2026-11-14T09:10:00.000Z" },
      },
      {
        layer: "Agent programs",
        choice: "Fake agent",
        why: "2 runs",
        licence: null,
        evidence: { seq: 20, hash12: "bcdef0123456", at: "2026-11-15T10:00:00.000Z" },
      },
    ],
    workforce: [
      {
        adapter: "fake",
        label: "Fake agent",
        runs: 2,
        completed: 1,
        failed: 0,
        stopped: 0,
        costUsd: { value: 0.1, basis: "estimate" },
        inputTokens: 1200,
        outputTokens: 340,
      },
    ],
    waiting: [
      {
        kind: "action",
        headline: 'A Fake agent wants to run the command "nvidia-smi"',
        since: "2026-11-15T11:00:00.000Z",
        cardTitle: "Search",
        assignee: "Owner",
      },
    ],
    decisions: [
      {
        kind: "gate_waiver",
        headline: 'Owner waived "Ready to ship" for "Login"',
        by: "Owner",
        at: WAIVER_EVIDENCE.at,
        reason: "We are only testing this",
        evidence: { ...WAIVER_EVIDENCE },
      },
      {
        kind: "action",
        headline: 'Owner allowed a Fake agent to run the command "ls"',
        by: "Owner",
        at: "2026-11-15T10:05:00.000Z",
        reason: null,
        evidence: { seq: 24, hash12: "fedcba987654", at: "2026-11-15T10:05:00.000Z" },
      },
    ],
    decisionsOmitted: 2,
    readiness: [
      { gateId: "plan_approved", title: "Plan approved", state: "not_reached", detail: null, cardTitle: null, at: null, evidence: null },
      {
        gateId: "ready_to_ship",
        title: "Ready to ship",
        state: "waived",
        detail: "We are only testing this",
        cardTitle: "Login",
        at: WAIVER_EVIDENCE.at,
        evidence: { ...WAIVER_EVIDENCE },
      },
      {
        gateId: "go_live",
        title: "Going live",
        state: "open",
        detail: "No agent is waiting for a decision in this project",
        cardTitle: "Login",
        at: null,
        evidence: null,
      },
    ],
    digests: [
      {
        day: "2026-11-15",
        summary:
          "12 ledger entries: 2 agent actions requested, 1 allowed and 0 denied by a human, 2 decisions by the Owner, 1 card moved, 2 agent runs started and 1 finished. Agent spend recorded that day: $0.10 (estimate).",
        counts: {
          entries: 12,
          actions: 2,
          allowed: 1,
          denied: 0,
          decisions: 2,
          cardsMoved: 1,
          runsStarted: 2,
          runsFinished: 1,
          spendUsd: 0.1,
        },
        items: [
          { seq: 20, time: "10:00", headline: 'Owner started a Fake agent on "Login"', topic: "agent", attention: false },
          { seq: 31, time: "10:20", headline: 'Owner waived "Ready to ship" for "Login"', topic: "gate", attention: false },
        ],
        more: 0,
      },
    ],
    asks: [],
    history: [{ day: "2026-11-01", entries: 3, actions: 0, decisions: 1, cardsMoved: 0 }],
    hardware: null,
    audit: { ok: true, entries: 40, brokenAtSeq: null, headSeq: 40, headHash12: "9f8e7d6c5b4a" },
  };
}
