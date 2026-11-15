import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_ID, type Credential, type LedgerEntry } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { SessionStore } from "../../src/people/sessions.js";
import { LockoutStore } from "../../src/people/lockouts.js";
import { PeopleService } from "../../src/people/service.js";
import {
  BOOTSTRAP_INVITE_FILE, announceBootstrapInvite, issueBootstrapInvite, remoteJoinUrl, watchBootstrapInvite,
} from "../../src/server/bootstrap-invite.js";

const passkey: Credential = { kind: "passkey", credentialId: "cred-1", publicKey: "TESTKEY1", transports: ["internal"], label: "Laptop" };

let db: Db;
let ledger: Ledger;
let people: PeopleService;
let dataDir: string;
let t: number;
const now = () => new Date(t);
const urlFor = (code: string) => `https://192.0.2.10:4318/join/${code}#fp=AA:BB`;
const file = () => join(dataDir, BOOTSTRAP_INVITE_FILE);
const ofType = (type: string): LedgerEntry[] => ledger.list({ limit: 500 }).filter((e) => e.type === type);
const issue = () => issueBootstrapInvite({ db, people, dataDir, urlFor, now });

beforeEach(() => {
  t = Date.parse("2026-11-15T10:00:00.000Z");
  db = openDatabase(":memory:");
  ledger = new Ledger(db, { now });
  people = new PeopleService({ db, ledger, sessions: new SessionStore(db, { now }), lockouts: new LockoutStore({ now }), now });
  dataDir = mkdtempSync(join(tmpdir(), "tt-bootstrap-"));
});

describe("the Owner bootstrap invite", () => {
  it("issues one owner invite for an hour, by the Owner's actor, and writes its link to a 0600 file", () => {
    const url = issue();
    expect(url).toMatch(/^https:\/\/192\.0\.2\.10:4318\/join\/[A-Za-z0-9_-]{22}#fp=AA:BB$/);
    const invited = ofType("person.invited");
    expect(invited).toHaveLength(1);
    expect(invited[0]!.actor).toEqual({ kind: "human", id: OWNER_ID });
    const payload = invited[0]!.payload as { role: string; expiresAt: string };
    expect(payload.role).toBe("owner");
    expect(Date.parse(payload.expiresAt) - t).toBe(60 * 60 * 1000);
    expect(readFileSync(file(), "utf8")).toBe(`${url}\n`);
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600);
    // The code itself is never recorded, only its hash.
    const code = url!.split("/join/")[1]!.split("#")[0]!;
    expect(JSON.stringify(ledger.list({ limit: 500 }))).not.toContain(code);
    expect(readdirSync(dataDir)).toEqual([BOOTSTRAP_INVITE_FILE]);
  });

  it("a second start before anyone joined revokes the first invite and issues a new one", () => {
    const first = issue()!;
    const second = issue()!;
    expect(second).not.toBe(first);
    expect(ofType("person.invited")).toHaveLength(2);
    const revoked = ofType("person.invite_revoked");
    expect(revoked).toHaveLength(1);
    expect((revoked[0]!.payload as { inviteId: string }).inviteId).toBe((ofType("person.invited")[0]!.payload as { inviteId: string }).inviteId);
    expect(() => people.inviteByCode(first.split("/join/")[1]!.split("#")[0]!)).toThrow();
    expect(readFileSync(file(), "utf8")).toBe(`${second}\n`);
  });

  it("an expired invite is not revoked again, and a new one is issued", () => {
    issue();
    t += 2 * 60 * 60 * 1000;
    expect(issue()).not.toBeNull();
    expect(ofType("person.invite_revoked")).toHaveLength(0);
  });

  it("once the Owner has a credential nothing is issued and the file is removed", () => {
    const url = issue()!;
    people.join(url.split("/join/")[1]!.split("#")[0]!, "Owner", passkey);
    writeFileSync(file(), "left over\n");
    expect(issue()).toBeNull();
    expect(existsSync(file())).toBe(false);
    expect(ofType("person.invited")).toHaveLength(1);
  });

  it("watching the ledger removes the file as soon as the Owner joins", () => {
    const stop = watchBootstrapInvite(ledger, dataDir);
    const url = issue()!;
    people.invite({ kind: "human", id: OWNER_ID }, "reviewer");
    expect(existsSync(file())).toBe(true);
    people.join(url.split("/join/")[1]!.split("#")[0]!, "Owner", passkey);
    expect(existsSync(file())).toBe(false);
    stop();
  });

  it("replaces an existing file with a looser mode and keeps it 0600", () => {
    writeFileSync(file(), "old\n", { mode: 0o644 });
    const url = issue();
    expect(readFileSync(file(), "utf8")).toBe(`${url}\n`);
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600);
  });
});

describe("announcing the bootstrap invite at startup", () => {
  const FP = "AB:".repeat(31) + "AB";
  const on = { enabled: true, listening: true, port: 4318, bind: "0.0.0.0", domain: null, addresses: ["192.0.2.10"], fingerprint: FP };

  it("builds the join link from the domain, else the first address, else the bind, with the fingerprint", () => {
    expect(remoteJoinUrl(on, "CODE")).toBe(`https://192.0.2.10:4318/join/CODE#fp=${FP}`);
    expect(remoteJoinUrl({ ...on, domain: "tt.example.org" }, "CODE")).toBe(`https://tt.example.org:4318/join/CODE#fp=${FP}`);
    expect(remoteJoinUrl({ ...on, addresses: [], bind: "2001:db8::1" }, "CODE")).toBe(`https://[2001:db8::1]:4318/join/CODE#fp=${FP}`);
  });

  it("calls bootstrapInvite once with the link while remote access listens and nobody owns the workspace", () => {
    const seen: string[] = [];
    announceBootstrapInvite({ db, people, dataDir, now, remote: on, bootstrapInvite: (u) => seen.push(u) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(new RegExp(`^https://192\\.0\\.2\\.10:4318/join/[A-Za-z0-9_-]{22}#fp=${FP}$`));
    expect(readFileSync(file(), "utf8")).toBe(`${seen[0]}\n`);
  });

  it("issues nothing while remote access is off, not listening or has no certificate", () => {
    const seen: string[] = [];
    for (const remote of [null, { ...on, enabled: false }, { ...on, listening: false }, { ...on, fingerprint: null }]) {
      announceBootstrapInvite({ db, people, dataDir, now, remote, bootstrapInvite: (u) => seen.push(u) });
    }
    expect(seen).toEqual([]);
    expect(ofType("person.invited")).toHaveLength(0);
    expect(existsSync(file())).toBe(false);
  });

  it("after the Owner joined: never calls bootstrapInvite and removes a leftover file, even with remote access off", () => {
    const url = issue()!;
    people.join(url.split("/join/")[1]!.split("#")[0]!, "Owner", passkey);
    writeFileSync(file(), "left over\n");
    const seen: string[] = [];
    announceBootstrapInvite({ db, people, dataDir, now, remote: null, bootstrapInvite: (u) => seen.push(u) });
    expect(existsSync(file())).toBe(false);
    announceBootstrapInvite({ db, people, dataDir, now, remote: on, bootstrapInvite: (u) => seen.push(u) });
    expect(seen).toEqual([]);
  });
});
