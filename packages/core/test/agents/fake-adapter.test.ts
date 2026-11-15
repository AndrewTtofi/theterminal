import { describe, expect, it } from "vitest";
import type { AdapterEvent, AdapterStartOptions, ProposedAction } from "../../src/agents/adapter.js";
import { FakeAdapter, type FakeStep } from "../../src/agents/fake-adapter.js";

const shell: ProposedAction = { tool: "Bash", kind: "shell", summary: "Run: printenv", input: { command: "printenv" }, paths: [] };

/** Runs the adapter with the given cloud env; returns what it proposed and emitted. */
async function run(script: FakeStep[], env: Record<string, string>) {
  const proposed: string[] = [];
  const events: AdapterEvent[] = [];
  const o: AdapterStartOptions = {
    cwd: ".", projectId: "p", prompt: "go", authMode: "none", signal: new AbortController().signal,
    gate: async (a) => {
      proposed.push(a.summary);
      return { decision: "allow", reason: "ok", actionId: `a${proposed.length}` };
    },
    emit: (e) => events.push(e),
    recordDenied: async () => undefined,
    clean: (s) => s,
    credentials: { env, mcpServers: [] },
  };
  const result = await new FakeAdapter(script).start(o);
  return { result, proposed, outputs: events.flatMap((e) => (e.type === "action_result" ? [e.output] : [])) };
}

describe("FakeAdapter", () => {
  const script: FakeStep[] = [
    { propose: { ...shell, summary: "Run: always" }, result: { ok: true, output: "plain" } },
    { whenEnv: "AWS_SESSION_TOKEN", propose: shell, result: { ok: true, output: "token {{AWS_SESSION_TOKEN}}, missing {{NOPE}}" } },
  ];

  it("a whenEnv step runs only when the run was given that variable, and its output names the run's values", async () => {
    const given = await run(script, { AWS_SESSION_TOKEN: "TESTKEY-token" });
    expect(given.proposed).toEqual(["Run: always", "Run: printenv"]);
    expect(given.outputs).toEqual(["plain", "token TESTKEY-token, missing "]);
    expect(given.result.status).toBe("completed");
  });

  it("skips a whenEnv step when the run was not given the variable", async () => {
    const without = await run(script, {});
    expect(without.proposed).toEqual(["Run: always"]);
    expect(without.outputs).toEqual(["plain"]);
  });
});
