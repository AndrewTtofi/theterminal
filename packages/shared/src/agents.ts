import { z } from "zod";

export const ADAPTERS = ["claude", "codex", "gemini", "fake"] as const;
export type AdapterId = (typeof ADAPTERS)[number];
export const PROVIDERS = ["claude", "codex", "gemini"] as const;
export type Provider = (typeof PROVIDERS)[number];
/** The auth modes each provider offers. `api_key` is always available; the others use the user's own CLI login. */
export const PROVIDER_MODES = {
  claude: ["api_key", "subscription"],
  codex: ["api_key", "chatgpt"],
  gemini: ["api_key", "google"],
} as const;
export type AuthMode = "api_key" | "subscription" | "chatgpt" | "google" | "none";
export const ACTION_KINDS = ["file_read", "file_write", "file_edit", "shell", "web", "mcp", "other"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export type ActionStatus = "pending" | "allowed" | "denied" | "completed" | "failed";
export type RunStatus = "running" | "completed" | "failed" | "stopped";

export type AgentRun = {
  id: string;
  projectId: string;
  cardId: string | null;
  adapter: AdapterId;
  authMode: AuthMode;
  prompt: string;
  status: RunStatus;
  /** Relative to dataDir. */
  worktree: string;
  costUsd: number | null;
  /** Totals the provider reported for the run (estimates); null when it reported none. */
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type AgentAction = {
  id: string;
  runId: string;
  kind: ActionKind;
  tool: string;
  summary: string;
  input: unknown;
  status: ActionStatus;
  decidedBy: "human" | "policy" | null;
  reason: string;
  output: string | null;
  requestedAt: string;
  decidedAt: string | null;
};

/** A pending action with the project it belongs to, for the cross-project "Needs you" strip. */
export type PendingAgentAction = AgentAction & { projectId: string; projectName: string };

export const CLAUDE_SUBSCRIPTION_ACK =
  "I understand that running Claude on my own Claude subscription through The Terminal may violate Anthropic's terms and could put my account at risk. I choose to do this at my own risk.";

export const PROVIDER_ACKS: Record<Provider, string> = {
  claude: CLAUDE_SUBSCRIPTION_ACK,
  codex:
    "I understand that running Codex on my own ChatGPT plan through The Terminal uses my plan's limits and is subject to OpenAI's terms. I choose to do this.",
  gemini:
    "I understand that running Gemini on my own Google account through The Terminal is subject to Google's terms. I choose to do this.",
};

const id = z.string().min(1).max(200);

const isJsonValue = (v: unknown): boolean => {
  try {
    return JSON.stringify(v) !== undefined;
  } catch {
    return false;
  }
};

const relativeWorktree = z
  .string()
  .min(1)
  .max(500)
  .refine((w) => !w.startsWith("/") && !w.startsWith("\\") && !/^[A-Za-z]:/.test(w), "must be relative")
  .refine((w) => !w.split(/[\\/]/).includes(".."), "must not contain '..' segments");

export const agentPayloadSchemas = {
  "agent.started": z
    .object({
      runId: id,
      adapter: z.enum(ADAPTERS),
      authMode: z.enum(["api_key", "subscription", "chatgpt", "google", "none"]),
      prompt: z.string().min(1).max(20000),
      cardId: z.string().max(200).nullable(),
      worktree: relativeWorktree,
    })
    .strict(),
  "agent.message": z.object({ runId: id, text: z.string().max(4000) }).strict(),
  "agent.action.requested": z
    .object({
      runId: id,
      actionId: id,
      kind: z.enum(ACTION_KINDS),
      tool: z.string().min(1).max(200),
      summary: z.string().min(1).max(200),
      input: z.unknown().refine(isJsonValue, "must be JSON-serialisable"),
    })
    .strict(),
  "agent.action.decided": z
    .object({
      runId: id,
      actionId: id,
      decision: z.enum(["allow", "deny"]),
      by: z.enum(["human", "policy"]),
      reason: z.string().max(500),
    })
    .strict(),
  "agent.action.completed": z
    .object({ runId: id, actionId: id, ok: z.boolean(), output: z.string().max(4000) })
    .strict(),
  "agent.finished": z
    .object({
      runId: id,
      status: z.enum(["completed", "failed", "stopped"]),
      costUsd: z.number().nullable(),
      // Absent in entries written before token totals were recorded.
      inputTokens: z.number().int().nonnegative().nullable().optional(),
      outputTokens: z.number().int().nonnegative().nullable().optional(),
      error: z.string().max(1000).nullable(),
    })
    .strict(),
  /** The provider refused a request for its rate limit; `retryAfterS` when it said how long to wait. */
  "agent.rate_limited": z.object({ runId: id, retryAfterS: z.number().int().nonnegative().nullable() }).strict(),
  "settings.claude_auth_changed": z
    .object({ mode: z.enum(["api_key", "subscription"]), acknowledgement: z.string().max(1000) })
    .strict()
    .refine((p) => p.mode !== "subscription" || p.acknowledgement === CLAUDE_SUBSCRIPTION_ACK, {
      error: "subscription mode requires the exact acknowledgement",
      path: ["acknowledgement"],
    }),
  "settings.provider_auth_changed": z
    .object({
      provider: z.enum(PROVIDERS),
      mode: z.enum(["api_key", "subscription", "chatgpt", "google"]),
      acknowledgement: z.string().max(1000),
    })
    .strict()
    .superRefine((p, ctx) => {
      if (!(PROVIDER_MODES[p.provider] as readonly string[]).includes(p.mode)) {
        ctx.addIssue({ code: "custom", message: `mode ${p.mode} is not available for ${p.provider}`, path: ["mode"] });
      } else if (p.mode !== "api_key" && p.acknowledgement !== PROVIDER_ACKS[p.provider]) {
        ctx.addIssue({ code: "custom", message: "this mode requires the exact acknowledgement", path: ["acknowledgement"] });
      }
    }),
} satisfies Record<string, z.ZodType>;

export type AgentEventType = keyof typeof agentPayloadSchemas;
