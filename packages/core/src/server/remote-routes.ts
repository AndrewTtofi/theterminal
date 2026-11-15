import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { domainSchema, type Actor, type Listener, type Principal, type RemoteState } from "@theterminal/shared";
import { LedgerReadOnlyError } from "../ledger/ledger.js";
import { PUBLIC_ROUTE } from "./auth.js";
import { CertificateError } from "./certs.js";
import {
  HEALTHZ_PATH,
  OwnerCredentialRequiredError,
  RemoteInputError,
  RemoteStartError,
  listenerOf as tlsListenerOf,
  type EnableInput,
  type RemoteView,
} from "./remote.js";

/** What the routes need from the RemoteListener. */
export type RemoteControl = {
  state(): RemoteView;
  enable(actor: Actor, i: EnableInput): Promise<RemoteState>;
  disable(actor: Actor, opts?: { spare?: unknown }): Promise<void>;
};

export type RemoteRoutesDeps = {
  remote: RemoteControl;
  /** The request's principal (Task 2b's `request.principal`); null when nobody is signed in. */
  principalOf: (request: FastifyRequest) => Principal | null;
  listenerOf?: (request: FastifyRequest) => Listener;
};

/** `/api/status.remote`: `label` only for the Owner, since the address is the Owner's. */
export type RemoteStatus = { enabled: boolean; listening: boolean; label?: string };

const host = (address: string) => (address.includes(":") ? `[${address}]` : address);

/** `<domain>:<port>`, else `<first address>:<port>` (the bind address when not listening), or `off`. */
export function remoteLabel(s: RemoteView): string {
  if (!s.enabled) return "off";
  if (s.domain !== null) return `${s.domain}:${s.port}`;
  return `${host(s.addresses[0] ?? s.bind)}:${s.port}`;
}

export function remoteStatus(s: RemoteView, principal: Principal | null): RemoteStatus {
  const out: RemoteStatus = { enabled: s.enabled, listening: s.listening };
  if (principal?.role === "owner") out.label = remoteLabel(s);
  return out;
}

const MAX_PATH = 4096;
const putSchema = z
  .object({
    enabled: z.boolean(),
    port: z.number().int().min(1).max(65535).optional(),
    bind: z.string().min(1).max(45).optional(),
    domain: domainSchema.nullable().optional(),
    tls: z.enum(["self_signed", "acme", "provided"]).optional(),
    certFile: z.string().min(1).max(MAX_PATH).optional(),
    keyFile: z.string().min(1).max(MAX_PATH).optional(),
  })
  .strict();

/**
 * `GET /healthz` (public; the auth hook exempts it from the Host check), `GET /api/remote` (viewer; non-owners get
 * `{ enabled, listening }` only) and `PUT /api/remote` (owner; enabling only from the local listener). Task 2b/4's
 * role table enforces the roles too; the checks here keep the Owner's address and switch the Owner's alone.
 */
export function registerRemoteRoutes(app: FastifyInstance, deps: RemoteRoutesDeps): void {
  const listenerOf = deps.listenerOf ?? tlsListenerOf;

  app.get(HEALTHZ_PATH, { config: PUBLIC_ROUTE }, async () => ({ ok: true }));

  app.get("/api/remote", async (request, reply) => {
    const principal = deps.principalOf(request);
    if (principal === null) return reply.code(401).send({ error: "unauthorized" });
    const s = deps.remote.state();
    return principal.role === "owner" ? s : { enabled: s.enabled, listening: s.listening };
  });

  app.put("/api/remote", { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const principal = deps.principalOf(request);
    if (principal === null) return reply.code(401).send({ error: "unauthorized" });
    if (principal.role !== "owner") return reply.code(403).send({ error: "forbidden", required: "owner" });
    const parsed = putSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input" });
    const { enabled, ...input } = parsed.data;
    if (enabled && listenerOf(request) !== "local") return reply.code(409).send({ error: "remote_only_from_local" });
    const actor: Actor = { kind: "human", id: principal.personId };
    try {
      if (enabled) await deps.remote.enable(actor, input);
      else if (listenerOf(request) === "remote") {
        // Turning remote off from a remote session: this connection is spared to carry the answer, then closed.
        reply.header("connection", "close");
        await deps.remote.disable(actor, { spare: request.raw.socket });
      } else await deps.remote.disable(actor);
    } catch (err) {
      if (err instanceof OwnerCredentialRequiredError) return reply.code(409).send({ error: "owner_credential_required" });
      if (err instanceof RemoteStartError) return reply.code(502).send({ error: "remote_start_failed" });
      if (err instanceof RemoteInputError) return reply.code(400).send({ error: "invalid_input", code: err.code });
      if (err instanceof CertificateError) return reply.code(400).send({ error: "certificate_invalid", code: err.code });
      if (err instanceof LedgerReadOnlyError) return reply.code(423).send({ error: "ledger_read_only" });
      throw err;
    }
    return deps.remote.state();
  });
}
