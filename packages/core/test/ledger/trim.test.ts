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
  connectionId: "c1", name: "GitHub",
  changes: { name: "Hub", config: { repo: "club/other" }, enabled: false, secretsSet: ["token"], secretsRemoved: ["old"], privateSet: ["note"], privateRemoved: ["path"] },
});
const tested = entry("connection.tested", { connectionId: "c1", name: "GitHub", ok: true, message: "Connected (scopes: repo, workflow)" });
const paired = entry("machine.paired", {
  machineId: "m1", name: "GPU box", publicKey: "pk", fingerprint: "ab:cd", address: "192.168.1.20:4317", role: "entered_code",
});
const remoteOn = entry("remote.enabled", { port: 4318, bind: "192.168.1.5", domain: null, tls: "self_signed", fingerprint: "ab:cd" });

const ROLES = ["viewer", "reviewer", "maintainer"] as const;

describe("trimForRole", () => {
  it.each(ROLES)("for a %s drops config, secret names and private names from connection entries, and which secret or private fields changed", (role) => {
    const p = principal(`p-${role}`, role);
    expect(trimForRole(added, p).payload).toEqual({ connectionId: "c1", kind: "github", provider: "github", name: "GitHub" });
    expect(trimForRole(updated, p).payload).toEqual({ connectionId: "c1", name: "GitHub", changes: { name: "Hub", enabled: false } });
    expect(JSON.stringify(trimForRole(added, p))).not.toMatch(/config|secretFields|privateFields|club/);
    expect(JSON.stringify(trimForRole(updated, p))).not.toMatch(/config|secrets|private|token|old|note|path|club/);
  });

  it.each(ROLES)("for a %s drops the test message, a paired machine's address and the remote listener's bind", (role) => {
    const p = principal(`p-${role}`, role);
    expect(trimForRole(tested, p).payload).toEqual({ connectionId: "c1", name: "GitHub", ok: true });
    expect(trimForRole(paired, p).payload).toEqual({ machineId: "m1", name: "GPU box", publicKey: "pk", fingerprint: "ab:cd", role: "entered_code" });
    expect(trimForRole(remoteOn, p).payload).toEqual({ port: 4318, domain: null, tls: "self_signed", fingerprint: "ab:cd" });
    expect(JSON.stringify([trimForRole(tested, p), trimForRole(paired, p), trimForRole(remoteOn, p)])).not.toMatch(/scopes|192\.168|address|bind/);
  });

  it("leaves the Owner's entries whole, and never changes the entry it was given", () => {
    const owner = principal("owner", "owner");
    for (const e of [added, updated, tested, paired, remoteOn]) expect(trimForRole(e, owner)).toBe(e);
    const copies = [added, updated, tested, paired, remoteOn].map((e) => JSON.parse(JSON.stringify(e)) as LedgerEntry);
    for (const e of [added, updated, tested, paired, remoteOn]) trimForRole(e, principal("v", "viewer"));
    expect([added, updated, tested, paired, remoteOn]).toEqual(copies);
  });

  it("fails closed with no principal, and leaves other entries alone", () => {
    expect(trimForRole(added, null).payload).toEqual({ connectionId: "c1", kind: "github", provider: "github", name: "GitHub" });
    expect(trimForRole(paired, null).payload).not.toHaveProperty("address");
    const other = entry("project.created", { projectId: "p", name: "N", pitch: "config: yes" });
    expect(trimForRole(other, principal("v", "viewer"))).toBe(other);
    const removed = entry("connection.removed", { connectionId: "c1", name: "GitHub" });
    expect(trimForRole(removed, principal("v", "viewer"))).toBe(removed);
    const unpaired = entry("machine.unpaired", { machineId: "m1", name: "GPU box" });
    expect(trimForRole(unpaired, principal("v", "viewer"))).toBe(unpaired);
    const remoteOff = entry("remote.disabled", {});
    expect(trimForRole(remoteOff, principal("v", "viewer"))).toBe(remoteOff);
    const odd = entry("connection.added", "not an object");
    expect(trimForRole(odd, principal("v", "viewer"))).toBe(odd);
    const oddChanges = entry("connection.updated", { connectionId: "c1", name: "GitHub", changes: "nope" });
    expect(trimForRole(oddChanges, principal("v", "viewer"))).toBe(oddChanges);
  });

  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const folderSource = entry("project.source_set", { projectId: "p1", kind: "folder", path: "/Users/someone/my-folder", syncedCommit: SHA });
  const githubSource = entry("project.source_set", { projectId: "p1", kind: "github", repo: "club/site", branch: "main", remoteCommit: SHA, syncedCommit: SHA });

  it.each(ROLES)("for a %s drops the folder path of a project.source_set", (role) => {
    const p = principal(`p-${role}`, role);
    expect(trimForRole(folderSource, p).payload).toEqual({ projectId: "p1", kind: "folder", syncedCommit: SHA });
    expect(JSON.stringify(trimForRole(folderSource, p))).not.toContain("my-folder");
    expect(trimForRole(githubSource, p)).toBe(githubSource);
  });

  it("keeps the folder path for the Owner, and drops it with no principal", () => {
    expect(trimForRole(folderSource, principal("owner", "owner"))).toBe(folderSource);
    expect(trimForRole(folderSource, null).payload).not.toHaveProperty("path");
    expect((folderSource.payload as { path: string }).path).toBe("/Users/someone/my-folder");
  });
});
