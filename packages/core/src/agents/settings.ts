import { agentPayloadSchemas, type Actor } from "@theterminal/shared";
import type { Db } from "../db.js";
import { commitEvent } from "../events/commit.js";
import { getSetting } from "../events/projections.js";
import type { Ledger } from "../ledger/ledger.js";

export type ClaudeAuthMode = "api_key" | "subscription";

/** The Claude auth-mode setting. `api_key` is the default; `subscription` needs the exact acknowledgement. */
export class ClaudeSettings {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
  ) {}

  getMode(): ClaudeAuthMode {
    return getSetting(this.db, "claude_auth_mode") === "subscription" ? "subscription" : "api_key";
  }

  /** Throws a ZodError unless subscription mode carries exactly CLAUDE_SUBSCRIPTION_ACK. */
  setMode(actor: Actor, mode: ClaudeAuthMode, acknowledgement?: string): void {
    const payload = agentPayloadSchemas["settings.claude_auth_changed"].parse({
      mode,
      acknowledgement: mode === "subscription" ? acknowledgement : "",
    });
    commitEvent(this.db, this.ledger, () => ({
      event: { projectId: null, actor, type: "settings.claude_auth_changed", payload },
      result: () => undefined,
    }));
  }
}
