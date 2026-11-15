import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { OWNER_ID, type Credential, type LedgerEntry } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger, LedgerReadOnlyError } from "../../src/ledger/ledger.js";
import { findCredential, getPerson, listCredentials, listPeople } from "../../src/events/projections.js";
import { SecretInTextError } from "../../src/intake/recorded-text.js";
import { HumanRequiredError } from "../../src/intake/service.js";
import { NotFoundError } from "../../src/board/board-service.js";
import { SessionStore } from "../../src/people/sessions.js";
import { LockoutStore } from "../../src/people/lockouts.js";
import {
  CredentialExistsError, InviteInvalidError, LastCredentialError, LockedError, OwnerRoleError, PeopleService, SelfChangeError,
} from "../../src/people/service.js";

const owner = { kind: "human", id: OWNER_ID } as const;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const passkey = (n: number): Credential => ({
  kind: "passkey", credentialId: `cred-${n}`, publicKey: `TESTKEY${n}`, transports: ["internal"], label: `Laptop ${n}`,
});
const keyCred = (n: number): Credential => ({ kind: "key", credentialId: `key-${n}`, publicKey: `TESTKEY${n}`, label: `Key ${n}` });

let db: Db;
let ledger: Ledger;
let sessions: SessionStore;
let lockouts: LockoutStore;
let people: PeopleService;
let t: number;
let ids: number;
const now = () => new Date(t);

beforeEach(() => {
  t = Date.parse("2026-11-15T10:00:00.000Z");
  ids = 0;
  db = openDatabase(":memory:");
  ledger = new Ledger(db, { now });
  sessions = new SessionStore(db, { now });
  lockouts = new LockoutStore({ now });
  people = new PeopleService({ db, ledger, sessions, lockouts, now, newId: () => `id-${++ids}` });
});

const entries = (): LedgerEntry[] => ledger.list({ limit: 500 });
const ofType = (type: string) => entries().filter((e) => e.type === type);

/** Invites a reviewer and joins as them. */
function joinReviewer(name = "Reviewer One", cred: Credential = passkey(1)) {
  const { code } = people.invite(owner, "reviewer");
  return people.join(code, name, cred);
}

describe("PeopleService invites", () => {
  it("records the code's sha256, never the code, and finds the invite by its code", () => {
    const { invite, code } = people.invite(owner, "reviewer");
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const [e] = ofType("person.invited");
    expect(ofType("person.invited")).toHaveLength(1);
    const p = e!.payload as Record<string, unknown>;
    expect(p.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.codeHash).toBe(sha256(code));
    expect(JSON.stringify(entries())).not.toContain(code);
    expect(JSON.stringify(db.prepare("SELECT * FROM invites").all())).not.toContain(code);
    expect(invite).toEqual({
      id: invite.id, role: "reviewer", createdAt: "2026-11-15T10:00:00.000Z", expiresAt: "2026-11-22T10:00:00.000Z", status: "pending",
    });
    expect(people.inviteByCode(code)).toEqual(invite);
  });

  it("an unknown, revoked or expired invite is InviteInvalidError", () => {
    expect(() => people.inviteByCode("nope")).toThrow(InviteInvalidError);
    expect(() => people.inviteByCode(undefined as unknown as string)).toThrow(InviteInvalidError);
    const revoked = people.invite(owner, "viewer");
    people.revokeInvite(owner, revoked.invite.id);
    expect(ofType("person.invite_revoked")).toHaveLength(1);
    expect(() => people.inviteByCode(revoked.code)).toThrow(InviteInvalidError);
    expect(() => people.revokeInvite(owner, revoked.invite.id)).toThrow(InviteInvalidError);
    const short = people.invite(owner, "viewer", { ttlMs: 60_000 });
    t += 60_000;
    expect(() => people.inviteByCode(short.code)).toThrow(InviteInvalidError);
    expect(() => people.join(short.code, "Late", passkey(9))).toThrow(InviteInvalidError);
  });

  it("only a human invites", () => {
    expect(() => people.invite({ kind: "agent", id: "run-1" }, "viewer")).toThrow(HumanRequiredError);
  });
});

describe("PeopleService join", () => {
  it("records person.joined by the new person, lists them after the Owner, and uses the invite once", () => {
    const { invite, code } = people.invite(owner, "reviewer");
    t += 1000;
    const p = people.join(code, "Reviewer One", passkey(1));
    expect(p).toEqual({
      id: p.id, name: "Reviewer One", role: "reviewer", joinedAt: "2026-11-15T10:00:01.000Z", lastSeenAt: null, removedAt: null,
      credentials: 1,
    });
    const [joined] = ofType("person.joined");
    expect(joined!.actor).toEqual({ kind: "human", id: p.id });
    expect(joined!.payload).toMatchObject({ personId: p.id, inviteId: invite.id, name: "Reviewer One", role: "reviewer" });
    expect(listPeople(db).map((x) => x.name)).toEqual(["Owner", "Reviewer One"]);
    expect(db.prepare("SELECT status, used_by FROM invites WHERE id = ?").get(invite.id)).toEqual({ status: "used", used_by: p.id });
    expect(() => people.join(code, "Again", passkey(2))).toThrow(InviteInvalidError);
    expect(listCredentials(db, p.id)).toEqual([passkey(1)]);
  });

  it("refuses a name that holds a secret, and a credential already registered", () => {
    const { code } = people.invite(owner, "reviewer");
    expect(() => people.join(code, "sk-ant-TESTKEY-0000000000", passkey(1))).toThrow(SecretInTextError);
    joinReviewer("Reviewer One", passkey(1));
    const second = people.invite(owner, "viewer");
    expect(() => people.join(second.code, "Viewer", passkey(1))).toThrow(CredentialExistsError);
    expect(people.inviteByCode(second.code).status).toBe("pending");
  });

  it("a read-only ledger fails at join and records nothing", () => {
    const { code } = people.invite(owner, "reviewer");
    ledger.readOnly = true;
    expect(() => people.join(code, "Reviewer One", passkey(1))).toThrow(LedgerReadOnlyError);
    ledger.readOnly = false;
    expect(listPeople(db)).toHaveLength(1);
  });
});

describe("PeopleService Owner bootstrap", () => {
  it("allows an owner invite only while no Owner credential exists, for one hour", () => {
    const { invite } = people.invite(owner, "owner", { ttlMs: 7 * 86_400_000 });
    expect(invite.expiresAt).toBe("2026-11-15T11:00:00.000Z");
    expect(people.hasOwnerCredential()).toBe(false);
  });

  it("joining it adds the Owner's credential and name, with no person.joined, and revokes every other owner invite", () => {
    const first = people.invite(owner, "owner");
    const second = people.invite(owner, "owner");
    const reviewer = people.invite(owner, "reviewer");
    const before = ledger.headSeq();
    const p = people.join(first.code, "Ana", passkey(1));
    expect(p).toMatchObject({ id: OWNER_ID, name: "Ana", role: "owner", credentials: 1 });
    const added = entries().filter((e) => e.seq > before);
    expect(added.map((e) => e.type).sort()).toEqual(
      ["person.credential_added", "person.invite_revoked", "person.invite_revoked", "person.renamed"].sort(),
    );
    expect(ofType("person.joined")).toHaveLength(0);
    expect(new Set(added.map((e) => e.seq)).size).toBe(4);
    expect(() => people.inviteByCode(second.code)).toThrow(InviteInvalidError);
    expect(() => people.inviteByCode(first.code)).toThrow(InviteInvalidError);
    expect(people.inviteByCode(reviewer.code).status).toBe("pending");
    expect(people.hasOwnerCredential()).toBe(true);
    expect(() => people.invite(owner, "owner")).toThrow(OwnerRoleError);
    expect(listPeople(db).map((x) => x.id)).toEqual([OWNER_ID]);
    expect(getPerson(db, OWNER_ID)!.name).toBe("Ana");
  });

  it("lists the Owner once after the Owner's credential_added", () => {
    people.addCredential(owner, OWNER_ID, keyCred(1));
    joinReviewer();
    expect(listPeople(db).map((x) => x.id).filter((id) => id === OWNER_ID)).toHaveLength(1);
    expect(listPeople(db)[0]).toMatchObject({ id: OWNER_ID, name: "Owner", credentials: 1 });
  });
});

describe("PeopleService roles and removal", () => {
  it("changes a role, and refuses the Owner's role and a person's own", () => {
    const p = joinReviewer();
    people.changeRole(owner, p.id, "maintainer");
    expect(ofType("person.role_changed")[0]!.payload).toEqual({ personId: p.id, from: "reviewer", to: "maintainer" });
    expect(getPerson(db, p.id)!.role).toBe("maintainer");
    expect(() => people.changeRole(owner, OWNER_ID, "viewer")).toThrow(OwnerRoleError);
    expect(() => people.changeRole(owner, p.id, "owner")).toThrow(OwnerRoleError);
    expect(() => people.changeRole({ kind: "human", id: p.id }, p.id, "viewer")).toThrow(SelfChangeError);
    expect(() => people.changeRole(owner, "nobody", "viewer")).toThrow(NotFoundError);
    people.changeRole(owner, p.id, "maintainer"); // no change, no entry
    expect(ofType("person.role_changed")).toHaveLength(1);
  });

  it("remove revokes every session of the person at once", () => {
    const p = joinReviewer();
    const a = sessions.create(p.id, "local", "passkey").id;
    const b = sessions.create(p.id, "remote", "passkey").id;
    const mine = sessions.create(OWNER_ID, "local", "passkey").id;
    const revoked: [string, string | null][] = [];
    sessions.onRevoke((id, h) => revoked.push([id, h]));
    expect(() => people.remove({ kind: "human", id: p.id }, p.id)).toThrow(SelfChangeError);
    expect(() => people.remove(owner, OWNER_ID)).toThrow(OwnerRoleError);
    people.remove(owner, p.id);
    expect(sessions.lookup(a, "local")).toBeNull();
    expect(sessions.lookup(b, "remote")).toBeNull();
    expect(sessions.lookup(mine, "local")).not.toBeNull();
    expect(revoked).toEqual([[p.id, null]]);
    expect(getPerson(db, p.id)!.removedAt).toBe("2026-11-15T10:00:00.000Z");
    expect(listPeople(db).map((x) => x.id)).toEqual([OWNER_ID]);
    expect(listPeople(db, { includeRemoved: true }).map((x) => x.id)).toEqual([OWNER_ID, p.id]);
    expect(findCredential(db, "cred-1")).toBeNull();
    expect(() => people.remove(owner, p.id)).toThrow(NotFoundError);
  });
});

describe("PeopleService credentials and names", () => {
  it("refuses removing anyone's last credential, the Owner's included", () => {
    const p = joinReviewer();
    expect(() => people.removeCredential(owner, p.id, "cred-1")).toThrow(LastCredentialError);
    people.addCredential(owner, p.id, keyCred(2));
    expect(findCredential(db, "key-2")).toMatchObject({ kind: "key", personId: p.id });
    people.removeCredential(owner, p.id, "cred-1");
    expect(listCredentials(db, p.id).map((c) => c.credentialId)).toEqual(["key-2"]);
    expect(findCredential(db, "cred-1")).toBeNull();
    expect(() => people.removeCredential(owner, p.id, "cred-1")).toThrow(NotFoundError);

    // The Owner too: on a headless server their credential is the only way in from the network.
    people.addCredential(owner, OWNER_ID, passkey(3));
    expect(() => people.removeCredential(owner, OWNER_ID, "cred-3")).toThrow(LastCredentialError);
    expect(people.hasOwnerCredential()).toBe(true);
    people.addCredential(owner, OWNER_ID, keyCred(4));
    people.removeCredential(owner, OWNER_ID, "cred-3");
    expect(listCredentials(db, OWNER_ID).map((c) => c.credentialId)).toEqual(["key-4"]);
    expect(people.hasOwnerCredential()).toBe(true);
  });

  it("removing a credential clears its lockouts", () => {
    const p = joinReviewer();
    people.addCredential(owner, p.id, keyCred(2));
    for (let i = 0; i < 5; i++) people.failure("key-2", "198.51.100.7");
    expect(() => people.assertNotLocked("key-2", "198.51.100.7")).toThrow(LockedError);
    people.removeCredential(owner, p.id, "key-2");
    expect(() => people.assertNotLocked("key-2", "198.51.100.7")).not.toThrow();
  });

  it("refuses adding a credential twice or to a removed person", () => {
    const p = joinReviewer();
    expect(() => people.addCredential(owner, p.id, passkey(1))).toThrow(CredentialExistsError);
    people.remove(owner, p.id);
    expect(() => people.addCredential(owner, p.id, passkey(5))).toThrow(NotFoundError);
  });

  it("renames, and refuses a name holding a secret", () => {
    const p = joinReviewer();
    people.rename(owner, p.id, "  Reviewer Two ");
    expect(getPerson(db, p.id)!.name).toBe("Reviewer Two");
    expect(() => people.rename(owner, p.id, "sk-ant-TESTKEY-0000000000")).toThrow(SecretInTextError);
    people.rename(owner, OWNER_ID, "Ana");
    expect(getPerson(db, OWNER_ID)!.name).toBe("Ana");
    expect(listPeople(db).map((x) => x.name)).toEqual(["Ana", "Reviewer Two"]);
  });

  it("findCredential of a removed person's credential is null", () => {
    const p = joinReviewer();
    expect(findCredential(db, "cred-1")).toMatchObject({ personId: p.id, credentialId: "cred-1" });
    people.remove(owner, p.id);
    expect(findCredential(db, "cred-1")).toBeNull();
  });
});

describe("PeopleService sign-in and lockouts", () => {
  it("records person.signed_in by that person", () => {
    const p = joinReviewer();
    t += 5000;
    people.recordSignIn(p.id, "remote", "passkey");
    const [e] = ofType("person.signed_in");
    expect(e!.actor).toEqual({ kind: "human", id: p.id });
    expect(e!.payload).toEqual({ personId: p.id, listener: "remote", method: "passkey" });
    expect(getPerson(db, p.id)!.lastSeenAt).toBe("2026-11-15T10:00:05.000Z");
  });

  it("five failures from one address record exactly one person.locked with no address", () => {
    const p = joinReviewer();
    for (let i = 0; i < 6; i++) people.failure("cred-1", "198.51.100.7");
    const locked = ofType("person.locked");
    expect(locked).toHaveLength(1);
    expect(locked[0]!.actor).toEqual({ kind: "system", id: "auth" });
    expect(locked[0]!.payload).toEqual({ personId: p.id, until: "2026-11-15T10:15:00.000Z", failures: 5 });
    expect(JSON.stringify(entries())).not.toContain("198.51.100");
    expect(() => people.assertNotLocked("cred-1", "198.51.100.7")).toThrow(LockedError);
    expect(() => people.assertNotLocked("cred-1", "198.51.100.8")).not.toThrow();
    people.success("cred-1", "198.51.100.8");
  });

  it("failures of an unknown credential create no lockout entry and record nothing", () => {
    for (let i = 0; i < 5; i++) people.failure("ghost", "198.51.100.7");
    expect(ofType("person.locked")).toHaveLength(0);
    expect(() => people.assertNotLocked("ghost", "198.51.100.7")).not.toThrow();
    expect((lockouts as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
  });

  it("failures of a removed credential, or of a removed person's, create no entry and record nothing", () => {
    const p = joinReviewer();
    people.addCredential(owner, p.id, keyCred(2));
    people.removeCredential(owner, p.id, "key-2");
    for (let i = 0; i < 5; i++) people.failure("key-2", "198.51.100.7");
    people.remove(owner, p.id);
    for (let i = 0; i < 5; i++) people.failure("cred-1", "198.51.100.7");
    expect(ofType("person.locked")).toHaveLength(0);
    expect((lockouts as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
  });
});
