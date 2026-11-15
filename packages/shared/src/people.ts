import { z } from "zod";

/**
 * People in a workspace: the four roles, who may do what, the credentials a person signs in with, invitations,
 * remote access, and the ledger entries that record them. The ledger never holds a secret: an invitation records
 * the SHA-256 of its code, a credential its public key, and remote access its certificate's fingerprint.
 */

export const ROLES = ["viewer", "reviewer", "maintainer", "owner"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_RANK: Record<Role, number> = { viewer: 0, reviewer: 1, maintainer: 2, owner: 3 };

/** Whether `role` is `min` or above. */
export function atLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export const ROLE_LABELS: Record<Role, string> = { viewer: "Viewer", reviewer: "Reviewer", maintainer: "Maintainer", owner: "Owner" };
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: "Can see the board, every card's story, the ledger, the agent feed and who is here. Cannot change anything.",
  reviewer:
    "Everything a viewer can, plus deciding what agents may do, making plan decisions, moving cards and signing off gates that allow their role.",
  maintainer:
    "Everything a reviewer can, plus starting and stopping agents (on API keys), adding cards, running the intake and giving runs access to connections by name.",
  owner:
    "Everything. Only the Owner manages connections, people, remote access and gate requirements, and only the Owner holds credentials.",
};

/** The Owner's person id: the human actor id every ledger before Plan 8 already uses. */
export const OWNER_ID = "owner";
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type Listener = "local" | "remote";
export type SignInMethod = "token" | "passkey" | "key";
export type Credential =
  /** `credentialId` base64url; `publicKey` base64url of the COSE key bytes, as `@simplewebauthn/server` returns them. */
  | { kind: "passkey"; credentialId: string; publicKey: string; transports: string[]; label: string }
  /** `credentialId` = base64url(sha256(publicKey)); `publicKey` base64url of the SPKI DER. */
  | { kind: "key"; credentialId: string; publicKey: string; label: string };

/** Who is making a request. Lives here so presence needs no core import; the server's auth module re-exports it. */
export type Principal = {
  personId: string;
  name: string;
  role: Role;
  listener: Listener;
  method: SignInMethod;
  sessionId: string | null;
};
export type Person = {
  id: string;
  name: string;
  role: Role;
  joinedAt: string | null;
  lastSeenAt: string | null;
  removedAt: string | null;
  credentials: number;
};
export type PersonWithCredentials = Person & { credentialList: Omit<Credential, "publicKey">[] };
/** Role `owner` only for the bootstrap invite. */
export type Invite = { id: string; role: Role; createdAt: string; expiresAt: string; status: "pending" | "used" | "revoked" | "expired" };
export type Me = {
  personId: string;
  name: string;
  role: Role;
  listener: Listener;
  method: SignInMethod;
  credentials: Omit<Credential, "publicKey">[];
  sessions: { id: string; listener: Listener; createdAt: string; lastSeenAt: string; current: boolean }[];
};

export type TlsMode = "self_signed" | "acme" | "provided";
export type RemoteState = {
  enabled: boolean;
  port: number;
  bind: string;
  domain: string | null;
  tls: TlsMode;
  fingerprint: string | null;
  expiresAt: string | null;
};
export const DEFAULT_REMOTE: RemoteState = {
  enabled: false,
  port: 4318,
  bind: "0.0.0.0",
  domain: null,
  tls: "self_signed",
  fingerprint: null,
  expiresAt: null,
};

export const personNameSchema = z.string().trim().min(1).max(60);
/** A DNS name with at least two labels whose last is letters only, so never an IP literal or a bare host. */
export const domainSchema = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i);
/**
 * A certificate's SHA-256 fingerprint in colon form (`AB:CD:…`, 32 pairs). Not `FINGERPRINT`: that is the link
 * module's SPKI hash, and both modules are re-exported from the package index.
 */
export const CERT_FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;

const id = z.string().min(1).max(200);
const role = z.enum(ROLES);
const base64url = z.string().min(1).max(2000).regex(/^[A-Za-z0-9_-]+$/);
const label = z.string().min(1).max(60);
const tls = z.enum(["self_signed", "acme", "provided"]);
const fingerprint = z.string().regex(CERT_FINGERPRINT);

export const credentialSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("passkey"),
      credentialId: base64url,
      publicKey: base64url,
      transports: z.array(z.string().min(1).max(32)).max(10),
      label,
    })
    .strict(),
  z.object({ kind: z.literal("key"), credentialId: base64url, publicKey: base64url, label }).strict(),
]);

/** The people and remote-access ledger entries. */
export const peoplePayloadSchemas = {
  "person.invited": z
    .object({ inviteId: id, role, codeHash: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: z.iso.datetime() })
    .strict(),
  "person.invite_revoked": z.object({ inviteId: id }).strict(),
  "person.joined": z
    .object({ personId: id, inviteId: id, name: personNameSchema, role, credential: credentialSchema })
    .strict(),
  "person.credential_added": z.object({ personId: id, credential: credentialSchema }).strict(),
  "person.credential_removed": z.object({ personId: id, credentialId: base64url }).strict(),
  "person.renamed": z.object({ personId: id, name: personNameSchema }).strict(),
  "person.role_changed": z
    .object({ personId: id, from: role, to: role })
    .strict()
    .superRefine((p, ctx) => {
      if (p.from === "owner" || p.to === "owner") {
        ctx.addIssue({ code: "custom", message: "the Owner's role never changes, and nobody becomes the Owner", path: ["to"] });
      }
      if (p.from === p.to) ctx.addIssue({ code: "custom", message: "the role must change", path: ["to"] });
    }),
  "person.removed": z
    .object({ personId: id })
    .strict()
    .superRefine((p, ctx) => {
      if (p.personId === OWNER_ID) ctx.addIssue({ code: "custom", message: "the Owner cannot be removed", path: ["personId"] });
    }),
  "person.signed_in": z
    .object({ personId: id, listener: z.enum(["local", "remote"]), method: z.enum(["token", "passkey", "key"]) })
    .strict(),
  "person.locked": z.object({ personId: id, until: z.iso.datetime(), failures: z.number().int().min(1) }).strict(),
  "remote.enabled": z
    .object({
      port: z.number().int().min(1).max(65535),
      bind: z.string().max(45),
      domain: domainSchema.nullable(),
      tls,
      fingerprint,
    })
    .strict(),
  "remote.disabled": z.object({}).strict(),
  "remote.certificate_changed": z
    .object({ tls, fingerprint, domain: domainSchema.nullable(), expiresAt: z.iso.datetime() })
    .strict(),
} satisfies Record<string, z.ZodType>;

export type PeopleEventType = keyof typeof peoplePayloadSchemas;
