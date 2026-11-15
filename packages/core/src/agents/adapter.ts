import type { ActionKind, AdapterId, AuthMode } from "@theterminal/shared";
import type { McpServerSpec } from "../connections/mcp.js";

/** An action an agent wants to take. `paths` are the filesystem paths it touches (checked by policy). */
export type ProposedAction = { tool: string; kind: ActionKind; summary: string; input: unknown; paths: string[] };
export type GateResult = { decision: "allow" | "deny"; reason: string };
export type AdapterEvent =
  | { type: "message"; text: string }
  | { type: "action_result"; actionId: string; ok: boolean; output: string }
  /** Each a finite number >= 0; absent means not reported. The runner sums each separately per run. */
  | { type: "usage"; costUsd?: number; inputTokens?: number; outputTokens?: number }
  /**
   * The provider refused a request for its rate limit, as the adapter observed it (an estimate, not a quota the
   * provider published). `retryAfterS`: the wait the provider or CLI named, in seconds, when there was one.
   */
  | { type: "rate_limited"; retryAfterS?: number };

/** Error text that reads as a rate limit: a heuristic, which is why rate-limit counts are labelled estimates. */
export const RATE_LIMIT_TEXT = /\b429\b|rate[ _-]?limit/i;

/** The seconds in `retry after <n> second(s)`, or undefined. */
export function retryAfterSeconds(text: string): number | undefined {
  const m = /retry after (\d{1,9})\s*s/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

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
  /**
   * What the run uses from the provider's connection, resolved by the runner (empty without one). Adapters prefer
   * it over their own API key fallback (the server's environment variable).
   */
  credentials: RunCredentials;
}

/**
 * Values from connections: `apiKey` for api_key mode, `cliHome` for a login mode, `googleCloudProject` for Gemini (all
 * from the provider's own connection); `env`, the merged variables of the cloud grants the Owner selected for this run
 * (names from CLOUD_ENV_ALLOWLIST, passed to buildChildEnv as `extraEnv`); `mcpServers`, the MCP servers selected.
 */
export type RunCredentials = {
  apiKey?: string;
  cliHome?: string;
  googleCloudProject?: string;
  env: Record<string, string>;
  mcpServers: McpServerSpec[];
};

export interface AgentAdapter {
  id: AdapterId;
  start(o: AdapterStartOptions): Promise<{ status: "completed" | "failed"; error?: string }>;
}
