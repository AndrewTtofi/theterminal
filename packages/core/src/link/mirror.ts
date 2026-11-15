import type { z } from "zod";
import { MIRRORABLE_TYPES, mirrorFrameSchema, type LedgerEntry, type MirroredOrigin } from "@theterminal/shared";
import { canonicalJson } from "../ledger/canonical.js";
import { verifySignature, type LinkIdentity } from "./identity.js";

/**
 * Mirrored ledger entries: the worker signs each entry of a run it executes; the requester checks every line it
 * receives before anything of it is committed.
 *
 * Everything that arrives in a frame comes from another machine and is untrusted, including what a validly signed
 * frame says: a paired worker can only speak for the run the requester asked it to run, in that run's project, about
 * actions of that run. `checkFrame` enforces all of it; the caller (Task 8) commits the frame's origin byte for byte as
 * `link.mirrored` only when it answers `ok`.
 *
 * Redaction: the worker cleans everything it records, as every local run does. The requester must not change a
 * mirrored origin (the signature covers it), so it cleans at display time instead: `displayOrigin(origin, clean)` is
 * the hook, to be called with the requester's own cleaner wherever mirrored text is shown or exported.
 */

export type MirrorFrame = z.infer<typeof mirrorFrameSchema>;

/** The most bytes one NDJSON line (one frame) may hold. The worker's largest legitimate frame is well under this. */
export const MAX_FRAME_BYTES = 262_144;
/** The most nested a frame may be, so no recursive walk over it can exhaust the stack. */
export const MAX_FRAME_DEPTH = 64;
/** The runner's cap on a recorded action input, as JSON characters (`MAX.input` in agents/runner.ts). */
export const MAX_MIRRORED_INPUT_CHARS = 20_000;

/** Why a frame was refused. Task 8 records it as `link_runs.error` and closes the stream. */
export type FrameRefusal =
  | "too_large"
  | "invalid_frame"
  | "not_mirrorable"
  | "invalid_payload"
  | "bad_signature"
  | "wrong_run"
  | "wrong_project"
  | "out_of_order"
  | "duplicate"
  | "foreign_action";

export class MirrorFrameError extends Error {
  constructor(readonly reason: FrameRefusal) {
    super(`the mirrored frame was refused: ${reason}`);
    this.name = "MirrorFrameError";
  }
}

const LISTED: ReadonlySet<string> = new Set(MIRRORABLE_TYPES);
const ACTION_TYPES: ReadonlySet<string> = new Set(["agent.action.requested", "agent.action.decided", "agent.action.completed"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Whether `value` nests deeper than `max`, or holds an object with an own `__proto__` key, walked without recursion.
 * JSON.parse makes `__proto__` an own key, but the canonical encoding leaves it out of the signed bytes, so a frame
 * carrying one would store bytes its signature does not cover. `constructor` and `prototype` encode faithfully and stay.
 */
function unsafeShape(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (typeof v !== "object" || v === null) continue;
    if (depth > max) return true;
    if (!Array.isArray(v) && Object.hasOwn(v, "__proto__")) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, depth + 1]);
  }
  return false;
}

/** The first problem with a frame's shape and bounds, before its signature is looked at; null when there is none. */
function shapeProblem(raw: unknown): { problem: FrameRefusal } | { frame: MirrorFrame } {
  if (!isRecord(raw)) return { problem: "invalid_frame" };
  if (unsafeShape(raw, MAX_FRAME_DEPTH)) return { problem: "invalid_payload" };
  const origin = raw.origin;
  if (isRecord(origin) && typeof origin.type === "string" && !LISTED.has(origin.type)) return { problem: "not_mirrorable" };
  let parsed;
  try {
    parsed = mirrorFrameSchema.safeParse(raw);
  } catch {
    return { problem: "invalid_payload" };
  }
  if (!parsed.success) return { problem: "invalid_payload" };
  const frame = parsed.data;
  if (frame.origin.type === "agent.action.requested") {
    const input = (frame.origin.payload as { input: unknown }).input;
    if (JSON.stringify(input).length > MAX_MIRRORED_INPUT_CHARS) return { problem: "invalid_payload" };
  }
  return { frame };
}

function originOf(entry: LedgerEntry): MirroredOrigin {
  const { seq, id, ts, projectId, actor, type, payload, prevHash, hash } = entry;
  return { seq, id, ts, projectId, actor: { kind: actor.kind, id: actor.id }, type, payload, prevHash, hash } as MirroredOrigin;
}

/**
 * Signs a ledger entry of this machine for the requester: origin = the entry's nine fields, signature = Ed25519 over
 * their canonical JSON. Throws `MirrorFrameError` for an entry the requester would refuse (an unlisted type, a payload
 * outside the schema or its bounds, a frame over `MAX_FRAME_BYTES`), so the worker never sends one.
 */
export function signFrame(identity: LinkIdentity, entry: LedgerEntry): MirrorFrame {
  const origin = originOf(entry);
  const frame = { origin, signature: identity.sign(Buffer.from(canonicalJson(origin))) };
  const shape = shapeProblem(frame);
  if ("problem" in shape) throw new MirrorFrameError(shape.problem);
  if (Buffer.byteLength(JSON.stringify(frame), "utf8") > MAX_FRAME_BYTES) throw new MirrorFrameError("too_large");
  return frame;
}

/** Whether the frame's signature is the key's over the canonical JSON of its origin; false on any error. */
export function verifyFrame(publicKeyDer: Buffer, frame: MirrorFrame): boolean {
  try {
    return verifySignature(publicKeyDer, Buffer.from(canonicalJson(frame.origin)), frame.signature);
  } catch {
    return false;
  }
}

/** Whether the worker sends this entry on the stream of `runId`: a listed type whose payload names the run. */
export function mirrorable(entry: LedgerEntry, runId: string): boolean {
  return LISTED.has(entry.type) && isRecord(entry.payload) && entry.payload.runId === runId;
}

/** What the requester knows about the stream a line arrived on, all from its own records. */
export type FrameExpectation = {
  /** The pinned key of the machine the run was sent to (from `machines`, through `link_runs.machine_id`). */
  publicKeyDer: Buffer;
  /** The run this stream is for. */
  runId: string;
  /** The run's project on the requester. */
  projectId: string;
  /** The worker seq of the last committed frame (`link_runs.last_seq`); a frame must come after it. */
  lastSeq: number;
  /** Whether an origin id was already mirrored for this run (Task 8's `mirroredIds`). */
  seen: (originId: string) => boolean;
  /** The run an action id belongs to on the requester, or null when there is no such action. */
  actionRunOf: (actionId: string) => string | null;
};

export type FrameCheck = { ok: true; frame: MirrorFrame } | { ok: false; reason: FrameRefusal };

/**
 * The requester's gate for one untrusted line of the stream. In order: the byte cap, JSON, the type list, the
 * worker-side schema and bounds, the signature with the pinned key (before any field is trusted), then the run,
 * project, cursor, duplicate and action-ownership checks. Never throws.
 *
 * Action ownership: the requester's projection decides and completes actions by id alone, so a frame may only touch
 * an action that its own run requested, and may request only an id that does not exist yet. Frames are checked and
 * committed one at a time, so `actionRunOf` sees the run's earlier requests.
 */
export function checkFrame(line: string, expect: FrameExpectation): FrameCheck {
  try {
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) return { ok: false, reason: "too_large" };
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return { ok: false, reason: "invalid_frame" };
    }
    const shape = shapeProblem(raw);
    if ("problem" in shape) return { ok: false, reason: shape.problem };
    const { frame } = shape;
    if (!verifyFrame(expect.publicKeyDer, frame)) return { ok: false, reason: "bad_signature" };

    const { origin } = frame;
    const payload = origin.payload as { runId: string; actionId?: string };
    if (payload.runId !== expect.runId) return { ok: false, reason: "wrong_run" };
    // A worker records connection.used without a project, as every machine does; every agent.* entry has the run's.
    const projectOk = origin.projectId === expect.projectId || (origin.type === "connection.used" && origin.projectId === null);
    if (!projectOk) return { ok: false, reason: "wrong_project" };
    if (origin.seq <= expect.lastSeq) return { ok: false, reason: "out_of_order" };
    if (expect.seen(origin.id)) return { ok: false, reason: "duplicate" };

    if (ACTION_TYPES.has(origin.type)) {
      const owner = expect.actionRunOf(payload.actionId!);
      if (owner !== null && owner !== expect.runId) return { ok: false, reason: "foreign_action" };
      if (origin.type === "agent.action.requested" && owner !== null) return { ok: false, reason: "duplicate" };
      if (origin.type !== "agent.action.requested" && owner === null) return { ok: false, reason: "foreign_action" };
    }
    return { ok: true, frame };
  } catch {
    return { ok: false, reason: "invalid_frame" };
  }
}

/**
 * Splits a byte stream into NDJSON lines, refusing a line over `MAX_FRAME_BYTES` as soon as it passes the cap, without
 * waiting for its newline. Lines are decoded as strict UTF-8; blank lines are skipped and a trailing CR is dropped.
 * After a throw the stream must be closed: the splitter's state is no longer meaningful.
 */
export class NdjsonLines {
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });

  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let rest = chunk;
    for (let nl = rest.indexOf(0x0a); nl !== -1; nl = rest.indexOf(0x0a)) {
      const bytes = Buffer.concat([...this.#pending, rest.subarray(0, nl)]);
      this.#pending = [];
      this.#pendingBytes = 0;
      rest = rest.subarray(nl + 1);
      const line = this.#decode(bytes);
      if (line.trim() !== "") lines.push(line);
    }
    if (rest.length > 0) {
      this.#pending.push(Buffer.from(rest));
      this.#pendingBytes += rest.length;
      if (this.#pendingBytes > MAX_FRAME_BYTES) throw new MirrorFrameError("too_large");
    }
    return lines;
  }

  /** The stream ended; a partial line is refused. */
  end(): void {
    const left = Buffer.concat(this.#pending);
    this.#pending = [];
    this.#pendingBytes = 0;
    if (left.toString("latin1").trim() !== "") throw new MirrorFrameError("invalid_frame");
  }

  #decode(bytes: Buffer): string {
    const body = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.subarray(0, -1) : bytes;
    if (body.length > MAX_FRAME_BYTES) throw new MirrorFrameError("too_large");
    try {
      return this.#decoder.decode(body);
    } catch {
      throw new MirrorFrameError("invalid_frame");
    }
  }
}

/**
 * A copy of a mirrored origin for display, with every string of its payload passed through `clean` (the requester's
 * own redaction). Never commit or verify the result: the signed origin stays exactly as the worker sent it.
 */
export function displayOrigin(origin: MirroredOrigin, clean: (s: string) => string): MirroredOrigin {
  return { ...origin, actor: { ...origin.actor }, payload: cleanStrings(origin.payload, clean) };
}

function cleanStrings(value: unknown, clean: (s: string) => string): unknown {
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return value.map((v) => cleanStrings(v, clean));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) Object.defineProperty(out, k, { value: cleanStrings(v, clean), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return value;
}
