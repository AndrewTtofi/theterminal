import type { EventType } from "./events.js";

export const STAGES = ["plan", "design", "build", "ship", "operate"] as const;
export type Stage = (typeof STAGES)[number];

export type CardStatus = "todo" | "active" | "blocked" | "done";

export type Actor = { kind: "human" | "agent" | "system"; id: string };

export type Project = { id: string; name: string; pitch: string; createdAt: string };

export type Card = {
  id: string;
  projectId: string;
  title: string;
  stage: Stage;
  status: CardStatus;
  createdAt: string;
  updatedAt: string;
};

export type Board = { project: Project; columns: Record<Stage, Card[]> };

export type LedgerEntry = {
  seq: number;
  id: string;
  ts: string;
  projectId: string | null;
  actor: Actor;
  type: EventType;
  payload: unknown;
  prevHash: string;
  hash: string;
};

export type NewLedgerEntry = Pick<LedgerEntry, "projectId" | "actor" | "type" | "payload">;

export const GENESIS_HASH = "0".repeat(64);
