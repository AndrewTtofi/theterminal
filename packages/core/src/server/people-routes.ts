import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { OWNER_ID, personNameSchema, type Credential, type Listener, type Me, type Principal, type SignInMethod } from "@theterminal/shared";
import type { Db } from "../db.js";
import { getPerson, listCredentials, listInvites, listPeople } from "../events/projections.js";
import { RecordedText, SecretInTextError } from "../intake/recorded-text.js";
import type { Ledger } from "../ledger/ledger.js";
import type { ChallengeStore } from "../people/challenges.js";
import { keyCredentialId, verifyKeyLogin } from "../people/ed25519.js";
import { LockedError } from "../people/lockouts.js";
import {
  CredentialExistsError,
  InviteInvalidError,
  LastCredentialError,
  OwnerCredentialRequiredError,
  OwnerRoleError,
  SelfChangeError,
  type PeopleService,
} from "../people/service.js";
import type { SessionStore } from "../people/sessions.js";
import {
  InvalidCredentialError,
  authenticationOptions,
  challengeOf,
  registrationOptions,
  rpFor,
  verifyAuthentication,
  verifyRegistration,
  type Rp,
} from "../people/webauthn.js";
import { NotFoundError } from "../board/board-service.js";
import { APP_HOST, SESSION_COOKIE, actorOf, clientKey, sessionCookieOptions } from "./auth.js";
import type { RemoteView } from "./remote.js";
import { sendError } from "./routes.js";
import type { Throttle } from "./throttle.js";

export type PeopleRoutesDeps = {
  db: Db;
  ledger: Ledger;
  service: PeopleService;
  sessions: SessionStore;
  challenges: ChallengeStore;
  /** The auth throttle (AUTH_THROTTLE), shared with the rest of the server. */
  throttle: Throttle;
  /** The local listener's port, read per request. */
  port: () => number;
  /** The remote listener's state, or null while there is none: invite links then point at the local listener. */
  remote: () => RemoteView | null;
  /** Refuses credential labels holding a secret, like names. */
  recorded?: RecordedText;
  now?: () => Date;
};

/** Every sign-in or registration that fails, for whatever reason. Never says which check failed. */
const INVALID = { error: "invalid_credential" } as const;
const LABEL_MAX = 60;

// The routes' own fixed codes; anything else goes to the shared map.
function sendPeopleError(err: unknown, reply: FastifyReply): FastifyReply | null {
  if (err instanceof InviteInvalidError) return reply.code(404).send({ error: "invite_invalid" });
  if (err instanceof InvalidCredentialError) return reply.code(401).send(INVALID);
  if (err instanceof LockedError) return reply.code(423).send({ error: "locked", retryAfterS: err.retryAfterS });
  if (err instanceof LastCredentialError) return reply.code(409).send({ error: "last_credential" });
  if (err instanceof SelfChangeError) return reply.code(409).send({ error: "self_change" });
  if (err instanceof OwnerRoleError) return reply.code(409).send({ error: "owner_role" });
  if (err instanceof OwnerCredentialRequiredError) {
    return reply.code(409).send({ error: "owner_credential_required" });
  }
  if (err instanceof CredentialExistsError) return reply.code(409).send({ error: "credential_exists" });
  return null;
}

const b64 = z.string().min(1).max(2000);
const label = z.string().max(500).optional();
const nameBody = z.object({ name: z.string().max(500) }).strict();
const passkeyJoinBody = z.object({ name: z.string().max(500), label, response: z.unknown() }).strict();
const keyJoinBody = z.object({ name: z.string().max(500), label, publicKey: b64, challenge: b64, signature: b64 }).strict();
const passkeyAddBody = z.object({ label, response: z.unknown() }).strict();
const keyAddBody = z.object({ label, publicKey: b64, challenge: b64, signature: b64 }).strict();
const passkeyLoginBody = z.object({ response: z.unknown() }).strict();
const keyLoginBody = z.object({ publicKey: b64, challenge: b64, signature: b64 }).strict();
const roleBody = z.object({ role: z.enum(["viewer", "reviewer", "maintainer", "owner"]) }).strict();
const emptyBody = z.object({}).strict().optional();

type Code = { Params: { code: string } };
type Id = { Params: { id: string } };

/**
 * Invites, joining, signing in and people management (`/api/people*`, `/api/me*`, `/api/join/*`, `/api/auth/*`).
 * An encapsulated plugin with its own error handler, so routes.ts's map stays as it is. The auth hook's role table
 * guards every route; the join and auth routes are public and throttled per client (an IPv4 address or an IPv6
 * /64). Every verify route runs in one order: the lockout for this credential and address, then the challenge is
 * used up, then the signature is checked; any failure is 401 `invalid_credential` and counts against a known
 * credential. Nothing here returns an invite code after creation, a session id or an address.
 */
export function registerPeopleRoutes(app: FastifyInstance, deps: PeopleRoutesDeps): void {
  const { db, ledger, service, sessions, challenges, throttle } = deps;
  const recorded = deps.recorded ?? new RecordedText();
  const now = deps.now ?? (() => new Date());

  const principal = (request: FastifyRequest): Principal => {
    if (!request.principal) throw new Error("people routes: no principal"); // the auth hook guarantees one
    return request.principal;
  };
  const client = (request: FastifyRequest): string => clientKey(request.ip);
  const host = (request: FastifyRequest): string => request.headers.host ?? "";

  const meOf = (personId: string, listener: Listener, method: SignInMethod, sessionId: string | null): Me => {
    const person = getPerson(db, personId)!;
    // Sessions are listed by the first 8 hex characters of their id's sha256; the id itself never leaves the cookie.
    const currentPrefix = sessionId === null ? null : createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
    return {
      personId,
      name: person.name,
      role: person.role,
      listener,
      method,
      credentials: listCredentials(db, personId).map(({ publicKey: _p, ...rest }) => rest),
      sessions: sessions.list(personId).map((s) => ({
        id: s.idHashPrefix, listener: s.listener, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.idHashPrefix === currentPrefix,
      })),
    };
  };
  const meOfRequest = (request: FastifyRequest): Me => {
    const p = principal(request);
    return meOf(p.personId, p.listener, p.method, p.sessionId);
  };

  /** Mints the session on the listener the request came in on, records the sign-in and answers `Me` with the cookie. */
  const signIn = (request: FastifyRequest, reply: FastifyReply, personId: string, method: SignInMethod, code: number) => {
    const listener = request.listener;
    service.recordSignIn(personId, listener, method);
    const { id } = sessions.create(personId, listener, method);
    reply.setCookie(SESSION_COOKIE, id, sessionCookieOptions(listener));
    return reply.code(code).send(meOf(personId, listener, method, id));
  };

  const cleanLabel = (given: string | undefined, fallback: string): string => {
    // eslint-disable-next-line no-control-regex
    const cleaned = (given ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX).trim();
    if (cleaned === "") return fallback;
    if (!recorded.passes(cleaned)) throw new SecretInTextError();
    return cleaned;
  };

  /** The challenge a passkey response answers, used up for `scope` before anything is verified. */
  const burnPasskeyChallenge = (response: unknown, scope: string): string => {
    const challenge = challengeOf(response);
    if (challenge === null || !challenges.consume(challenge, scope)) throw new InvalidCredentialError();
    return challenge;
  };
  const burnChallenge = (challenge: string, scope: string): void => {
    if (!challenges.consume(challenge, scope)) throw new InvalidCredentialError();
  };
  const idOfKey = (publicKey: string): string => {
    try {
      return keyCredentialId(publicKey);
    } catch {
      throw new InvalidCredentialError();
    }
  };
  const requireRp = (request: FastifyRequest, reply: FastifyReply): Rp | null => {
    const rp = rpFor(request);
    if (rp === null) void reply.code(409).send({ error: "passkeys_unavailable" });
    return rp;
  };
  const writable = (reply: FastifyReply): boolean => {
    if (!ledger.readOnly) return true;
    void reply.code(423).send({ error: "ledger_read_only" });
    return false;
  };
  const passkeyCredential = (cred: Credential, given: string | undefined): Credential => ({ ...cred, label: cleanLabel(given, "Passkey") });
  const keyCredential = (publicKey: string, given: string | undefined): Credential => ({
    kind: "key", credentialId: idOfKey(publicKey), publicKey, label: cleanLabel(given, "Key"),
  });
  const startCounter = (cred: Credential): void => {
    if (cred.kind !== "passkey") return;
    db.prepare("INSERT OR REPLACE INTO credential_state (credential_id, counter) VALUES (?, 0)").run(cred.credentialId);
  };
  const counterOf = (credentialId: string): number =>
    (db.prepare("SELECT counter FROM credential_state WHERE credential_id = ?").get(credentialId) as { counter: number } | undefined)?.counter ?? 0;

  /**
   * A sign-in attempt for `credentialId` from this client: refused while the pair is locked; any failure in `attempt`
   * counts against the credential (only a known one is counted) and answers 401.
   */
  const attempt = async <T>(request: FastifyRequest, credentialId: string, run: () => Promise<T> | T): Promise<T> => {
    const source = client(request);
    service.assertNotLocked(credentialId, source);
    try {
      const out = await run();
      service.success(credentialId, source);
      return out;
    } catch (err) {
      if (err instanceof InvalidCredentialError) service.failure(credentialId, source);
      throw err;
    }
  };

  void app.register(async (scope) => {
    scope.setErrorHandler((err, _req, reply) => sendPeopleError(err, reply) ?? sendError(err, reply, scope.log));

    // Every public route here is throttled per client, before anything else runs.
    scope.addHook("onRequest", async (request, reply) => {
      const url = request.routeOptions.url ?? "";
      if (!url.startsWith("/api/join/") && !url.startsWith("/api/auth/")) return;
      const r = throttle.hit(client(request));
      if (!r.allowed) return reply.code(429).send({ error: "rate_limited", retryAfterS: r.retryAfterS });
    });

    // --- the caller's own account (viewer) ---

    scope.get("/api/me", async (request) => meOfRequest(request));

    scope.patch("/api/me", async (request) => {
      const { name } = nameBody.parse(request.body);
      service.rename(actorOf(request), principal(request).personId, name);
      return meOfRequest(request);
    });

    scope.post("/api/me/sign-out", async (request, reply) => {
      const p = principal(request);
      if (p.sessionId !== null) sessions.revoke(p.sessionId);
      reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(request.listener));
      return reply.code(204).send();
    });

    scope.post("/api/me/credentials/passkey/options", async (request, reply) => {
      emptyBody.parse(request.body ?? undefined);
      const rp = requireRp(request, reply);
      if (rp === null) return reply;
      const p = principal(request);
      const challenge = challenges.issue(`me:${p.personId}`, client(request));
      return registrationOptions(rp, { id: p.personId, name: p.name }, listCredentials(db, p.personId), challenge);
    });

    scope.post("/api/me/credentials/passkey/verify", async (request, reply) => {
      const body = passkeyAddBody.parse(request.body);
      const rp = requireRp(request, reply);
      if (rp === null) return reply;
      const p = principal(request);
      const challenge = burnPasskeyChallenge(body.response, `me:${p.personId}`);
      const cred = passkeyCredential(await verifyRegistration(rp, challenge, body.response), body.label);
      service.addCredential(actorOf(request), p.personId, cred);
      startCounter(cred);
      return reply.code(201).send(meOfRequest(request));
    });

    scope.post("/api/me/credentials/key/challenge", async (request) => {
      emptyBody.parse(request.body ?? undefined);
      return { challenge: challenges.issue(`me:${principal(request).personId}`, client(request)) };
    });

    scope.post("/api/me/credentials/key", async (request, reply) => {
      const body = keyAddBody.parse(request.body);
      const p = principal(request);
      burnChallenge(body.challenge, `me:${p.personId}`);
      if (!verifyKeyLogin({ publicKey: body.publicKey, challenge: body.challenge, host: host(request), signature: body.signature })) {
        throw new InvalidCredentialError();
      }
      service.addCredential(actorOf(request), p.personId, keyCredential(body.publicKey, body.label));
      return reply.code(201).send(meOfRequest(request));
    });

    scope.delete<Id>("/api/me/credentials/:id", async (request, reply) => {
      service.removeCredential(actorOf(request), principal(request).personId, request.params.id);
      db.prepare("DELETE FROM credential_state WHERE credential_id = ?").run(request.params.id);
      return reply.code(204).send();
    });

    scope.delete<{ Params: { prefix: string } }>("/api/me/sessions/:prefix", async (request, reply) => {
      if (!sessions.revokeByHashPrefix(principal(request).personId, request.params.prefix)) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(204).send();
    });

    // --- people (viewer reads; the Owner manages) ---

    scope.get("/api/people", async () => listPeople(db));

    scope.get("/api/people/invites", async () => listInvites(db, now()).filter((i) => i.status === "pending"));

    scope.post("/api/people/invites", async (request, reply) => {
      const { role } = roleBody.parse(request.body);
      // The Owner identity is claimed only through the bootstrap invite the server itself prints.
      if (role === "owner") throw new OwnerRoleError();
      const { invite, code } = service.invite(actorOf(request), role);
      const remote = deps.remote();
      // Only a listener that is up names an address: its real addresses, never the wildcard it binds.
      const on = remote !== null && remote.enabled && remote.listening && remote.fingerprint !== null;
      const fingerprint = on ? remote.fingerprint : null;
      const url = on
        ? `https://${remote.domain ?? bracket(remote.addresses[0] ?? remote.bind)}:${remote.port}/join/${code}#fp=${remote.fingerprint}`
        : `http://${APP_HOST}:${deps.port()}/join/${code}`;
      return reply.code(201).send({ invite, url, fingerprint });
    });

    scope.delete<Id>("/api/people/invites/:id", async (request, reply) => {
      service.revokeInvite(actorOf(request), request.params.id);
      return reply.code(204).send();
    });

    scope.patch<Id>("/api/people/:id", async (request) => {
      const { role } = roleBody.parse(request.body);
      if (request.params.id === principal(request).personId) throw new SelfChangeError();
      service.changeRole(actorOf(request), request.params.id, role);
      return getPerson(db, request.params.id);
    });

    scope.delete<Id>("/api/people/:id", async (request, reply) => {
      if (request.params.id === principal(request).personId) throw new SelfChangeError();
      service.remove(actorOf(request), request.params.id);
      return reply.code(204).send();
    });

    scope.post<Id>("/api/people/:id/sign-out", async (request) => {
      const person = getPerson(db, request.params.id);
      if (!person || person.removedAt !== null) throw new NotFoundError("person", request.params.id);
      return { revoked: sessions.revokeAll(request.params.id) };
    });

    // --- joining with an invite (public) ---

    scope.get<Code>("/api/join/:code", async (request) => {
      const invite = service.inviteByCode(request.params.code);
      const remote = request.listener === "remote" ? deps.remote() : null;
      return {
        role: invite.role,
        expiresAt: invite.expiresAt,
        passkeys: rpFor(request) !== null,
        host: host(request),
        fingerprint: remote?.fingerprint ?? null,
      };
    });

    scope.post<Code>("/api/join/:code/passkey/options", async (request, reply) => {
      const { name } = nameBody.parse(request.body);
      const invite = service.inviteByCode(request.params.code);
      const rp = requireRp(request, reply);
      if (rp === null) return reply;
      const challenge = challenges.issue(`join:${invite.id}`, client(request));
      // The bootstrap invite registers the Owner; anyone else is named by the invite until the join gives them an id.
      const userId = invite.role === "owner" ? OWNER_ID : invite.id;
      return registrationOptions(rp, { id: userId, name: personNameSchema.parse(name) }, [], challenge);
    });

    scope.post<Code>("/api/join/:code/passkey/verify", async (request, reply) => {
      const body = passkeyJoinBody.parse(request.body);
      if (!writable(reply)) return reply;
      const invite = service.inviteByCode(request.params.code);
      const rp = requireRp(request, reply);
      if (rp === null) return reply;
      const challenge = burnPasskeyChallenge(body.response, `join:${invite.id}`);
      const cred = passkeyCredential(await verifyRegistration(rp, challenge, body.response), body.label);
      const person = service.join(request.params.code, body.name, cred);
      startCounter(cred);
      return signIn(request, reply, person.id, "passkey", 201);
    });

    scope.post<Code>("/api/join/:code/key/challenge", async (request) => {
      emptyBody.parse(request.body ?? undefined);
      const invite = service.inviteByCode(request.params.code);
      return { challenge: challenges.issue(`join:${invite.id}`, client(request)) };
    });

    scope.post<Code>("/api/join/:code/key", async (request, reply) => {
      const body = keyJoinBody.parse(request.body);
      if (!writable(reply)) return reply;
      const invite = service.inviteByCode(request.params.code);
      burnChallenge(body.challenge, `join:${invite.id}`);
      if (!verifyKeyLogin({ publicKey: body.publicKey, challenge: body.challenge, host: host(request), signature: body.signature })) {
        throw new InvalidCredentialError();
      }
      const person = service.join(request.params.code, body.name, keyCredential(body.publicKey, body.label));
      return signIn(request, reply, person.id, "key", 201);
    });

    // --- signing in (public) ---

    scope.post("/api/auth/passkey/options", async (request, reply) => {
      emptyBody.parse(request.body ?? undefined);
      const rp = requireRp(request, reply);
      if (rp === null) return reply;
      return authenticationOptions(rp, challenges.issue("login", client(request)));
    });

    scope.post("/api/auth/passkey/verify", async (request, reply) => {
      const body = passkeyLoginBody.parse(request.body);
      if (!writable(reply)) return reply;
      const rp = requireRp(request, reply);
      if (rp === null) return reply;
      const response = body.response as { id?: unknown } | null;
      const credentialId = typeof response === "object" && response !== null && typeof response.id === "string" ? response.id : null;
      if (credentialId === null || credentialId.length > 2000) throw new InvalidCredentialError();
      const personId = await attempt(request, credentialId, async () => {
        const challenge = burnPasskeyChallenge(body.response, "login");
        const cred = service.findCredential(credentialId);
        if (!cred || cred.kind !== "passkey") throw new InvalidCredentialError();
        const { newCounter } = await verifyAuthentication(rp, challenge, body.response, { ...cred, counter: counterOf(credentialId) });
        db.prepare("INSERT OR REPLACE INTO credential_state (credential_id, counter) VALUES (?, ?)").run(credentialId, newCounter);
        return cred.personId;
      });
      return signIn(request, reply, personId, "passkey", 200);
    });

    scope.post("/api/auth/key/challenge", async (request) => {
      emptyBody.parse(request.body ?? undefined);
      return { challenge: challenges.issue("login", client(request)) };
    });

    scope.post("/api/auth/key/verify", async (request, reply) => {
      const body = keyLoginBody.parse(request.body);
      if (!writable(reply)) return reply;
      const credentialId = idOfKey(body.publicKey);
      const personId = await attempt(request, credentialId, () => {
        burnChallenge(body.challenge, "login");
        const cred = service.findCredential(credentialId);
        if (!cred || cred.kind !== "key" || cred.publicKey !== body.publicKey) throw new InvalidCredentialError();
        if (!verifyKeyLogin({ publicKey: body.publicKey, challenge: body.challenge, host: host(request), signature: body.signature })) {
          throw new InvalidCredentialError();
        }
        return cred.personId;
      });
      return signIn(request, reply, personId, "key", 200);
    });
  });
}

const bracket = (address: string): string => (address.includes(":") ? `[${address}]` : address);
