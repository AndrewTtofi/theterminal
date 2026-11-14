import type { ActionKind, AdapterId, AuthMode } from "@theterminal/shared";

/** An action an agent wants to take. `paths` are the filesystem paths it touches (checked by policy). */
export type ProposedAction = { tool: string; kind: ActionKind; summary: string; input: unknown; paths: string[] };
export type GateResult = { decision: "allow" | "deny"; reason: string };
export type AdapterEvent =
  | { type: "message"; text: string }
  | { type: "action_result"; actionId: string; ok: boolean; output: string }
  /** Each a finite number >= 0; absent means not reported. The runner sums each separately per run. */
  | { type: "usage"; costUsd?: number; inputTokens?: number; outputTokens?: number };

export interface AdapterStartOptions {
  cwd: string;
  /** The project the run belongs to (adapters may keep per-project state under the data directory). */
  projectId: string;
  prompt: string;
  authMode: AuthMode;
  signal: AbortSignal;
  /** Records the action, then resolves once it is allowed or denied. Never rejects. */
  gate: (a: ProposedAction) => Promise<GateResult & { actionId: string }>;
  emit: (e: AdapterEvent) => void;
  /**
   * Records an action the adapter refuses outright (e.g. a request it cannot serve) as requested and denied by
   * policy, without asking anyone. Resolves once recorded.
   */
  recordDenied: (a: ProposedAction, reason: string) => Promise<void>;
  /**
   * The runner's own cleaning without the length cap: redacts the secrets known right now (read on every call),
   * scrubs this run's paths, and redacts again. Adapters pass full text to the gate and let the runner cap it;
   * an adapter that caps a string for layout (a part of a summary) must apply this first, so a cut can never
   * leave a fragment of a secret that no pattern matches.
   */
  clean: (s: string) => string;
}

export interface AgentAdapter {
  id: AdapterId;
  start(o: AdapterStartOptions): Promise<{ status: "completed" | "failed"; error?: string }>;
}
