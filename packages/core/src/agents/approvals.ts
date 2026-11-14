import { NotFoundError } from "../board/board-service.js";
import type { GateResult } from "./adapter.js";

export class AlreadyDecidedError extends Error {
  constructor(actionId: string) {
    super(`action already decided: ${actionId}`);
    this.name = "AlreadyDecidedError";
  }
}

const RUN_STOPPED: GateResult = { decision: "deny", reason: "run stopped" };
const REMEMBERED_DECISIONS = 1000;

/** In-memory rendezvous between a gated action and the human decision on it. */
export class ApprovalBroker {
  private readonly waiting = new Map<string, (r: GateResult) => void>();
  private readonly settled = new Set<string>();

  wait(actionId: string, signal: AbortSignal): Promise<GateResult> {
    if (this.waiting.has(actionId) || this.settled.has(actionId)) {
      return Promise.reject(new AlreadyDecidedError(actionId));
    }
    if (signal.aborted) {
      this.remember(actionId);
      return Promise.resolve(RUN_STOPPED);
    }
    return new Promise((resolve) => {
      const onAbort = () => settle(RUN_STOPPED);
      const settle = (r: GateResult) => {
        signal.removeEventListener("abort", onAbort);
        this.waiting.delete(actionId);
        this.remember(actionId);
        resolve(r);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting.set(actionId, settle);
    });
  }

  decide(actionId: string, decision: "allow" | "deny", reason: string): void {
    const settle = this.waiting.get(actionId);
    if (!settle) {
      if (this.settled.has(actionId)) throw new AlreadyDecidedError(actionId);
      throw new NotFoundError("action", actionId);
    }
    settle({ decision, reason });
  }

  pendingIds(): string[] {
    return [...this.waiting.keys()];
  }

  private remember(actionId: string): void {
    this.settled.add(actionId);
    if (this.settled.size > REMEMBERED_DECISIONS) this.settled.delete(this.settled.values().next().value!);
  }
}
