import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import type { SecretStore } from "../secrets/store.js";
import { LinkClient } from "../link/client.js";
import { LinkListener } from "../link/listener.js";
import { LinkService } from "../link/service.js";
import { registerLinkProtocolRoutes } from "../link/protocol-routes.js";

export type LinkWiringDeps = { db: Db; ledger: Ledger; secrets: SecretStore; bind: string };

/**
 * The workspace server's linked-machine parts. Nothing listens yet: `link.load()` starts the listener (when the
 * recorded opt-in says so), and the server awaits it only after every dependency the `/link/v1/*` routes use exists.
 */
export function wireLink(deps: LinkWiringDeps): { link: LinkService } {
  const link: LinkService = new LinkService({
    db: deps.db,
    ledger: deps.ledger,
    secrets: deps.secrets,
    bind: deps.bind,
    listener: (listenerDeps) => new LinkListener(listenerDeps),
    client: (identity, timeoutMs) => new LinkClient({ identity, ...(timeoutMs !== undefined && { timeoutMs }) }),
    // Evaluated when the listener starts, so the routes may reference the service itself.
    registerProtocol: (app) => registerLinkProtocolRoutes(app, { link }),
  });
  return { link };
}
