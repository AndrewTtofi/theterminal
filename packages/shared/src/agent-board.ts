import { z } from "zod";
import type { AdapterId, RunProgress, RunStatus } from "./agents.js";
import { STAGES, type Stage } from "./domain.js";
import { adapterLabel } from "./narration.js";
import { ROLES, type Role } from "./people.js";

/** Limits for notes left on cards for the agent. */
export const COMMENT_LIMITS = { textChars: 2000, perRun: 20 } as const;

export type CommentState = "waiting" | "given" | "read";

export type CardComment = {
  id: string;
  cardId: string;
  authorName: string;
  role: Role;
  text: string;
  at: string;
  state: CommentState;
  runId: string | null;
  adapter: AdapterId | null;
};

export type CardInfo = {
  cardId: string;
  runId: string | null;
  adapter: AdapterId | null;
  runStatus: RunStatus | null;
  progress: RunProgress | null;
  percent: number | null;
  now: string | null;
  waiting: boolean;
  comments: number;
  commentsWaiting: number;
  screenshots: number;
  moveRequest: { to: Stage } | null;
};

export type CardMoveRequest = {
  cardId: string;
  projectId: string;
  projectName: string;
  title: string;
  runId: string;
  adapter: AdapterId | null;
  from: Stage;
  to: Stage;
  at: string;
};

/** Where a note stands, in words. */
export function commentStateLabel(c: Pick<CardComment, "state" | "adapter">): string {
  if (c.state === "waiting") return "Waiting for the next run";
  const who = adapterLabel(c.adapter ?? "claude");
  return c.state === "given" ? `Given to ${who}` : `Read by ${who}`;
}

const stageSchema = z.enum(STAGES);
const id = z.string().min(1).max(200);
const commentIds = z
  .array(id)
  .min(1)
  .max(COMMENT_LIMITS.perRun)
  .refine((a) => new Set(a).size === a.length, "ids must be unique");

export const agentBoardPayloadSchemas = {
  "card.run_linked": z.object({ cardId: id, runId: id }).strict(),
  "card.comment": z
    .object({
      commentId: id,
      cardId: id,
      text: z.string().min(1).max(COMMENT_LIMITS.textChars),
      authorName: z.string().min(1).max(120),
      role: z.enum(ROLES),
    })
    .strict(),
  "card.comments_given": z.object({ cardId: id, runId: id, commentIds }).strict(),
  "card.comments_read": z.object({ cardId: id, runId: id, commentIds }).strict(),
  "card.move_requested": z
    .object({ cardId: id, runId: id, from: stageSchema, to: stageSchema })
    .strict()
    .refine((p) => p.from !== p.to, "from and to must differ"),
  "card.move_declined": z.object({ cardId: id, to: stageSchema }).strict(),
} as const;

export type AgentBoardEventType = keyof typeof agentBoardPayloadSchemas;
