import { agentPayloadSchemas, PROVIDER_MODES, type Actor, type AuthMode, type Provider } from "@theterminal/shared";
import type { Db } from "../db.js";
import { commitEvent } from "../events/commit.js";
import { getSetting } from "../events/projections.js";
import type { Ledger } from "../ledger/ledger.js";

/** Per-provider auth mode. `api_key` is the default; a login mode needs that provider's exact acknowledgement. */
export class ProviderSettings {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
  ) {}

  getMode(p: Provider): AuthMode {
    const v = getSetting(this.db, `auth_mode:${p}`);
    return v !== null && (PROVIDER_MODES[p] as readonly string[]).includes(v) ? (v as AuthMode) : "api_key";
  }

  /** Throws a ZodError unless the mode suits the provider and a login mode carries the exact acknowledgement. */
  setMode(actor: Actor, p: Provider, mode: AuthMode, acknowledgement?: string): void {
    const payload = agentPayloadSchemas["settings.provider_auth_changed"].parse({
      provider: p,
      mode,
      acknowledgement: mode === "api_key" ? "" : acknowledgement,
    });
    commitEvent(this.db, this.ledger, () => ({
      event: { projectId: null, actor, type: "settings.provider_auth_changed", payload },
      result: () => undefined,
    }));
  }
}
