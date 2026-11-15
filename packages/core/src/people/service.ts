import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  INVITE_TTL_MS, OWNER_ID, credentialSchema, personNameSchema, type Actor, type Credential, type Invite, type Listener,
  type NewLedgerEntry, type Person, type Role, type SignInMethod,
} from "@theterminal/shared";
import { NotFoundError } from "../board/board-service.js";
import type { Db } from "../db.js";
import { commitEvent, commitEvents } from "../events/commit.js";
import { findCredential, getInvite, getInviteByHash, getPerson } from "../events/projections.js";
import { RecordedText, SecretInTextError } from "../intake/recorded-text.js";
import { HumanRequiredError } from "../intake/service.js";
import type { Ledger } from "../ledger/ledger.js";
import { LOCKOUT_FAILURES, LOCKOUT_MS, LockedError, type LockoutStore } from "./lockouts.js";
import type { SessionStore } from "./sessions.js";

export { LOCKOUT_FAILURES, LOCKOUT_MS, LockedError };

/** How long the Owner bootstrap invite lives: its link may sit in a container log. */
export const OWNER_INVITE_TTL_MS = 60 * 60 * 1000;

/** → 404 invite_invalid */
export class InviteInvalidError extends Error {
  constructor() {
    super("invite is invalid");
    this.name = "InviteInvalidError";
  }
}
/** → 409 owner_credential_required */
export class OwnerCredentialRequiredError extends Error {
  constructor() {
    super("the Owner needs a credential first");
    this.name = "OwnerCredentialRequiredError";
  }
}
/** → 409 last_credential */
export class LastCredentialError extends Error {
  constructor() {
    super("the last credential cannot be removed");
    this.name = "LastCredentialError";
  }
}
/** → 409 self_change */
export class SelfChangeError extends Error {
  constructor() {
    super("a person cannot change their own role or remove themselves");
    this.name = "SelfChangeError";
  }
}
/** → 409 owner_role */
export class OwnerRoleError extends Error {
  constructor() {
    super("the owner role cannot be given or taken");
    this.name = "OwnerRoleError";
  }
}
/** A credential id that is already registered (to anyone, removed or not). → 409 */
export class CredentialExistsError extends Error {
  constructor() {
    super("this credential is already registered");
    this.name = "CredentialExistsError";
  }
}

export type PeopleServiceDeps = {
  db: Db;
  ledger: Ledger;
  sessions: SessionStore;
  lockouts: LockoutStore;
  /** Refuses names holding a secret; defaults to one with no extra secrets. */
  recorded?: RecordedText;
  newId?: () => string;
  now?: () => Date;
};

const AUTH: Actor = { kind: "system", id: "auth" };
const hashCode = (code: string): string => createHash("sha256").update(code).digest("hex");

function requireHuman(actor: Actor): void {
  if (actor.kind !== "human" || actor.id === "") throw new HumanRequiredError();
}

/**
 * People in the workspace, all through the ledger: invites (only the code's sha256 is recorded), joining, credentials,
 * names, roles and removal, plus sign-ins and lockouts. Who may call what is the routes' to enforce; this service
 * keeps the rules that hold whoever calls (the Owner's role is fixed, nobody changes their own, a person keeps a
 * credential).
 */
export class PeopleService {
  private readonly db: Db;
  private readonly ledger: Ledger;
  private readonly sessions: SessionStore;
  private readonly lockouts: LockoutStore;
  private readonly recorded: RecordedText;
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(deps: PeopleServiceDeps) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.sessions = deps.sessions;
    this.lockouts = deps.lockouts;
    this.recorded = deps.recorded ?? new RecordedText();
    this.newId = deps.newId ?? (() => randomUUID());
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * A new invite and its code (16 random bytes, base64url), shown once. Role `owner` only while no Owner credential
   * exists (the bootstrap invite), and then for one hour at most.
   */
  invite(actor: Actor, role: Role, opts: { ttlMs?: number } = {}): { invite: Invite; code: string } {
    requireHuman(actor);
    if (role === "owner" && this.hasOwnerCredential()) throw new OwnerRoleError();
    const ttlMs = role === "owner" ? Math.min(opts.ttlMs ?? OWNER_INVITE_TTL_MS, OWNER_INVITE_TTL_MS) : (opts.ttlMs ?? INVITE_TTL_MS);
    const code = randomBytes(16).toString("base64url");
    const inviteId = this.newId();
    const expiresAt = new Date(this.now().getTime() + ttlMs).toISOString();
    const invite = commitEvent(this.db, this.ledger, () => ({
      event: { projectId: null, actor, type: "person.invited", payload: { inviteId, role, codeHash: hashCode(code), expiresAt } },
      result: () => getInvite(this.db, inviteId, this.now())!,
    }));
    return { invite, code };
  }

  revokeInvite(actor: Actor, inviteId: string): void {
    requireHuman(actor);
    commitEvent(this.db, this.ledger, () => {
      if (getInvite(this.db, inviteId, this.now())?.status !== "pending") throw new InviteInvalidError();
      return { event: { projectId: null, actor, type: "person.invite_revoked", payload: { inviteId } }, result: () => undefined };
    });
  }

  /** The invite a code opens: InviteInvalidError unless it is pending and unexpired. */
  inviteByCode(code: string): Invite {
    if (typeof code !== "string" || code === "") throw new InviteInvalidError();
    const invite = getInviteByHash(this.db, hashCode(code), this.now());
    if (invite?.status !== "pending") throw new InviteInvalidError();
    return invite;
  }

  /**
   * Uses an invite, in one transaction: `person.joined` by the new person, and the invite becomes used. The bootstrap
   * invite instead gives the Owner (`owner`) the credential and the name, and revokes every pending owner invite,
   * this one included (the entries have no field to mark it used). The route mints the session afterwards.
   */
  join(code: string, name: string, credential: Credential): Person {
    const cleanName = this.name(name);
    const cred = credentialSchema.parse(credential) as Credential;
    const invite = this.inviteByCode(code);
    return commitEvents(this.db, this.ledger, () => {
      // Read again inside the transaction, so two joins with one code cannot both pass.
      if (getInvite(this.db, invite.id, this.now())?.status !== "pending") throw new InviteInvalidError();
      if (this.credentialExists(cred.credentialId)) throw new CredentialExistsError();
      if (invite.role === "owner") {
        if (this.hasOwnerCredential()) throw new InviteInvalidError();
        const ownerActor: Actor = { kind: "human", id: OWNER_ID };
        const pendingOwnerInvites = (
          this.db.prepare("SELECT id FROM invites WHERE role = 'owner' AND status = 'pending' ORDER BY rowid").all() as { id: string }[]
        ).map((r) => r.id);
        const events: NewLedgerEntry[] = [
          { projectId: null, actor: ownerActor, type: "person.credential_added", payload: { personId: OWNER_ID, credential: cred } },
          { projectId: null, actor: ownerActor, type: "person.renamed", payload: { personId: OWNER_ID, name: cleanName } },
          ...pendingOwnerInvites.map((inviteId): NewLedgerEntry => ({
            projectId: null, actor: ownerActor, type: "person.invite_revoked", payload: { inviteId },
          })),
        ];
        return { events, result: () => getPerson(this.db, OWNER_ID)! };
      }
      const personId = this.newId();
      return {
        events: [{
          projectId: null, actor: { kind: "human", id: personId }, type: "person.joined",
          payload: { personId, inviteId: invite.id, name: cleanName, role: invite.role, credential: cred },
        }],
        result: () => getPerson(this.db, personId)!,
      };
    });
  }

  addCredential(actor: Actor, personId: string, credential: Credential): void {
    requireHuman(actor);
    const cred = credentialSchema.parse(credential) as Credential;
    commitEvent(this.db, this.ledger, () => {
      this.requireActivePerson(personId);
      if (this.credentialExists(cred.credentialId)) throw new CredentialExistsError();
      return {
        event: { projectId: null, actor, type: "person.credential_added", payload: { personId, credential: cred } },
        result: () => undefined,
      };
    });
  }

  /** LastCredentialError for anyone's last credential but the Owner's (the Owner still has the token). */
  removeCredential(actor: Actor, personId: string, credentialId: string): void {
    requireHuman(actor);
    commitEvent(this.db, this.ledger, () => {
      this.requireActivePerson(personId);
      const active = this.db
        .prepare("SELECT credential_id FROM credentials WHERE person_id = ? AND removed_at IS NULL")
        .all(personId) as { credential_id: string }[];
      if (!active.some((c) => c.credential_id === credentialId)) throw new NotFoundError("credential", credentialId);
      if (active.length === 1 && personId !== OWNER_ID) throw new LastCredentialError();
      return {
        event: { projectId: null, actor, type: "person.credential_removed", payload: { personId, credentialId } },
        result: () => undefined,
      };
    });
    this.lockouts.clear(credentialId);
  }

  /** SecretInTextError when the name holds a secret. */
  rename(actor: Actor, personId: string, name: string): void {
    requireHuman(actor);
    const cleanName = this.name(name);
    commitEvent(this.db, this.ledger, () => {
      this.requireActivePerson(personId);
      return { event: { projectId: null, actor, type: "person.renamed", payload: { personId, name: cleanName } }, result: () => undefined };
    });
  }

  /** OwnerRoleError for the Owner or to `owner`; SelfChangeError for one's own role. No entry when nothing changes. */
  changeRole(actor: Actor, personId: string, to: Role): void {
    requireHuman(actor);
    if (personId === OWNER_ID || to === "owner") throw new OwnerRoleError();
    if (actor.id === personId) throw new SelfChangeError();
    commitEvent(this.db, this.ledger, () => {
      const person = this.requireActivePerson(personId);
      if (person.role === to) return { result: () => undefined };
      return {
        event: { projectId: null, actor, type: "person.role_changed", payload: { personId, from: person.role, to } },
        result: () => undefined,
      };
    });
  }

  /** Removes a person (kept in history) and revokes every session they hold at once. */
  remove(actor: Actor, personId: string): void {
    requireHuman(actor);
    if (personId === OWNER_ID) throw new OwnerRoleError();
    if (actor.id === personId) throw new SelfChangeError();
    commitEvent(this.db, this.ledger, () => {
      this.requireActivePerson(personId);
      return { event: { projectId: null, actor, type: "person.removed", payload: { personId } }, result: () => undefined };
    });
    this.sessions.revokeAll(personId);
  }

  recordSignIn(personId: string, listener: Listener, method: SignInMethod): void {
    commitEvent(this.db, this.ledger, () => ({
      event: { projectId: null, actor: { kind: "human", id: personId }, type: "person.signed_in", payload: { personId, listener, method } },
      result: () => undefined,
    }));
  }

  /**
   * Counts a failed sign-in for the credential from `source`. Only a credential someone can sign in with is counted
   * (an unknown or removed one makes no lockout entry, so made-up ids cannot fill the store and evict other pairs).
   * When it locks the pair, `person.locked` is recorded for the credential's person (never the address).
   */
  failure(credentialId: string, source: string): void {
    const holder = findCredential(this.db, credentialId);
    if (!holder) return;
    const r = this.lockouts.failure(credentialId, source);
    if (!r.locked || r.until === null) return;
    const until = r.until;
    commitEvent(this.db, this.ledger, () => {
      // Read again inside the transaction: the credential or its person may have been removed meanwhile.
      const current = findCredential(this.db, credentialId);
      if (!current) return { result: () => undefined };
      return {
        event: { projectId: null, actor: AUTH, type: "person.locked", payload: { personId: current.personId, until, failures: r.failures } },
        result: () => undefined,
      };
    });
  }

  /** LockedError while the credential is locked for `source`. */
  assertNotLocked(credentialId: string, source: string): void {
    this.lockouts.assertNotLocked(credentialId, source);
  }

  success(credentialId: string, source: string): void {
    this.lockouts.success(credentialId, source);
  }

  hasOwnerCredential(): boolean {
    return (
      this.db.prepare("SELECT 1 FROM credentials WHERE person_id = ? AND removed_at IS NULL LIMIT 1").get(OWNER_ID) !== undefined
    );
  }

  /** A credential that can sign in, for the routes. */
  findCredential(credentialId: string): (Credential & { personId: string }) | null {
    return findCredential(this.db, credentialId);
  }

  /** A display name: trimmed, 1 to 60 characters, and refused when it holds a secret. Never scrubbed: it is a name. */
  private name(name: string): string {
    const trimmed = personNameSchema.parse(name);
    if (!this.recorded.passes(trimmed)) throw new SecretInTextError();
    return trimmed;
  }

  private credentialExists(credentialId: string): boolean {
    return this.db.prepare("SELECT 1 FROM credentials WHERE credential_id = ?").get(credentialId) !== undefined;
  }

  /** The person, unless unknown or removed (NotFoundError). The Owner always exists. */
  private requireActivePerson(personId: string): Person {
    const person = getPerson(this.db, personId);
    if (!person || person.removedAt !== null) throw new NotFoundError("person", personId);
    return person;
  }
}
