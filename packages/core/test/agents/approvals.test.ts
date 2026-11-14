import { describe, expect, it } from "vitest";
import { AlreadyDecidedError, ApprovalBroker } from "../../src/agents/approvals.js";
import { NotFoundError } from "../../src/board/board-service.js";

describe("ApprovalBroker", () => {
  it("decide resolves the wait", async () => {
    const b = new ApprovalBroker();
    const p = b.wait("a1", new AbortController().signal);
    expect(b.pendingIds()).toEqual(["a1"]);
    b.decide("a1", "allow", "looks fine");
    await expect(p).resolves.toEqual({ decision: "allow", reason: "looks fine" });
    expect(b.pendingIds()).toEqual([]);
  });

  it("a second decide throws AlreadyDecidedError", async () => {
    const b = new ApprovalBroker();
    const p = b.wait("a1", new AbortController().signal);
    b.decide("a1", "deny", "no");
    expect(() => b.decide("a1", "allow", "yes")).toThrow(AlreadyDecidedError);
    await expect(p).resolves.toEqual({ decision: "deny", reason: "no" });
  });

  it("an unknown action throws NotFoundError", () => {
    expect(() => new ApprovalBroker().decide("nope", "allow", "")).toThrow(NotFoundError);
  });

  it("an abort denies with 'run stopped'", async () => {
    const b = new ApprovalBroker();
    const ac = new AbortController();
    const p = b.wait("a1", ac.signal);
    ac.abort();
    await expect(p).resolves.toEqual({ decision: "deny", reason: "run stopped" });
    expect(b.pendingIds()).toEqual([]);
    expect(() => b.decide("a1", "allow", "")).toThrow(AlreadyDecidedError);
  });

  it("an already aborted signal denies immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(new ApprovalBroker().wait("a1", ac.signal)).resolves.toEqual({ decision: "deny", reason: "run stopped" });
  });
});
