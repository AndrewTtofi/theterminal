import type { AdapterStartOptions, AgentAdapter, ProposedAction } from "./adapter.js";

export type FakeStep =
  | { propose: ProposedAction; result?: { ok: boolean; output: string } }
  | { message: string }
  | { throw: string };

/**
 * Scripted adapter for tests and demos. Only registered when THETERMINAL_FAKE_AGENT=1; its script is a JSON array of
 * steps in THETERMINAL_FAKE_SCRIPT, read once at createServer time (e2e/global-setup.ts sets both).
 */
export class FakeAdapter implements AgentAdapter {
  readonly id = "fake" as const;

  constructor(private readonly script: FakeStep[]) {}

  async start(o: AdapterStartOptions): Promise<{ status: "completed" | "failed"; error?: string }> {
    for (const step of this.script) {
      if (o.signal.aborted) return { status: "failed", error: "run stopped" };
      if ("throw" in step) throw new Error(step.throw);
      if ("message" in step) {
        o.emit({ type: "message", text: step.message });
        continue;
      }
      const gate = await o.gate(step.propose);
      if (gate.decision === "allow" && step.result) {
        o.emit({ type: "action_result", actionId: gate.actionId, ...step.result });
      }
    }
    if (o.signal.aborted) return { status: "failed", error: "run stopped" };
    o.emit({ type: "usage", costUsd: 0 });
    return { status: "completed" };
  }
}
