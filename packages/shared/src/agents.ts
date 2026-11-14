import { z } from "zod";

export const ADAPTERS = ["claude", "fake"] as const;
export type AdapterId = (typeof ADAPTERS)[number];
export type AuthMode = "api_key" | "subscription" | "none";
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

export const CLAUDE_SUBSCRIPTION_ACK =
  "I understand that running Claude on my own Claude subscription through The Terminal may violate Anthropic's terms and could put my account at risk. I choose to do this at my own risk.";

const id = z.string().min(1);

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
      authMode: z.enum(["api_key", "subscription", "none"]),
      prompt: z.string().min(1).max(20000),
      cardId: z.string().nullable(),
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
      error: z.string().max(1000).nullable(),
    })
    .strict(),
  "settings.claude_auth_changed": z
    .object({ mode: z.enum(["api_key", "subscription"]), acknowledgement: z.string() })
    .strict()
    .refine((p) => p.mode !== "subscription" || p.acknowledgement === CLAUDE_SUBSCRIPTION_ACK, {
      message: "subscription mode requires the exact acknowledgement",
      path: ["acknowledgement"],
    }),
} satisfies Record<string, z.ZodTypeAny>;

export type AgentEventType = keyof typeof agentPayloadSchemas;
