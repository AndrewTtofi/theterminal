import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AdapterEvent, AdapterStartOptions, AgentAdapter, ProposedAction } from "./adapter.js";

export type FakeStep =
  /**
   * `whenEnv`: the step runs only when the run was given that cloud variable (credentials.env), so a script can hold
   * steps for runs with cloud connections without changing runs without them. `{{NAME}}` in the result's output is
   * replaced by the run's value of NAME (empty when absent), so the fake can print what it was given. `write` writes
   * a file under the run's working directory, only when the step is allowed, so the double never changes its
   * working copy without a gate decision; a path with a `..` segment or an absolute path is refused with an Error.
   */
  | { propose: ProposedAction; result?: { ok: boolean; output: string }; whenEnv?: string; write?: { path: string; content: string } }
  | { message: string }
  | { usage: Omit<Extract<AdapterEvent, { type: "usage" }>, "type"> }
  | { rateLimited: Omit<Extract<AdapterEvent, { type: "rate_limited" }>, "type"> }
  | { throw: string };

/** A path the fake may write: relative, with no `..` segment, on any platform's spelling. */
function assertRelative(path: string): void {
  const absolute = isAbsolute(path) || /^[A-Za-z]:/.test(path) || /^[\\/]/.test(path);
  if (path === "" || absolute || path.split(/[\\/]/).includes("..")) throw new Error(`fake write refused: ${path}`);
}

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
      if ("rateLimited" in step) {
        o.emit({ type: "rate_limited", ...step.rateLimited });
        continue;
      }
      if ("usage" in step) {
        o.emit({ type: "usage", ...step.usage });
        continue;
      }
      const env = o.credentials.env;
      if (step.whenEnv !== undefined && env[step.whenEnv] === undefined) continue;
      if (step.write) assertRelative(step.write.path);
      const gate = await o.gate(step.propose);
      if (gate.decision === "allow" && step.write) {
        const file = join(o.cwd, step.write.path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, step.write.content);
      }
      if (gate.decision === "allow" && step.result) {
        const output = step.result.output.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name: string) => env[name] ?? "");
        o.emit({ type: "action_result", actionId: gate.actionId, ok: step.result.ok, output });
      }
    }
    if (o.signal.aborted) return { status: "failed", error: "run stopped" };
    o.emit({ type: "usage", costUsd: 0 });
    return { status: "completed" };
  }
}
