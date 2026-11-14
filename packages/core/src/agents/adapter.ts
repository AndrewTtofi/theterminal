import type { ActionKind, AdapterId, AuthMode } from "@theterminal/shared";

/** An action an agent wants to take. `paths` are the filesystem paths it touches (checked by policy). */
export type ProposedAction = { tool: string; kind: ActionKind; summary: string; input: unknown; paths: string[] };
export type GateResult = { decision: "allow" | "deny"; reason: string };
export type AdapterEvent =
  | { type: "message"; text: string }
  | { type: "action_result"; actionId: string; ok: boolean; output: string }
  | { type: "usage"; costUsd: number };

export interface AdapterStartOptions {
  cwd: string;
  prompt: string;
  authMode: AuthMode;
  signal: AbortSignal;
  /** Records the action, then resolves once it is allowed or denied. Never rejects. */
  gate: (a: ProposedAction) => Promise<GateResult & { actionId: string }>;
  emit: (e: AdapterEvent) => void;
}

export interface AgentAdapter {
  id: AdapterId;
  start(o: AdapterStartOptions): Promise<{ status: "completed" | "failed"; error?: string }>;
}
