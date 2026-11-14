/**
 * Tracks the ACP tool calls Gemini reports and decides whether each one ran under our gate.
 *
 * A call is gated in one of two ways: we answered a `session/request_permission` for it, or the agent
 * performed it through one of our client `fs`/`terminal` methods (which are gated on their own). Gemini
 * runs its tool calls one at a time, so a client request arriving while exactly one call is in progress
 * belongs to that call; a path that matches the call's locations settles any doubt. When several
 * ungated calls are in flight and the path matches none of them, nothing is attributed and the calls
 * are reported as ungated when they finish (fail closed).
 */
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type TrackedCall = {
  id: string;
  kind: string | null;
  status: ToolStatus;
  title: string;
  locations: string[];
  /** How the call came under the gate; null until it does. */
  gated: "permission" | "mediated" | null;
  /** The allowed action id of its permission request, when there is one. */
  actionId: string | null;
  /** The call was reported in progress at some point, i.e. it did run. */
  ran: boolean;
};

export type ToolCallUpdate = { toolCallId: string; kind?: string | null; status?: ToolStatus | null; title?: string | null; locations?: string[] | null };

export type TrackerEvent =
  | { type: "ungated"; call: TrackedCall }
  | { type: "result"; actionId: string; ok: boolean }
  | null;

/** A call of one of these kinds may still be performed through the client fs methods after it starts. */
const CLIENT_MEDIATED_KINDS = new Set(["read", "edit"]);
const MAX_TRACKED = 1000;

export class ToolCallTracker {
  private readonly calls = new Map<string, TrackedCall>();

  constructor(private readonly samePath: (a: string, b: string) => boolean) {}

  /** Records that we answered a permission request for `u`; `actionId` is set when it was allowed. */
  permission(u: ToolCallUpdate, actionId: string | null): void {
    const call = this.upsert(u);
    call.gated = "permission";
    call.actionId = actionId;
  }

  /** Attributes a client fs/terminal request, for `path` when it has one, to the one in-flight ungated call it can belong to. */
  mediate(path?: string): void {
    const running = [...this.calls.values()].filter((c) => c.gated === null && c.status === "in_progress");
    const byPath = path === undefined ? [] : running.filter((c) => c.locations.some((l) => this.samePath(l, path)));
    const match = byPath.length === 1 ? byPath[0] : byPath.length === 0 && running.length === 1 ? running[0] : undefined;
    if (match) match.gated = "mediated";
  }

  /**
   * Applies a `tool_call` or `tool_call_update` and says what it means: an ungated execution, the result
   * of a call we allowed through a permission request, or nothing. Throws when too many calls are open.
   */
  update(u: ToolCallUpdate): TrackerEvent {
    if (!this.calls.has(u.toolCallId) && u.status === "failed") return null; // failed before it started (validation, cancel): it did not run
    const call = this.upsert(u);
    if (call.status === "in_progress") {
      call.ran = true;
      // Only a read or edit can still be routed through our fs methods; anything else running ungated is already out of our hands.
      if (call.gated === null && !CLIENT_MEDIATED_KINDS.has(call.kind ?? "")) return this.ungated(call);
      return null;
    }
    if (call.status !== "completed" && call.status !== "failed") return null;
    this.calls.delete(call.id);
    if (call.gated === null) {
      if (call.status === "completed" || call.ran) return { type: "ungated", call };
      return null; // pending, then failed: never ran
    }
    if (call.gated === "permission" && call.actionId !== null) return { type: "result", actionId: call.actionId, ok: call.status === "completed" };
    return null;
  }

  private ungated(call: TrackedCall): TrackerEvent {
    this.calls.delete(call.id);
    return { type: "ungated", call };
  }

  private upsert(u: ToolCallUpdate): TrackedCall {
    let call = this.calls.get(u.toolCallId);
    if (!call) {
      if (this.calls.size >= MAX_TRACKED) throw new Error("too many open tool calls");
      call = { id: u.toolCallId, kind: null, status: "pending", title: "", locations: [], gated: null, actionId: null, ran: false };
      this.calls.set(call.id, call);
    }
    if (typeof u.kind === "string") call.kind = u.kind;
    if (typeof u.status === "string") call.status = u.status;
    if (typeof u.title === "string") call.title = u.title;
    if (Array.isArray(u.locations)) call.locations = u.locations;
    return call;
  }
}
