import { describe, expect, it } from "vitest";
import * as shared from "../src/index.js";
import {
  atLeast,
  CERT_FINGERPRINT,
  DEFAULT_REMOTE,
  domainSchema,
  eventPayloadSchemas,
  FINGERPRINT,
  INVITE_TTL_MS,
  OWNER_ID,
  peoplePayloadSchemas,
  personNameSchema,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLE_RANK,
  ROLES,
  SESSION_TTL_MS,
  type PeopleEventType,
} from "../src/index.js";

const HASH = "a".repeat(64);
const AT = "2026-11-15T10:00:00.000Z";
const CERT = Array.from({ length: 32 }, (_, i) => i.toString(16).toUpperCase().padStart(2, "0")).join(":");
const passkey = { kind: "passkey", credentialId: "Y3JlZC0x", publicKey: "cHVibGljLWtleQ", transports: ["internal"], label: "Laptop" };
const key = { kind: "key", credentialId: "a2V5LWlk", publicKey: "TESTKEY-c3BraQ", label: "This browser" };

/** One valid payload per people and remote event type. */
const FIXTURES: Record<PeopleEventType, Record<string, unknown>> = {
  "person.invited": { inviteId: "i1", role: "reviewer", codeHash: HASH, expiresAt: AT },
  "person.invite_revoked": { inviteId: "i1" },
  "person.joined": { personId: "p1", inviteId: "i1", name: "Reviewer One", role: "reviewer", credential: passkey },
  "person.credential_added": { personId: "p1", credential: key },
  "person.credential_removed": { personId: "p1", credentialId: "a2V5LWlk" },
  "person.renamed": { personId: "p1", name: "Ana" },
  "person.role_changed": { personId: "p1", from: "reviewer", to: "maintainer" },
  "person.removed": { personId: "p1" },
  "person.signed_in": { personId: "p1", listener: "remote", method: "passkey" },
  "person.locked": { personId: "p1", until: AT, failures: 5 },
  "remote.enabled": { port: 4318, bind: "0.0.0.0", domain: null, tls: "self_signed", fingerprint: CERT },
  "remote.disabled": {},
  "remote.certificate_changed": { tls: "acme", fingerprint: CERT, domain: "example.org", expiresAt: AT },
};

describe("roles", () => {
  it("ranks the four roles", () => {
    expect(ROLES).toEqual(["viewer", "reviewer", "maintainer", "owner"]);
    expect(ROLE_RANK).toEqual({ viewer: 0, reviewer: 1, maintainer: 2, owner: 3 });
    expect(atLeast("reviewer", "viewer")).toBe(true);
    expect(atLeast("viewer", "reviewer")).toBe(false);
    expect(atLeast("owner", "owner")).toBe(true);
    expect(atLeast("maintainer", "owner")).toBe(false);
  });

  it("labels and describes each role", () => {
    expect(ROLE_LABELS).toEqual({ viewer: "Viewer", reviewer: "Reviewer", maintainer: "Maintainer", owner: "Owner" });
    expect(ROLE_DESCRIPTIONS).toEqual({
      viewer: "Can see the board, every card's story, the ledger, the agent feed and who is here. Cannot change anything.",
      reviewer:
        "Everything a viewer can, plus deciding what agents may do, making plan decisions, moving cards and signing off gates that allow their role.",
      maintainer:
        "Everything a reviewer can, plus starting and stopping agents (on API keys), adding cards, running the intake and giving runs access to connections by name.",
      owner:
        "Everything. Only the Owner manages connections, people, remote access and gate requirements, and only the Owner holds credentials.",
    });
  });

  it("fixes the owner id, the lifetimes and the remote defaults", () => {
    expect(OWNER_ID).toBe("owner");
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(SESSION_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_REMOTE).toEqual({
      enabled: false, port: 4318, bind: "0.0.0.0", domain: null, tls: "self_signed", fingerprint: null, expiresAt: null,
    });
  });
});

describe("names, domains and fingerprints", () => {
  it("trims a name and bounds it to 1..60 characters", () => {
    expect(personNameSchema.parse("  Ana  ")).toBe("Ana");
    expect(personNameSchema.safeParse("   ").success).toBe(false);
    expect(personNameSchema.safeParse("x".repeat(61)).success).toBe(false);
    expect(personNameSchema.safeParse("x".repeat(60)).success).toBe(true);
  });

  it("accepts domain names and refuses IP literals and bare hosts", () => {
    for (const ok of ["tt-test.local", "example.org", "a.b.example.co.uk"]) expect(domainSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["192.168.1.10", "localhost", "a..b", "-a.org", "a.org.", "", "a b.org", "x".repeat(64) + ".org"]) {
      expect(domainSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("matches the colon form of a certificate fingerprint, not Plan 6's key hash", () => {
    expect(CERT_FINGERPRINT.test(CERT)).toBe(true);
    expect(CERT_FINGERPRINT.test("ab".repeat(32))).toBe(false);
    expect(CERT_FINGERPRINT.test(CERT.toLowerCase())).toBe(false);
    expect(CERT_FINGERPRINT.test(`${CERT}:00`)).toBe(false);
  });

  it("exports both fingerprints from the package without a clash", () => {
    expect(shared.CERT_FINGERPRINT).toBe(CERT_FINGERPRINT);
    expect(shared.FINGERPRINT).toBe(FINGERPRINT);
    expect(shared.FINGERPRINT).not.toBe(shared.CERT_FINGERPRINT);
    expect(shared.FINGERPRINT.test("ab".repeat(32))).toBe(true);
  });
});

describe("people and remote payloads", () => {
  const types = Object.keys(FIXTURES) as PeopleEventType[];

  it("has a schema for every people and remote event, in the ledger's map", () => {
    expect(Object.keys(peoplePayloadSchemas).sort()).toEqual([...types].sort());
    for (const t of types) expect(eventPayloadSchemas[t]).toBe(peoplePayloadSchemas[t]);
  });

  it.each(types)("accepts a %s fixture and refuses it with an extra key", (t) => {
    const schema = peoplePayloadSchemas[t];
    expect(schema.safeParse(FIXTURES[t]).error?.issues).toBeUndefined();
    expect(schema.safeParse({ ...FIXTURES[t], extra: 1 }).success).toBe(false);
  });

  it("never makes or unmakes an Owner by a role change, nor a no-op change", () => {
    const s = peoplePayloadSchemas["person.role_changed"];
    expect(s.safeParse({ personId: "p1", from: "reviewer", to: "owner" }).success).toBe(false);
    expect(s.safeParse({ personId: "p1", from: "owner", to: "viewer" }).success).toBe(false);
    expect(s.safeParse({ personId: "p1", from: "viewer", to: "viewer" }).success).toBe(false);
  });

  it("never removes the Owner", () => {
    expect(peoplePayloadSchemas["person.removed"].safeParse({ personId: "owner" }).success).toBe(false);
  });

  it("checks credentials, codes and certificates", () => {
    const joined = peoplePayloadSchemas["person.joined"];
    const base = FIXTURES["person.joined"];
    expect(joined.safeParse({ ...base, credential: { ...passkey, kind: "password" } }).success).toBe(false);
    expect(joined.safeParse({ ...base, credential: { ...passkey, credentialId: "not base64url!" } }).success).toBe(false);
    expect(joined.safeParse({ ...base, credential: { ...passkey, publicKey: "A".repeat(2001) } }).success).toBe(false);
    expect(joined.safeParse({ ...base, credential: { ...passkey, label: "x".repeat(61) } }).success).toBe(false);
    expect(joined.safeParse({ ...base, credential: { ...key, transports: [] } }).success).toBe(false);
    expect(joined.safeParse({ ...base, name: " " }).success).toBe(false);
    const invited = peoplePayloadSchemas["person.invited"];
    expect(invited.safeParse({ ...FIXTURES["person.invited"], codeHash: "a".repeat(63) }).success).toBe(false);
    expect(invited.safeParse({ ...FIXTURES["person.invited"], role: "admin" }).success).toBe(false);
    const enabled = peoplePayloadSchemas["remote.enabled"];
    expect(enabled.safeParse({ ...FIXTURES["remote.enabled"], fingerprint: "ab".repeat(32) }).success).toBe(false);
    expect(enabled.safeParse({ ...FIXTURES["remote.enabled"], domain: "192.168.1.10" }).success).toBe(false);
    expect(enabled.safeParse({ ...FIXTURES["remote.enabled"], port: 0 }).success).toBe(false);
    expect(enabled.safeParse({ ...FIXTURES["remote.enabled"], expiresAt: AT }).success).toBe(true);
    expect(enabled.safeParse({ ...FIXTURES["remote.enabled"], expiresAt: "soon" }).success).toBe(false);
    expect(peoplePayloadSchemas["person.locked"].safeParse({ personId: "p1", until: AT, failures: 0 }).success).toBe(false);
    expect(peoplePayloadSchemas["person.signed_in"].safeParse({ personId: "p1", listener: "lan", method: "key" }).success).toBe(false);
  });
});
