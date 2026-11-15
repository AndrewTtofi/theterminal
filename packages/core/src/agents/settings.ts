import { agentPayloadSchemas, isRestrictedMode, PROVIDER_MODES, PROVIDERS, type Actor, type AuthMode, type Provider } from "@theterminal/shared";
import type { Db } from "../db.js";
import { commitEvent } from "../events/commit.js";
import { getSetting } from "../events/projections.js";
import type { Ledger } from "../ledger/ledger.js";

/**
 * A restricted own-plan mode (Claude subscription, Gemini Google sign-in, see RESTRICTED_MODES) was asked for while the
 * restricted sign-in switch is off. `provider` is one of the fixed provider names.
 */
export class RestrictedSignInError extends Error {
  constructor(readonly provider: Provider) {
    super(`signing in with your own ${provider} plan is turned off on this server; use an API key`);
    this.name = "RestrictedSignInError";
  }
}

export type ProviderSettingsOptions = {
  /**
   * The restricted sign-in switch: whether the restricted own-plan modes may be chosen and used. Default off (fail
   * closed): they are refused when chosen, and a recorded one reads as `api_key`.
   */
  restrictedSignIn?: boolean;
};

/** Per-provider auth mode. `api_key` is the default; a login mode needs that provider's exact acknowledgement. */
export class ProviderSettings {
  private readonly restrictedSignIn: boolean;

  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    opts: ProviderSettingsOptions = {},
  ) {
    this.restrictedSignIn = opts.restrictedSignIn === true;
  }

  /** The recorded mode, or `api_key`; a restricted mode reads as `api_key` while the switch is off. */
  getMode(p: Provider): AuthMode {
    const v = this.recordedMode(p);
    return !this.restrictedSignIn && isRestrictedMode(p, v) ? "api_key" : v;
  }

  /** Whether `p`'s own-plan mode can be chosen on this server. */
  ownModeAvailable(p: Provider): boolean {
    return this.restrictedSignIn || !isRestrictedMode(p, PROVIDER_MODES[p][1]);
  }

  /** The providers whose recorded mode is a restricted one that the switch being off turns into `api_key`. */
  turnedOff(): Provider[] {
    return this.restrictedSignIn ? [] : PROVIDERS.filter((p) => isRestrictedMode(p, this.recordedMode(p)));
  }

  private recordedMode(p: Provider): AuthMode {
    const v = getSetting(this.db, `auth_mode:${p}`);
    return v !== null && (PROVIDER_MODES[p] as readonly string[]).includes(v) ? (v as AuthMode) : "api_key";
  }

  /**
   * Throws RestrictedSignInError for a restricted mode while the switch is off, and a ZodError unless the mode suits
   * the provider and a login mode carries the exact acknowledgement. Nothing is recorded when it throws.
   */
  setMode(actor: Actor, p: Provider, mode: AuthMode, acknowledgement?: string): void {
    if (!this.restrictedSignIn && isRestrictedMode(p, mode)) throw new RestrictedSignInError(p);
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
