import { describe, expect, it } from "vitest";
import type { LedgerEntry, Principal } from "@theterminal/shared";
import { trimForRole } from "../../src/ledger/trim.js";

const principal = (personId: string, role: Principal["role"]): Principal =>
  ({ personId, name: personId, role, listener: "local", method: "passkey", sessionId: null });
const entry = (type: string, payload: unknown): LedgerEntry =>
  ({ seq: 1, ts: "2026-11-15T00:00:00.000Z", projectId: null, actor: { kind: "human", id: "owner" }, type, payload, hash: "h", prevHash: null } as unknown as LedgerEntry);

const added = entry("connection.added", {
  connectionId: "c1", kind: "github", provider: "github", name: "GitHub", config: { repo: "club/site" }, secretFields: ["token"], privateFields: ["note"],
});
const updated = entry("connection.updated", {
  connectionId: "c1", name: "GitHub", changes: { name: "Hub", config: { repo: "club/other" }, enabled: false, secretsSet: ["token"], privateRemoved: ["note"] },
});

describe("trimForRole", () => {
  it.each(["viewer", "reviewer", "maintainer"] as const)("for a %s drops config, secret names and private names from connection entries", (role) => {
    const p = principal(`p-${role}`, role);
    expect(trimForRole(added, p).payload).toEqual({ connectionId: "c1", kind: "github", provider: "github", name: "GitHub" });
    expect(trimForRole(updated, p).payload).toEqual({
      connectionId: "c1", name: "GitHub", changes: { name: "Hub", enabled: false, secretsSet: ["token"], privateRemoved: ["note"] },
    });
    expect(JSON.stringify(trimForRole(added, p))).not.toMatch(/config|secretFields|privateFields|club/);
  });

  it("leaves the Owner's entries whole, and never changes the entry it was given", () => {
    const owner = principal("owner", "owner");
    expect(trimForRole(added, owner)).toBe(added);
    expect(trimForRole(updated, owner)).toBe(updated);
    const copy = JSON.parse(JSON.stringify(added)) as LedgerEntry;
    trimForRole(added, principal("v", "viewer"));
    expect(added).toEqual(copy);
  });

  it("fails closed with no principal, and leaves other entries alone", () => {
    expect(trimForRole(added, null).payload).toEqual({ connectionId: "c1", kind: "github", provider: "github", name: "GitHub" });
    const other = entry("project.created", { projectId: "p", name: "N", pitch: "config: yes" });
    expect(trimForRole(other, principal("v", "viewer"))).toBe(other);
    const removed = entry("connection.removed", { connectionId: "c1", name: "GitHub" });
    expect(trimForRole(removed, principal("v", "viewer"))).toBe(removed);
    const odd = entry("connection.added", "not an object");
    expect(trimForRole(odd, principal("v", "viewer"))).toBe(odd);
  });
});
