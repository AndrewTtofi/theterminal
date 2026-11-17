import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import type { AgentCards } from "../board/agent-cards.js";
import { NotFoundError, requireCard } from "../board/board-service.js";
import { cardInfos, listCardComments } from "../events/projections.js";
import { actorOf, needs } from "./auth.js";

export type CardRouteDeps = {
  db: Db;
  cards: Pick<AgentCards, "addComment" | "declineMove">;
  /** This machine's redaction, for runs on a linked machine. */
  clean: (s: string) => string;
};

/**
 * The longest note the route reads; the service clips what it records to 2,000 characters and checks the whole text
 * for secrets, so a longer note is stored clipped rather than refused.
 */
const NOTE_READ_MAX = 20_000;
const commentBody = z
  .object({ text: z.string().max(NOTE_READ_MAX).refine((t) => t.trim().length > 0, "a note needs some text") })
  .strict();
const declineBody = z.object({}).strict();

type Params = { Params: { id: string } };

/**
 * The agents' Board: what each card's latest run is doing, the notes people leave for the next run, and "Not yet" to
 * a move a gate held. Errors are mapped by the handler in routes.ts (404 `not_found`, 400 `secret_in_text`); nothing
 * from the request is echoed.
 */
export function registerCardRoutes(app: FastifyInstance, deps: CardRouteDeps): void {
  const { db, cards } = deps;

  app.get<Params>("/api/projects/:id/cards/info", needs("viewer"), async (req) => {
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(req.params.id)) throw new NotFoundError("project", "(given)");
    return { cards: cardInfos(db, req.params.id, deps.clean) };
  });

  app.get<Params>("/api/cards/:id/comments", needs("viewer"), async (req) => {
    requireCard(db, req.params.id);
    return { comments: listCardComments(db, req.params.id) };
  });

  // The author's name and role at this moment are recorded with the note.
  app.post<Params>("/api/cards/:id/comments", needs("maintainer"), async (req, reply) => {
    const { text } = commentBody.parse(req.body);
    const p = req.principal!;
    const comment = cards.addComment(actorOf(req), { name: p.name, role: p.role }, req.params.id, text);
    return reply.code(201).send(comment);
  });

  app.post<Params>("/api/cards/:id/move-request/decline", needs("reviewer"), async (req, reply) => {
    declineBody.parse(req.body ?? {});
    cards.declineMove(actorOf(req), req.params.id);
    return reply.code(204).send();
  });
}
