import { z } from "zod";
import { STAGES } from "./domain.js";
import { agentPayloadSchemas, type AgentEventType } from "./agents.js";
import { connectionPayloadSchemas, type ConnectionEventType } from "./connections.js";
import { intakePayloadSchemas, type IntakeEventType } from "./intake.js";
import { gatePayloadSchemas, type GateEventType } from "./gates.js";
import { overridePayloadSchemas, type OverrideEventType } from "./override.js";
import { linkPayloadSchemas, type LinkEventType } from "./link.js";
import { sharePayloadSchemas, type ShareEventType } from "./share.js";
import { agentBoardPayloadSchemas, type AgentBoardEventType } from "./agent-board.js";
import { sourcePayloadSchemas, type SourceEventType } from "./sources.js";
import { peoplePayloadSchemas, type PeopleEventType } from "./people.js";

export const stageSchema = z.enum(STAGES);

export const cardStatusSchema = z.enum(["todo", "active", "blocked", "done"]);

export const actorSchema = z.object({
  kind: z.enum(["human", "agent", "system"]),
  id: z.string().min(1),
});

export const projectInputSchema = z.object({
  name: z.string().min(1).max(120),
  pitch: z.string().max(500).default(""),
});
export type ProjectInput = z.infer<typeof projectInputSchema>;

export const cardInputSchema = z.object({
  title: z.string().min(1).max(200),
  stage: stageSchema,
});
export type CardInput = z.infer<typeof cardInputSchema>;

export type EventType =
  | "project.created"
  | "card.created"
  | "card.moved"
  | "card.status_changed"
  | AgentEventType
  | ConnectionEventType
  | IntakeEventType
  | GateEventType
  | OverrideEventType
  | LinkEventType
  | ShareEventType
  | PeopleEventType
  | SourceEventType
  | AgentBoardEventType;

const nonEmptyId = z.string().min(1);

export const eventPayloadSchemas: Record<EventType, z.ZodType> = {
  "project.created": z.object({ projectId: nonEmptyId, name: z.string(), pitch: z.string() }).strict(),
  "card.created": z.object({ cardId: nonEmptyId, title: z.string(), stage: stageSchema }).strict(),
  "card.moved": z.object({ cardId: nonEmptyId, from: stageSchema, to: stageSchema }).strict(),
  "card.status_changed": z
    .object({ cardId: nonEmptyId, from: cardStatusSchema, to: cardStatusSchema })
    .strict(),
  ...agentPayloadSchemas,
  ...connectionPayloadSchemas,
  ...intakePayloadSchemas,
  ...gatePayloadSchemas,
  ...overridePayloadSchemas,
  ...linkPayloadSchemas,
  ...sharePayloadSchemas,
  ...peoplePayloadSchemas,
  ...sourcePayloadSchemas,
  ...agentBoardPayloadSchemas,
};
