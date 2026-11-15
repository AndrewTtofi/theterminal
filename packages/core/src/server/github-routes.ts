import type { FastifyInstance } from "fastify";
import type { GitHubClient } from "../github/client.js";
import { needs } from "./auth.js";

/** The read-only GitHub view. Errors are mapped by the handler in routes.ts. */
export function registerGitHubRoutes(app: FastifyInstance, deps: { github: GitHubClient }): void {
  app.get("/api/github/overview", needs("viewer"), async () => deps.github.overview());
}
