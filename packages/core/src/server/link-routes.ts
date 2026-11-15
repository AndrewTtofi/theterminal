import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LINK_DEFAULT_PORT } from "@theterminal/shared";
import { IdentityUnavailableError, type LinkService } from "../link/service.js";
import type { LinkCapacity } from "../link/capacity.js";
import { verifyMirrored } from "../link/mirrored.js";
import type { Db } from "../db.js";
import { actorOf, needs } from "./auth.js";

export type LinkRouteDeps = {
  link: LinkService;
  /** The linked machines' capacity (see LinkCapacity). */
  capacity: LinkCapacity;
  /** The port the listener asks for when the Owner enables linking (the next 20 are tried). Default 4418. */
  port?: number;
  /** The projections and the ledger, for GET /api/link/verify. */
  db: Db;
};

const nameBody = z.object({ name: z.string() }).strict();
const enableBody = z.object({ acknowledgement: z.string() }).strict();
const pairBody = z.object({ address: z.string(), code: z.string() }).strict();
const idParams = z.object({ id: z.string().min(1).max(200) });
const capacityQuery = z.object({ cached: z.literal("1").optional() }).strict();

/**
 * Linked machines: the Owner's, since pairing holds credentials and addresses are LAN detail; a reviewer may verify
 * the mirrored entries. Behind registerAuth like every /api route (session and Host checks). Errors are mapped in routes.ts.
 */
export function registerLinkRoutes(app: FastifyInstance, deps: LinkRouteDeps): void {
  const { link } = deps;
  const port = deps.port ?? LINK_DEFAULT_PORT;
  /** This computer, or 503 identity_unavailable. */
  const self = () => {
    const s = link.self();
    if (!s) throw new IdentityUnavailableError();
    return s;
  };

  // The paired machines as last seen: no machine is asked and the network is not browsed (for names and the Run on
  // picker). The full overview below, which does both, is for the Machines view.
  app.get("/api/link/machines", needs("owner"), async () => link.presence());

  app.get("/api/link", needs("owner"), async () => {
    const ok = link.identityState() === "ok";
    // Each paired machine is asked once (3 s at most, all at once; answers are kept 15 s) before the rows are read.
    if (ok) await Promise.all(link.machines().map((m) => link.hello(m.id)));
    return {
      identity: link.identityState(),
      self: link.self(),
      machines: link.presence(),
      discovered: ok ? link.discovered() : [],
    };
  });

  app.post("/api/link/name", needs("owner"), async (req) => {
    const { name } = nameBody.parse(req.body);
    self();
    await link.setName(actorOf(req), name);
    return self();
  });

  app.post("/api/link/enable", needs("owner"), async (req) => {
    const { acknowledgement } = enableBody.parse(req.body);
    await link.enableLinking(actorOf(req), acknowledgement, port);
    return self();
  });

  // The UI sends this with no body and no content-type.
  app.post("/api/link/disable", needs("owner"), async (req) => {
    self();
    await link.disableLinking(actorOf(req));
    return self();
  });

  app.post("/api/link/code", needs("owner"), async () => {
    self();
    return link.showCode();
  });

  app.delete("/api/link/code", needs("owner"), async (_req, reply) => {
    link.cancelCode();
    return reply.code(204).send();
  });

  app.post("/api/link/pair", needs("owner"), async (req, reply) => {
    const { address, code } = pairBody.parse(req.body);
    const machine = await link.pair(actorOf(req), address, code);
    return reply.code(201).send(machine);
  });

  app.delete("/api/link/machines/:id", needs("owner"), async (req, reply) => {
    const { id } = idParams.parse(req.params);
    await link.unpair(actorOf(req), id);
    return reply.code(204).send();
  });

  // Every linked machine's entry recorded here, checked again against the key pinned for it now: a reviewer's check.
  app.get("/api/link/verify", needs("reviewer"), async () => verifyMirrored(deps.db));

  // Asked again now, or with `?cached=1` from the 30 s cache (sharing a request in flight). A machine that does not
  // answer, refuses or sends something unreadable is `online: false` with the values it last sent; nothing from its
  // reply reaches this answer. Another key at its address is 409 machine_key_mismatch.
  app.get("/api/link/machines/:id/capacity", needs("owner"), async (req) => {
    const { id } = idParams.parse(req.params);
    const { cached } = capacityQuery.parse(req.query);
    return deps.capacity.capacityOf(id, { fresh: cached !== "1" });
  });
}
