import { CLAUDE_SUBSCRIPTION_ACK, PROVIDER_ACKS } from "@theterminal/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { ProviderSettings, RestrictedSignInError } from "../../src/agents/settings.js";
import { openDatabase, type Db } from "../../src/db.js";
import { commitEvent } from "../../src/events/commit.js";
import { rebuildAllProjections } from "../../src/events/projections.js";
import { Ledger } from "../../src/ledger/ledger.js";

const human = { kind: "human", id: "owner" } as const;
let db: Db;
let ledger: Ledger;
let settings: ProviderSettings;

beforeEach(() => {
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  // The restricted own-plan modes (Claude subscription, Gemini Google) are on here; the switch has its own tests below.
  settings = new ProviderSettings(db, ledger, { restrictedSignIn: true });
});

describe("ProviderSettings", () => {
  it("defaults every provider to api_key", () => {
    for (const p of ["claude", "codex", "gemini"] as const) expect(settings.getMode(p)).toBe("api_key");
  });

  it("sets each login mode with its own acknowledgement, independently per provider", () => {
    settings.setMode(human, "claude", "subscription", PROVIDER_ACKS.claude);
    settings.setMode(human, "codex", "chatgpt", PROVIDER_ACKS.codex);
    expect(settings.getMode("claude")).toBe("subscription");
    expect(settings.getMode("codex")).toBe("chatgpt");
    expect(settings.getMode("gemini")).toBe("api_key");
    settings.setMode(human, "gemini", "google", PROVIDER_ACKS.gemini);
    expect(settings.getMode("gemini")).toBe("google");
    settings.setMode(human, "codex", "api_key");
    expect(settings.getMode("codex")).toBe("api_key");
  });

  it("requires the exact acknowledgement for every non-api_key mode and records nothing on failure", () => {
    const before = ledger.list({ afterSeq: 0, limit: 100 }).length;
    expect(() => settings.setMode(human, "claude", "subscription")).toThrow();
    expect(() => settings.setMode(human, "codex", "chatgpt", "yes")).toThrow();
    expect(() => settings.setMode(human, "gemini", "google", PROVIDER_ACKS.codex)).toThrow();
    expect(ledger.list({ afterSeq: 0, limit: 100 })).toHaveLength(before);
  });

  it("rejects modes that do not belong to the provider", () => {
    expect(() => settings.setMode(human, "claude", "chatgpt", PROVIDER_ACKS.codex)).toThrow();
    expect(() => settings.setMode(human, "codex", "subscription", PROVIDER_ACKS.claude)).toThrow();
    expect(() => settings.setMode(human, "gemini", "none")).toThrow();
  });

  it("survives a rebuild from the ledger", () => {
    settings.setMode(human, "codex", "chatgpt", PROVIDER_ACKS.codex);
    rebuildAllProjections(db, ledger);
    expect(settings.getMode("codex")).toBe("chatgpt");
  });

  it("reads an old settings.claude_auth_changed entry as the claude mode after a rebuild", () => {
    commitEvent(db, ledger, () => ({
      event: { projectId: null, actor: human, type: "settings.claude_auth_changed", payload: { mode: "subscription", acknowledgement: CLAUDE_SUBSCRIPTION_ACK } },
      result: () => undefined,
    }));
    rebuildAllProjections(db, ledger);
    expect(settings.getMode("claude")).toBe("subscription");
    expect(settings.getMode("codex")).toBe("api_key");
  });

  it("the last of an old and a new event wins when replayed in order", () => {
    commitEvent(db, ledger, () => ({
      event: { projectId: null, actor: human, type: "settings.claude_auth_changed", payload: { mode: "subscription", acknowledgement: CLAUDE_SUBSCRIPTION_ACK } },
      result: () => undefined,
    }));
    settings.setMode(human, "claude", "api_key");
    expect(settings.getMode("claude")).toBe("api_key");
    rebuildAllProjections(db, ledger);
    expect(settings.getMode("claude")).toBe("api_key");
  });
});

describe("ProviderSettings: the restricted sign-in switch", () => {
  const off = () => new ProviderSettings(db, ledger);
  const count = () => ledger.list({ afterSeq: 0, limit: 100 }).length;

  it("is off by default: Claude subscription and Gemini Google are refused and nothing is recorded", () => {
    const s = off();
    const before = count();
    expect(() => s.setMode(human, "claude", "subscription", PROVIDER_ACKS.claude)).toThrow(RestrictedSignInError);
    expect(() => s.setMode(human, "gemini", "google", PROVIDER_ACKS.gemini)).toThrow(RestrictedSignInError);
    expect(count()).toBe(before);
    expect(s.getMode("claude")).toBe("api_key");
    expect(s.getMode("gemini")).toBe("api_key");
  });

  it("leaves Codex's ChatGPT sign-in and every API key mode alone", () => {
    const s = off();
    s.setMode(human, "codex", "chatgpt", PROVIDER_ACKS.codex);
    expect(s.getMode("codex")).toBe("chatgpt");
    s.setMode(human, "claude", "api_key");
    s.setMode(human, "gemini", "api_key");
    expect(s.getMode("claude")).toBe("api_key");
  });

  it("names the provider on the error", () => {
    expect(() => off().setMode(human, "gemini", "google", PROVIDER_ACKS.gemini)).toThrow(
      expect.objectContaining({ name: "RestrictedSignInError", provider: "gemini" }),
    );
  });

  it("reads a stored restricted mode as api_key while off, without rewriting the ledger, and reports it", () => {
    settings.setMode(human, "claude", "subscription", PROVIDER_ACKS.claude);
    settings.setMode(human, "gemini", "google", PROVIDER_ACKS.gemini);
    const before = count();
    const s = off();
    expect(s.getMode("claude")).toBe("api_key");
    expect(s.getMode("gemini")).toBe("api_key");
    expect(s.turnedOff()).toEqual(["claude", "gemini"]);
    expect(count()).toBe(before);
    // Turned back on, the recorded choice applies again.
    expect(settings.getMode("claude")).toBe("subscription");
    expect(settings.turnedOff()).toEqual([]);
  });

  it("reads an old settings.claude_auth_changed subscription entry as api_key while off", () => {
    commitEvent(db, ledger, () => ({
      event: { projectId: null, actor: human, type: "settings.claude_auth_changed", payload: { mode: "subscription", acknowledgement: CLAUDE_SUBSCRIPTION_ACK } },
      result: () => undefined,
    }));
    expect(off().getMode("claude")).toBe("api_key");
  });

  it("says which own-plan modes are available", () => {
    expect([off().ownModeAvailable("claude"), off().ownModeAvailable("codex"), off().ownModeAvailable("gemini")]).toEqual([false, true, false]);
    expect(["claude", "codex", "gemini"].map((p) => settings.ownModeAvailable(p as "claude"))).toEqual([true, true, true]);
  });
});
