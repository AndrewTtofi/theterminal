import type { AgentRun, LedgerEntry } from "@theterminal/shared";

export const feedRun = (id: string, over: Partial<AgentRun> = {}): AgentRun => ({
  id, projectId: "p1", cardId: null, adapter: "fake", authMode: "none", prompt: "Detect GPU", status: "completed",
  worktree: `w/${id}`, base: null, costUsd: null, inputTokens: null, outputTokens: null, error: null,
  startedAt: "2026-11-15T10:00:00.000Z", finishedAt: null, machineId: null, ...over,
});

const at = (seq: number) => new Date(Date.UTC(2026, 10, 15, 10, 0, seq % 60)).toISOString();

/** A project ledger entry of `type` with `payload`, written by the agent of `payload.runId` (or the Owner). */
export const ev = (seq: number, type: LedgerEntry["type"], payload: Record<string, unknown>): LedgerEntry => ({
  seq, id: `e${seq}`, ts: at(seq), projectId: "p1",
  actor: type.startsWith("override.") ? { kind: "human", id: "owner" } : { kind: "agent", id: String(payload.runId) },
  type, payload, prevHash: "", hash: "",
});

export const requested = (seq: number, runId: string, actionId: string, command: string, tool = "Bash"): LedgerEntry =>
  ev(seq, "agent.action.requested", {
    runId, actionId, kind: "shell", tool, summary: `Run: ${command}`,
    input: tool === "codex.stdin" ? { reason: command } : { command },
  });

export const decided = (seq: number, runId: string, actionId: string, decision: "allow" | "deny", reason = ""): LedgerEntry =>
  ev(seq, "agent.action.decided", { runId, actionId, decision, by: "human", reason });

export const completed = (seq: number, runId: string, actionId: string, output: string, ok = true): LedgerEntry =>
  ev(seq, "agent.action.completed", { runId, actionId, ok, output });

export const overrideCommand = (seq: number, runId: string, program: string, args: string[]): LedgerEntry =>
  ev(seq, "override.command", { overrideId: `o${seq}`, runId, program, args, cwd: ".", reason: "The agent broke the build" });

export const overrideCompleted = (seq: number, runId: string, output: string, ok = true): LedgerEntry =>
  ev(seq, "override.completed", {
    overrideId: `o${seq - 1}`, runId, ok, exitCode: ok ? 0 : 1, signal: null, timedOut: false, durationMs: 5, output,
  });

export const message = (seq: number, runId: string, text: string): LedgerEntry => ev(seq, "agent.message", { runId, text });
