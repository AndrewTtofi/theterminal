import { describe, it, expect, beforeEach } from "vitest";
import { MIRRORABLE_TYPES, type LedgerEntry, type NewLedgerEntry } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { commitEvent } from "../../src/events/commit.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { LinkIdentity } from "../../src/link/identity.js";
import { canonicalJson } from "../../src/ledger/canonical.js";
import {
  MAX_FRAME_BYTES, MAX_MIRRORED_INPUT_CHARS, MirrorFrameError, NdjsonLines, checkFrame, displayOrigin, mirrorable, signFrame,
  verifyFrame, type FrameExpectation, type MirrorFrame,
} from "../../src/link/mirror.js";

const RUN = "run-remote-1";
const PROJECT = "proj-1";
const agent = { kind: "agent", id: RUN } as const;
const owner = { kind: "human", id: "owner" } as const;

const PAYLOADS: Record<(typeof MIRRORABLE_TYPES)[number], (runId: string) => unknown> = {
  "agent.started": (runId) => ({
    runId, adapter: "fake", authMode: "none", prompt: "Fix the tests", cardId: null, worktree: `projects/${PROJECT}/worktrees/${runId}`,
  }),
  "agent.message": (runId) => ({ runId, text: "Looking at the tests" }),
  "agent.progress": (runId) => ({ runId, steps: ["Read the tests", "Fix them"], done: [1], current: 2 }),
  "agent.action.requested": (runId) => ({
    runId, actionId: `${runId}-a1`, kind: "shell", tool: "shell", summary: "npm test", input: { command: "npm test" },
  }),
  "agent.action.decided": (runId) => ({ runId, actionId: `${runId}-a1`, decision: "allow", by: "human", reason: "" }),
  "agent.action.completed": (runId) => ({ runId, actionId: `${runId}-a1`, ok: true, output: "ok" }),
  "agent.finished": (runId) => ({ runId, status: "completed", costUsd: null, error: null }),
  "agent.rate_limited": (runId) => ({ runId, retryAfterS: 30 }),
  "connection.used": (runId) => ({ connectionId: "c1", name: "Work key", runId, purpose: "api_key" }),
};

let db: Db;
let ledger: Ledger;
let worker: LinkIdentity;
let other: LinkIdentity;

function record(event: NewLedgerEntry): LedgerEntry {
  // The projections are not under test; the entries are real ledger entries, hashed and chained.
  return commitEvent(db, ledger, () => ({ event, result: (e) => e! }), () => {});
}

function entryOf(type: (typeof MIRRORABLE_TYPES)[number], runId = RUN, extra: Partial<NewLedgerEntry> = {}): LedgerEntry {
  const projectId = type === "connection.used" ? null : PROJECT;
  const actor = type === "agent.action.decided" ? owner : type === "connection.used" ? owner : agent;
  return record({ projectId, actor, type, payload: PAYLOADS[type](runId), ...extra });
}

function expectation(over: Partial<FrameExpectation> = {}): FrameExpectation {
  return {
    publicKeyDer: worker.publicKeyDer,
    runId: RUN,
    projectId: PROJECT,
    cardId: null,
    lastSeq: 0,
    seen: () => false,
    actionRunOf: () => null,
    ...over,
  };
}

function line(frame: unknown): string {
  return JSON.stringify(frame);
}

beforeEach(async () => {
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  worker = await LinkIdentity.load({ secrets: new MemorySecretStore(), onCreated: () => {} });
  other = await LinkIdentity.load({ secrets: new MemorySecretStore(), onCreated: () => {} });
});

describe("signFrame and verifyFrame", () => {
  it("signs the entry's nine fields; the frame verifies with the worker's key only", () => {
    const entry = entryOf("agent.action.requested");
    const frame = signFrame(worker, entry);
    expect(Object.keys(frame).sort()).toEqual(["origin", "signature"]);
    expect(frame.origin).toEqual({
      seq: entry.seq, id: entry.id, ts: entry.ts, projectId: entry.projectId, actor: entry.actor, type: entry.type,
      payload: entry.payload, prevHash: entry.prevHash, hash: entry.hash,
    });
    expect(frame.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyFrame(worker.publicKeyDer, frame)).toBe(true);
    expect(verifyFrame(other.publicKeyDer, frame)).toBe(false);
  });

  it("does not verify after any change to the origin", () => {
    const frame = signFrame(worker, entryOf("agent.action.requested"));
    const changedPayload = structuredClone(frame);
    (changedPayload.origin.payload as { input: unknown }).input = { command: "rm -rf /" };
    expect(verifyFrame(worker.publicKeyDer, changedPayload)).toBe(false);
    const changedActor = structuredClone(frame);
    changedActor.origin.actor = { kind: "human", id: "owner" };
    expect(verifyFrame(worker.publicKeyDer, changedActor)).toBe(false);
    const changedSeq = structuredClone(frame);
    changedSeq.origin.seq += 1;
    expect(verifyFrame(worker.publicKeyDer, changedSeq)).toBe(false);
  });

  it("verifies a frame that crossed the wire as JSON, whatever the key order", () => {
    const frame = signFrame(worker, entryOf("agent.started"));
    const wire = JSON.parse(line(frame)) as MirrorFrame;
    expect(verifyFrame(worker.publicKeyDer, wire)).toBe(true);
    const reordered = { signature: wire.signature, origin: Object.fromEntries(Object.entries(wire.origin).reverse()) } as MirrorFrame;
    expect(verifyFrame(worker.publicKeyDer, reordered)).toBe(true);
  });

  it("is false, never a throw, for a malformed key, signature or origin", () => {
    const frame = signFrame(worker, entryOf("agent.message"));
    expect(verifyFrame(Buffer.from("not a key"), frame)).toBe(false);
    expect(verifyFrame(worker.publicKeyDer, { ...frame, signature: "zz" })).toBe(false);
    const cyclic = structuredClone(frame);
    (cyclic.origin as { payload: unknown }).payload = { big: 10n };
    expect(verifyFrame(worker.publicKeyDer, cyclic)).toBe(false);
  });

  it("does not sign an entry that is not a valid mirrored origin", () => {
    const card = record({ projectId: PROJECT, actor: owner, type: "card.created", payload: { cardId: "c1", title: "T", stage: "plan" } });
    expect(() => signFrame(worker, card)).toThrow(MirrorFrameError);
    try {
      signFrame(worker, card);
    } catch (err) {
      expect((err as MirrorFrameError).reason).toBe("not_mirrorable");
    }
  });

  it("does not sign an entry whose frame would exceed the frame cap", () => {
    const entry = entryOf("agent.action.requested");
    const huge = { ...entry, payload: { ...(entry.payload as object), input: { blob: "x".repeat(MAX_FRAME_BYTES) } } };
    expect(() => signFrame(worker, huge)).toThrow(MirrorFrameError);
  });
});

describe("mirrorable", () => {
  it("is true for every listed type that names the run", () => {
    for (const type of MIRRORABLE_TYPES) expect(mirrorable(entryOf(type), RUN), type).toBe(true);
  });

  it("is false for another run's entries and for unlisted types", () => {
    for (const type of MIRRORABLE_TYPES) expect(mirrorable(entryOf(type, "run-other"), RUN), type).toBe(false);
    const moved = record({ projectId: PROJECT, actor: owner, type: "card.moved", payload: { cardId: "c1", from: "plan", to: "design" } });
    expect(mirrorable(moved, RUN)).toBe(false);
    // Even with the run's id in it, an unlisted type is not mirrorable.
    expect(mirrorable({ ...moved, payload: { ...(moved.payload as object), runId: RUN } }, RUN)).toBe(false);
    const decision = record({
      projectId: PROJECT, actor: owner, type: "link.decision_received",
      payload: { runId: RUN, actionId: "a1", machineId: "0".repeat(32), decision: "allow" },
    });
    expect(mirrorable(decision, RUN)).toBe(false);
  });

  it("is false for a payload that is not an object", () => {
    const e = entryOf("agent.message");
    expect(mirrorable({ ...e, payload: null }, RUN)).toBe(false);
    expect(mirrorable({ ...e, payload: RUN }, RUN)).toBe(false);
  });
});

describe("checkFrame (the requester's gate for an untrusted line)", () => {
  it("accepts a good frame and returns exactly what the worker signed", () => {
    const frame = signFrame(worker, entryOf("agent.action.requested"));
    const result = checkFrame(line(frame), expectation());
    expect(result).toEqual({ ok: true, frame });
  });

  it("accepts an agent.progress frame, and refuses one that breaks the progress schema", () => {
    const entry = entryOf("agent.progress");
    const frame = signFrame(worker, entry);
    expect(checkFrame(line(frame), expectation())).toEqual({ ok: true, frame });
    const origin = { ...frame.origin, payload: { runId: RUN, steps: ["a"], done: [2], current: null } };
    const forged = { origin, signature: worker.sign(Buffer.from(canonicalJson(origin))) };
    expect(checkFrame(line(forged), expectation())).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("accepts a connection.used frame with a null project", () => {
    const frame = signFrame(worker, entryOf("connection.used"));
    expect(checkFrame(line(frame), expectation()).ok).toBe(true);
  });

  it("refuses an agent.started whose working copy is not the run's own, or whose card is not the one requested", () => {
    const start = PAYLOADS["agent.started"](RUN) as Record<string, unknown>;
    const startedWith = (over: Record<string, unknown>) => signFrame(worker, entryOf("agent.started", RUN, { payload: { ...start, ...over } }));
    for (const worktree of [".", "projects/another/repo", "link/incoming", `projects/${PROJECT}/worktrees/other-run`, `Projects/${PROJECT}/worktrees/${RUN}`]) {
      expect(checkFrame(line(startedWith({ worktree })), expectation())).toEqual({ ok: false, reason: "wrong_worktree" });
    }
    expect(checkFrame(line(startedWith({ cardId: "c-foreign" })), expectation())).toEqual({ ok: false, reason: "wrong_card" });
    expect(checkFrame(line(startedWith({ cardId: null })), expectation({ cardId: "c1" }))).toEqual({ ok: false, reason: "wrong_card" });
    expect(checkFrame(line(startedWith({ cardId: "c1" })), expectation({ cardId: "c1" })).ok).toBe(true);
    expect(checkFrame(line(startedWith({})), expectation()).ok).toBe(true);
  });

  it("refuses a line over the frame cap before parsing it", () => {
    expect(checkFrame(" ".repeat(MAX_FRAME_BYTES + 1), expectation())).toEqual({ ok: false, reason: "too_large" });
    // Counted in bytes, not characters.
    expect(checkFrame("é".repeat(MAX_FRAME_BYTES / 2 + 1), expectation())).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses a line that is not a JSON object, or is nested past any reason", () => {
    expect(checkFrame("not json", expectation())).toEqual({ ok: false, reason: "invalid_frame" });
    expect(checkFrame("[]", expectation())).toEqual({ ok: false, reason: "invalid_frame" });
    expect(checkFrame("null", expectation())).toEqual({ ok: false, reason: "invalid_frame" });
    const deep = "[".repeat(100_000) + "]".repeat(100_000);
    expect(checkFrame(`{"origin":${deep},"signature":"x"}`, expectation())).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("signs and accepts an input with an own __proto__ key: the canonical encoding keeps it, so the signature covers it", () => {
    const entry = entryOf("agent.action.requested");
    const input = JSON.parse('{"__proto__":{"x":1},"command":"ls","deep":[{"__proto__":null}]}') as unknown;
    expect(Object.hasOwn(input as object, "__proto__")).toBe(true);
    // The worker's own entry, as its runner would record an agent's tool input.
    const frame = signFrame(worker, { ...entry, payload: { ...(entry.payload as object), input } });
    const wire = line(frame);
    expect(wire).toContain('"__proto__":{"x":1}');
    expect(canonicalJson(frame.origin)).toContain('"__proto__":{"x":1}');
    expect(checkFrame(wire, expectation())).toMatchObject({ ok: true });
    // The key stays an own key of the parsed frame, never a prototype: nothing is polluted.
    const parsed = JSON.parse(wire) as { origin: { payload: { input: Record<string, unknown> } } };
    expect(Object.hasOwn(parsed.origin.payload.input, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    // Changing the value under that key breaks the signature, as any other change would.
    expect(checkFrame(wire.replace('"__proto__":{"x":1}', '"__proto__":{"x":2}'), expectation())).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("accepts constructor and prototype as ordinary keys of an input", () => {
    const entry = entryOf("agent.action.requested");
    const input = JSON.parse('{"constructor":"x","prototype":{"a":1},"command":"ls"}') as unknown;
    const frame = signFrame(worker, { ...entry, payload: { ...(entry.payload as object), input } });
    expect(checkFrame(line(frame), expectation()).ok).toBe(true);
  });

  it("refuses an unlisted type as not_mirrorable, even when it is signed by the worker", () => {
    const moved = record({ projectId: PROJECT, actor: owner, type: "card.moved", payload: { cardId: "c1", from: "plan", to: "design" } });
    const origin = { ...moved, payload: { ...(moved.payload as object), runId: RUN } };
    const forged = { origin, signature: worker.sign(Buffer.from(canonicalJson(origin))) };
    expect(checkFrame(line(forged), expectation())).toEqual({ ok: false, reason: "not_mirrorable" });
  });

  it("refuses a payload that fails the worker-side schema, signed or not", () => {
    const entry = entryOf("agent.message");
    const long = { ...entry, payload: { runId: RUN, text: "x".repeat(4001) } };
    const origin = {
      seq: long.seq, id: long.id, ts: long.ts, projectId: long.projectId, actor: long.actor, type: long.type,
      payload: long.payload, prevHash: long.prevHash, hash: long.hash,
    };
    const frame = { origin, signature: "0".repeat(128) };
    expect(checkFrame(line(frame), expectation())).toEqual({ ok: false, reason: "invalid_payload" });
    const extraField = { ...signFrame(worker, entry), extra: 1 };
    expect(checkFrame(line(extraField), expectation())).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("refuses an action input longer than the worker's own cap", () => {
    const entry = entryOf("agent.action.requested");
    const big = { ...entry, payload: { ...(entry.payload as object), input: { blob: "x".repeat(MAX_MIRRORED_INPUT_CHARS) } } };
    const origin = { ...big };
    const frame = { origin, signature: worker.sign(Buffer.from("anything")) };
    expect(checkFrame(line(frame), expectation())).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("refuses a frame signed by another machine's key", () => {
    const frame = signFrame(other, entryOf("agent.message"));
    expect(checkFrame(line(frame), expectation())).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a frame changed after signing", () => {
    const frame = signFrame(worker, entryOf("agent.message"));
    (frame.origin.payload as { text: string }).text = "changed";
    expect(checkFrame(line(frame), expectation())).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a validly signed frame for a run the stream is not for", () => {
    const frame = signFrame(worker, entryOf("agent.message", "run-other"));
    expect(checkFrame(line(frame), expectation())).toEqual({ ok: false, reason: "wrong_run" });
  });

  it("refuses a validly signed frame for the run but another project", () => {
    const frame = signFrame(worker, entryOf("agent.message", RUN, { projectId: "proj-elsewhere" }));
    expect(checkFrame(line(frame), expectation())).toEqual({ ok: false, reason: "wrong_project" });
    const nulled = signFrame(worker, entryOf("agent.started", RUN, { projectId: null }));
    expect(checkFrame(line(nulled), expectation())).toEqual({ ok: false, reason: "wrong_project" });
  });

  it("refuses an action that belongs to another run, so no local action can be decided or completed by a worker", () => {
    const owners = new Map([[`${RUN}-a1`, "run-local"]]);
    const actionRunOf = (id: string) => owners.get(id) ?? null;
    for (const type of ["agent.action.requested", "agent.action.decided", "agent.action.completed"] as const) {
      const frame = signFrame(worker, entryOf(type));
      expect(checkFrame(line(frame), expectation({ actionRunOf })), type).toEqual({ ok: false, reason: "foreign_action" });
    }
  });

  it("refuses a decision or completion for an action the run never requested", () => {
    for (const type of ["agent.action.decided", "agent.action.completed"] as const) {
      const frame = signFrame(worker, entryOf(type));
      expect(checkFrame(line(frame), expectation()), type).toEqual({ ok: false, reason: "foreign_action" });
    }
    const own = (id: string) => (id === `${RUN}-a1` ? RUN : null);
    expect(checkFrame(line(signFrame(worker, entryOf("agent.action.decided"))), expectation({ actionRunOf: own })).ok).toBe(true);
  });

  it("refuses a second request for an action id that already exists for the run", () => {
    const own = (id: string) => (id === `${RUN}-a1` ? RUN : null);
    const frame = signFrame(worker, entryOf("agent.action.requested"));
    expect(checkFrame(line(frame), expectation({ actionRunOf: own }))).toEqual({ ok: false, reason: "duplicate" });
  });

  it("refuses an origin id already mirrored, and a seq at or below the cursor", () => {
    const entry = entryOf("agent.message");
    const frame = signFrame(worker, entry);
    expect(checkFrame(line(frame), expectation({ seen: (id) => id === entry.id }))).toEqual({ ok: false, reason: "duplicate" });
    expect(checkFrame(line(frame), expectation({ lastSeq: entry.seq }))).toEqual({ ok: false, reason: "out_of_order" });
    expect(checkFrame(line(frame), expectation({ lastSeq: entry.seq - 1 })).ok).toBe(true);
  });

  it("checks the signature before trusting any field it carries", () => {
    // Another machine's frame naming another run is a bad signature, not a wrong run.
    const frame = signFrame(other, entryOf("agent.message", "run-other"));
    expect(checkFrame(line(frame), expectation())).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("NdjsonLines", () => {
  it("splits chunks into lines, across chunk and multi-byte boundaries", () => {
    const lines = new NdjsonLines();
    const text = Buffer.from('{"a":"é"}\n{"b":2}\n{"c"');
    const cut = text.indexOf(0xc3) + 1; // inside the two bytes of é
    expect([...lines.push(text.subarray(0, cut))]).toEqual([]);
    expect([...lines.push(text.subarray(cut))]).toEqual(['{"a":"é"}', '{"b":2}']);
    expect([...lines.push(Buffer.from(':3}\r\n\n'))]).toEqual(['{"c":3}']);
    expect(() => lines.end()).not.toThrow();
  });

  it("throws too_large as soon as a pending line passes the cap, without waiting for its newline", () => {
    const lines = new NdjsonLines();
    expect([...lines.push(Buffer.alloc(MAX_FRAME_BYTES, 0x20))]).toEqual([]);
    expect(() => [...lines.push(Buffer.from(" "))]).toThrow(expect.objectContaining({ reason: "too_large" }));
  });

  it("throws too_large for a complete line over the cap inside one chunk", () => {
    const lines = new NdjsonLines();
    const chunk = Buffer.concat([Buffer.alloc(MAX_FRAME_BYTES + 1, 0x20), Buffer.from("\n")]);
    expect(() => [...lines.push(chunk)]).toThrow(expect.objectContaining({ reason: "too_large" }));
  });

  it("throws invalid_frame for bytes that are not UTF-8, and for a stream cut mid-line", () => {
    expect(() => [...new NdjsonLines().push(Buffer.from([0xff, 0x0a]))]).toThrow(expect.objectContaining({ reason: "invalid_frame" }));
    const lines = new NdjsonLines();
    expect([...lines.push(Buffer.from('{"a":1'))]).toEqual([]);
    expect(() => lines.end()).toThrow(expect.objectContaining({ reason: "invalid_frame" }));
  });

  it("hands over the lines before a refused one in the same chunk, and refuses only when it reaches it", () => {
    // One TCP chunk may carry several of the worker's writes: the good lines before the bad one are not lost.
    const bad = new NdjsonLines().push(Buffer.concat([Buffer.from('{"a":1}\n'), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from('{"b":2}\n')]));
    expect(bad.next()).toEqual({ value: '{"a":1}', done: false });
    expect(() => bad.next()).toThrow(expect.objectContaining({ reason: "invalid_frame" }));

    const long = new NdjsonLines().push(Buffer.concat([Buffer.from('{"a":1}\n'), Buffer.alloc(MAX_FRAME_BYTES + 1, 0x20)]));
    expect(long.next()).toEqual({ value: '{"a":1}', done: false });
    expect(() => long.next()).toThrow(expect.objectContaining({ reason: "too_large" }));
  });
});

describe("displayOrigin (the requester's redaction hook)", () => {
  it("passes every string in the inner payload through the cleaner, leaving the signed origin untouched", () => {
    const frame = signFrame(worker, entryOf("agent.action.requested"));
    const before = structuredClone(frame);
    const shown = displayOrigin(frame.origin, (s) => s.replace("npm", "[REDACTED]"));
    expect(shown.payload).toMatchObject({ summary: "[REDACTED] test", input: { command: "[REDACTED] test" } });
    expect(shown.id).toBe(frame.origin.id);
    expect(frame).toEqual(before);
    expect(verifyFrame(worker.publicKeyDer, frame)).toBe(true);
  });
});
