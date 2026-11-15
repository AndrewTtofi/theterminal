import { describe, expect, it } from "vitest";
import {
  DECISION_IDS,
  DEFAULT_SHARE_OPTIONS,
  DIGEST_DAYS,
  eventPayloadSchemas,
  HIDDEN_BY_DEFAULT,
  SHARE_SECTION_TITLES,
  SHARE_SECTIONS,
  SHARE_VERSION,
  sharePayloadSchemas,
  shareOptionsSchema,
  STACK_KIND_LAYERS,
  STACK_LAYERS,
  TTL_MINUTES,
} from "../src/index.js";

const HASH = "a".repeat(64);

describe("share options", () => {
  it("accepts the defaults", () => {
    expect(DEFAULT_SHARE_OPTIONS).toEqual({ includePrompts: false, includeHardware: false, digestDays: 7 });
    expect(shareOptionsSchema.safeParse(DEFAULT_SHARE_OPTIONS).success).toBe(true);
  });

  it("accepts every digest window", () => {
    expect(DIGEST_DAYS).toEqual([7, 14, 30]);
    for (const digestDays of DIGEST_DAYS) {
      expect(shareOptionsSchema.safeParse({ ...DEFAULT_SHARE_OPTIONS, digestDays }).success).toBe(true);
    }
  });

  it("rejects digestDays 10", () => {
    expect(shareOptionsSchema.safeParse({ ...DEFAULT_SHARE_OPTIONS, digestDays: 10 }).success).toBe(false);
  });

  it("rejects an extra key", () => {
    expect(shareOptionsSchema.safeParse({ ...DEFAULT_SHARE_OPTIONS, includeEverything: true }).success).toBe(false);
  });
});

describe("share catalogs", () => {
  it("has version 1, twelve sections each with a title, and four link lifetimes", () => {
    expect(SHARE_VERSION).toBe(1);
    expect(SHARE_SECTIONS).toHaveLength(12);
    expect(Object.keys(SHARE_SECTION_TITLES).sort()).toEqual([...SHARE_SECTIONS].sort());
    expect(SHARE_SECTION_TITLES.numbers).toBe("Headline numbers");
    expect(TTL_MINUTES).toEqual([60, 480, 1440, 10080]);
  });

  it("STACK_LAYERS has every decision id", () => {
    expect(Object.keys(STACK_LAYERS).sort()).toEqual([...DECISION_IDS].sort());
  });

  it("STACK_KIND_LAYERS has every connection kind but hardware", () => {
    expect(Object.keys(STACK_KIND_LAYERS).sort()).toEqual(["cloud", "github", "llm", "mcp"]);
  });

  it("HIDDEN_BY_DEFAULT has nine lines", () => {
    expect(HIDDEN_BY_DEFAULT).toHaveLength(9);
    expect(HIDDEN_BY_DEFAULT[0]).toBe(
      "Credentials, API keys and tokens (they live only in your keychain and are never in the ledger)",
    );
    // Says what the cleaner does: it scrubs the home and data folders, not every path on the computer.
    expect(HIDDEN_BY_DEFAULT[7]).toBe("Paths under your home folder and The Terminal's data folder, your username and email addresses");
  });
});

describe("share event payloads", () => {
  const confirmed = {
    shareId: "s1",
    contentHash: HASH,
    bytes: 1234,
    sections: ["overview", "audit"],
    options: DEFAULT_SHARE_OPTIONS,
    headSeq: 10,
  };
  const linkCreated = {
    linkId: "l1",
    shareId: "s1",
    tokenDigest: HASH,
    expiresAt: "2026-11-15T12:00:00.000Z",
    port: 8080,
    scope: "local_network",
  };

  it("are part of eventPayloadSchemas", () => {
    for (const type of Object.keys(sharePayloadSchemas)) {
      expect(eventPayloadSchemas[type as keyof typeof eventPayloadSchemas]).toBe(
        sharePayloadSchemas[type as keyof typeof sharePayloadSchemas],
      );
    }
  });

  it("share.confirmed accepts a valid payload and rejects a 63-character hash and no sections", () => {
    const s = sharePayloadSchemas["share.confirmed"];
    expect(s.safeParse(confirmed).success).toBe(true);
    expect(s.safeParse({ ...confirmed, contentHash: "a".repeat(63) }).success).toBe(false);
    expect(s.safeParse({ ...confirmed, sections: [] }).success).toBe(false);
    expect(s.safeParse({ ...confirmed, sections: ["secrets"] }).success).toBe(false);
    expect(s.safeParse({ ...confirmed, extra: 1 }).success).toBe(false);
  });

  it("share.link_created rejects scope internet and port 0", () => {
    const s = sharePayloadSchemas["share.link_created"];
    expect(s.safeParse(linkCreated).success).toBe(true);
    expect(s.safeParse({ ...linkCreated, scope: "this_computer" }).success).toBe(true);
    expect(s.safeParse({ ...linkCreated, scope: "internet" }).success).toBe(false);
    expect(s.safeParse({ ...linkCreated, port: 0 }).success).toBe(false);
    expect(s.safeParse({ ...linkCreated, port: 65536 }).success).toBe(false);
    expect(s.safeParse({ ...linkCreated, address: "192.168.1.2" }).success).toBe(false);
  });

  it("share.revoked rejects reason bored", () => {
    const s = sharePayloadSchemas["share.revoked"];
    expect(s.safeParse({ linkId: "l1", reason: "owner" }).success).toBe(true);
    expect(s.safeParse({ linkId: "l1", reason: "too_many_failures" }).success).toBe(true);
    expect(s.safeParse({ linkId: "l1", reason: "bored" }).success).toBe(false);
  });

  it("share.expired and share.stopped are strict", () => {
    expect(sharePayloadSchemas["share.expired"].safeParse({ linkId: "l1" }).success).toBe(true);
    expect(sharePayloadSchemas["share.expired"].safeParse({ linkId: "" }).success).toBe(false);
    const stopped = sharePayloadSchemas["share.stopped"];
    expect(stopped.safeParse({ linkId: "l1", reason: "shutdown" }).success).toBe(true);
    expect(stopped.safeParse({ linkId: "l1", reason: "restart" }).success).toBe(true);
    expect(stopped.safeParse({ linkId: "l1", reason: "crash" }).success).toBe(false);
    expect(stopped.safeParse({ linkId: "l1", reason: "restart", x: 1 }).success).toBe(false);
  });
});

describe("people on a share page", () => {
  it("types the Owner, a decision's signer and a waiting item's assignee as names, not the literal Owner", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("../src/share.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/(owner|by|assignee): "Owner"/);
    expect(src).toMatch(/\bowner: string;/);
    expect(src).toMatch(/\bby: string;/);
    expect(src).toMatch(/\bassignee: string\b/);
  });
});
