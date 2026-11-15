import os from "node:os";
import { timingSafeEqual } from "node:crypto";
import type { TLSSocket } from "node:tls";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  LINK_DEFAULT_PORT, LINK_PROTOCOL_VERSION, LINKING_ACK, PAIRING_LABEL, helloResponseSchema, machineAddressSchema,
  machineNameSchema, pairRequestSchema, pairResponseSchema, parsePairingCode,
  type Actor, type Machine, type MachinePresence,
} from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { commitEvent } from "../events/commit.js";
import { getMachine, getSetting, listMachines } from "../events/projections.js";
import { NotFoundError } from "../board/board-service.js";
import { HumanRequiredError } from "../intake/service.js";
import { SecretInTextError } from "../intake/recorded-text.js";
import { redact } from "../agents/redact.js";
import { SecretStoreUnavailableError, type SecretStore } from "../secrets/store.js";
import { LinkIdentity, fingerprintOf, machineIdOf } from "./identity.js";
import { ClosedBeforeReplyError, LinkClient, LinkProtocolError, RemoteRefusedError, type Peer } from "./client.js";
import { PAIR_PATH, type LinkListener, type ListenerDeps, type PeerCheck } from "./listener.js";
import { PairingWindow, pairingProof } from "./pairing.js";
import type { Discovered, Discovery } from "./discovery.js";

export class LinkingDisabledError extends Error {
  constructor() {
    super("linking is not enabled on this computer");
    this.name = "LinkingDisabledError";
  }
}

export class IdentityUnavailableError extends Error {
  constructor() {
    super("this computer's identity is unavailable (keychain)");
    this.name = "IdentityUnavailableError";
  }
}

export class PairingCodeMismatchError extends Error {
  constructor() {
    super("the code does not match that machine");
    this.name = "PairingCodeMismatchError";
  }
}

export class PairingRejectedError extends Error {
  constructor() {
    super("the other machine rejected the code");
    this.name = "PairingRejectedError";
  }
}

export class NoPairingError extends Error {
  constructor() {
    super("that machine is not showing a code");
    this.name = "NoPairingError";
  }
}

/** The address is this computer: a machine never pairs with itself. */
export class SelfPairingError extends Error {
  constructor() {
    super("that address is this computer");
    this.name = "SelfPairingError";
  }
}

/** What the pair route answers on the showing side. */
export type PairReply = { status: 200; body: z.infer<typeof pairResponseSchema> } | { status: 400 | 403 | 404; body: { error: string } };

export type LinkServiceDeps = {
  db: Db;
  ledger: Ledger;
  secrets: SecretStore;
  listener: (deps: ListenerDeps) => LinkListener;
  /** A client for this identity; `timeoutMs` overrides its default (hello uses 3 s). */
  client: (identity: LinkIdentity, timeoutMs?: number) => LinkClient;
  /** Adds the `/link/v1/*` routes; evaluated when the listener starts, so it may reference this service. */
  registerProtocol: (app: FastifyInstance) => void;
  /** Announces this computer while linking is on and finds others (mDNS; the in-process fake in tests). */
  discovery: Discovery;
  /** This computer's network interfaces, for the addresses shown beside a code. Default os.networkInterfaces. */
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  bind?: string;
  now?: () => Date;
  platform?: NodeJS.Platform;
};

const HELLO_TIMEOUT_MS = 3_000;
const HELLO_CACHE_MS = 15_000;
const PAIR_TIMEOUT_MS = 10_000;
/** Discovery keeps browsing this long after the last look, then stops until the next one. */
const BROWSE_LINGER_MS = 60_000;
const SYSTEM = { kind: "system", id: "link" } as const;
/** The showing side records a pairing for the Owner, who showed the code that allowed it. */
const OWNER = { kind: "human", id: "owner" } as const;
/** Fixed text: console output ends up in bug reports, so it never holds an address or an OS error. */
const BIND_FAILED = "The Terminal: linking is on, but the link listener could not start; other computers cannot reach this one until it does";
const IDENTITY_UNREADABLE = "The Terminal: the link identity stored in the keychain could not be read; linking is unavailable";
const IDENTITY_FAILED = "The Terminal: this computer's link identity could not be loaded; linking is unavailable";

const ackSchema = z.object({ acknowledgement: z.literal(LINKING_ACK) });
const portSchema = z.number().int().min(0).max(65535);

/** `host:port` split at the last colon (already checked with machineAddressSchema). */
function parseHostPort(address: string): { host: string; port: number } {
  const at = address.lastIndexOf(":");
  return { host: address.slice(0, at), port: Number(address.slice(at + 1)) };
}

/** Both ends export the same 32 bytes for one TLS connection, so a proof made on one connection is useless on another. */
function exportEkm(socket: TLSSocket): Buffer {
  // No context argument (RFC 5705 tells "no context" from an empty one); node's types insist on one, node does not.
  const exportNoContext = socket.exportKeyingMaterial as (length: number, label: string) => Buffer;
  return exportNoContext.call(socket, 32, PAIRING_LABEL);
}

/** A dotted IPv4 remote address (an IPv4-mapped IPv6 one unwrapped), else null. */
function ipv4Of(remote: string | undefined): string | null {
  if (!remote) return null;
  const plain = remote.startsWith("::ffff:") ? remote.slice("::ffff:".length) : remote;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(plain) ? plain : null;
}

function errorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const e = (body as { error?: unknown }).error;
  return typeof e === "string" && /^[a-z0-9_]{1,100}$/.test(e) ? e : null;
}

/** A discovery that reports its network failed (mDNS after a socket error); destroy() resets it for another try. */
function isUnavailable(d: Discovery): boolean {
  const available = (d as { available?: () => boolean }).available;
  return typeof available === "function" && !available.call(d);
}

function defaultName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Mac";
  if (platform === "win32") return "Windows PC";
  return "Linux PC";
}

/**
 * This computer's side of linked machines: its identity, the Owner's opt-in to linking, the paired machines and
 * whether they answer. The link listener runs only on the Owner's acknowledged request or while the recorded opt-in
 * (`link.enabled`) is `"1"`.
 */
export class LinkService {
  private readonly deps: LinkServiceDeps;
  private readonly now: () => Date;
  private readonly platform: NodeJS.Platform;
  private identity: LinkIdentity | null = null;
  private state: "ok" | "unavailable" = "unavailable";
  private listener: LinkListener | null = null;
  private helloClient: LinkClient | null = null;
  private readonly checked = new Map<string, { online: boolean; checkedAt: Date }>();
  private readonly checking = new Map<string, Promise<boolean>>();
  private closed = false;
  private window: PairingWindow | null = null;
  private browse: { stop: () => void; list: Discovered[]; timer: ReturnType<typeof setTimeout> | null } | null = null;
  /** Enabling and disabling run one at a time, so two requests can never start two listeners. */
  private serial: Promise<unknown> = Promise.resolve();

  constructor(deps: LinkServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.platform = deps.platform ?? process.platform;
  }

  /**
   * Loads this computer's identity (recording `machine.identity_created` when this data folder has none for it), then
   * starts the listener when the recorded opt-in says so. Never throws: an unavailable keychain leaves the identity
   * `unavailable`, and a listener that cannot bind is a warning while linking stays enabled.
   */
  async load(): Promise<void> {
    try {
      this.identity = await LinkIdentity.load({ secrets: this.deps.secrets, onCreated: () => undefined });
      this.window = new PairingWindow({ fingerprint: this.identity.fingerprint, now: this.now });
      this.state = "ok";
    } catch (err) {
      // An unavailable keychain is reported through identityState(). Anything else (a stored key that does not parse)
      // gets one fixed sentence: the error itself may quote the stored value, so it is never logged.
      if (!(err instanceof SecretStoreUnavailableError)) console.warn(IDENTITY_UNREADABLE);
      this.identity = null;
      this.window = null;
      this.state = "unavailable";
      return;
    }
    const identity = this.identity;
    const { db, ledger } = this.deps;
    // On creation, and also when the keychain already held a key this data folder never recorded.
    if (getSetting(db, "link.machineId") !== identity.machineId && !ledger.readOnly) {
      try {
        commitEvent(db, ledger, () => ({
          event: {
            projectId: null,
            actor: SYSTEM,
            type: "machine.identity_created",
            payload: { machineId: identity.machineId, publicKey: identity.publicKeyBase64, fingerprint: identity.fingerprint },
          },
          result: () => undefined,
        }));
      } catch {
        console.warn(IDENTITY_FAILED);
        this.identity = null;
        this.window = null;
        this.state = "unavailable";
        return;
      }
    }
    if (this.enabled() && !this.closed && this.listener === null) {
      const recorded = Number(getSetting(db, "link.port"));
      const port = Number.isInteger(recorded) && recorded > 0 && recorded <= 65535 ? recorded : LINK_DEFAULT_PORT;
      try {
        await this.startListener(port);
      } catch {
        console.warn(BIND_FAILED);
      }
    }
  }

  /** This computer's identity, to sign what it sends a paired machine (mirrored entries); null while unavailable. */
  signer(): LinkIdentity | null {
    return this.state === "ok" ? this.identity : null;
  }

  identityState(): "ok" | "unavailable" {
    return this.state;
  }

  self(): { machineId: string; fingerprint: string; name: string; linking: { enabled: boolean; port: number | null } } | null {
    if (!this.identity) return null;
    return {
      machineId: this.identity.machineId,
      fingerprint: this.identity.fingerprint,
      name: getSetting(this.deps.db, "link.name") ?? defaultName(this.platform),
      linking: { enabled: this.enabled(), port: this.listener?.port() ?? null },
    };
  }

  /**
   * Human only (HumanRequiredError otherwise): names this computer for the machines it links with. Trimmed, at most
   * 40 characters, and refused (SecretInTextError) when the name holds a secret.
   */
  async setName(actor: Actor, name: string): Promise<void> {
    if (actor.kind !== "human") throw new HumanRequiredError();
    const parsed = z.object({ name: machineNameSchema }).parse({ name: name.trim() }).name;
    if (redact(parsed) !== parsed) throw new SecretInTextError();
    commitEvent(this.deps.db, this.deps.ledger, () => ({
      event: { projectId: null, actor, type: "machine.named", payload: { name: parsed } },
      result: () => undefined,
    }));
    this.announce();
  }

  /**
   * The Owner's opt-in: the exact acknowledgement sentence. The listener starts first and the opt-in is recorded
   * with the port it bound; a bind failure (or a failed commit, which stops the listener again) records nothing.
   * Already on: answers the bound port and records nothing.
   */
  async enableLinking(actor: Actor, acknowledgement: string, port: number = LINK_DEFAULT_PORT): Promise<number> {
    if (actor.kind !== "human") throw new HumanRequiredError();
    ackSchema.parse({ acknowledgement });
    portSchema.parse(port);
    if (!this.identity) throw new IdentityUnavailableError();
    return this.oneAtATime(() => this.enable(actor, port));
  }

  private async enable(actor: Actor, port: number): Promise<number> {
    const running = this.listener?.port() ?? null;
    if (running !== null && this.enabled()) return running;
    const bound = running ?? (await this.startListener(port));
    try {
      commitEvent(this.deps.db, this.deps.ledger, () => ({
        event: { projectId: null, actor, type: "machine.linking_enabled", payload: { port: bound, acknowledgement: LINKING_ACK } },
        result: () => undefined,
      }));
    } catch (err) {
      await this.stopListener();
      throw err;
    }
    return bound;
  }

  /** Records `machine.linking_disabled`, then stops the listener in the same call. */
  async disableLinking(actor: Actor): Promise<void> {
    if (actor.kind !== "human") throw new HumanRequiredError();
    return this.oneAtATime(() => this.disable(actor));
  }

  private async disable(actor: Actor): Promise<void> {
    this.window?.cancel();
    if (this.enabled()) {
      commitEvent(this.deps.db, this.deps.ledger, () => ({
        event: { projectId: null, actor, type: "machine.linking_disabled", payload: {} },
        result: () => undefined,
      }));
    }
    await this.stopListener();
  }

  /**
   * Opens a pairing window (replacing any earlier one) and answers its code, its expiry and this computer's local
   * network addresses with the listener's port, for typing on the other machine. LinkingDisabledError while the
   * listener is down.
   */
  showCode(): { code: string; expiresAt: string; addresses: string[] } {
    const port = this.listener?.port() ?? null;
    if (!this.identity || !this.window) throw new IdentityUnavailableError();
    if (port === null) throw new LinkingDisabledError();
    const { code, expiresAt } = this.window.open();
    return { code, expiresAt, addresses: this.localAddresses(port) };
  }

  cancelCode(): void {
    this.window?.cancel();
  }

  /** Whether a code is shown and how many wrong proofs it has taken. */
  pairingState(): { open: boolean; attempts: number } {
    return { open: this.window?.isOpen() ?? false, attempts: this.window?.attempts() ?? 0 };
  }

  /**
   * The entering side. Checks the code's fingerprint prefix against the certificate the machine at `address`
   * presents before sending anything, then proves the code over that connection and checks the other side's proof
   * in turn; only then records `machine.paired` (role `entered_code`).
   */
  async pair(actor: Actor, address: string, code: string): Promise<Machine> {
    if (actor.kind !== "human") throw new HumanRequiredError();
    z.object({ address: machineAddressSchema }).parse({ address });
    // A ZodError at ["code"] unless it parses (that parse's secret is zeroed; the one below is used, then zeroed).
    const valid = (c: string) => {
      const p = parsePairingCode(c);
      p?.secret.fill(0);
      return p !== null;
    };
    z.object({ code: z.string().refine(valid, "not a pairing code") }).parse({ code });
    const parsed = parsePairingCode(code)!;
    const identity = this.identity;
    const secret = parsed.secret;
    try {
      if (!identity) throw new IdentityUnavailableError();
      const { host } = parseHostPort(address);
      const { socket, peerSpki } = await LinkClient.connectUnpinned(identity, address, PAIR_TIMEOUT_MS);
      try {
        if (peerSpki.equals(identity.publicKeyDer)) throw new SelfPairingError();
        if (!fingerprintOf(peerSpki).startsWith(parsed.fingerprintPrefix)) throw new PairingCodeMismatchError();
        const ekm = exportEkm(socket);
        const self = this.self()!;
        const request = pairRequestSchema.parse({
          v: LINK_PROTOCOL_VERSION,
          machineId: self.machineId,
          name: self.name,
          port: this.listener?.port() ?? LINK_DEFAULT_PORT,
          proof: pairingProof(secret, "theterminal-pair-v1", ekm, identity.publicKeyDer),
        });
        let reply: { status: number; body: unknown };
        try {
          reply = await LinkClient.postOnSocket(socket, address, PAIR_PATH, request, PAIR_TIMEOUT_MS);
        } catch (err) {
          // The listener drops an unknown key at once when no code is shown.
          if (err instanceof ClosedBeforeReplyError) throw new NoPairingError();
          throw err;
        }
        if (reply.status === 404) throw new NoPairingError();
        if (reply.status === 403) throw new PairingRejectedError();
        const refusal = errorCode(reply.body);
        if (reply.status === 400 && refusal === "self_pairing") throw new SelfPairingError();
        if (reply.status !== 200) throw new RemoteRefusedError(reply.status, refusal ?? "unknown");
        const body = pairResponseSchema.safeParse(reply.body);
        if (!body.success) throw new LinkProtocolError();
        if (body.data.machineId !== machineIdOf(peerSpki)) throw new PairingRejectedError();
        const expected = Buffer.from(pairingProof(secret, "theterminal-pair-ack-v1", ekm, peerSpki), "hex");
        if (!timingSafeEqual(Buffer.from(body.data.proof, "hex"), expected)) throw new PairingRejectedError();
        return this.recordPaired(actor, {
          machineId: body.data.machineId,
          name: body.data.name,
          publicKey: peerSpki.toString("base64"),
          fingerprint: fingerprintOf(peerSpki),
          address: `${host}:${body.data.port}`,
          role: "entered_code",
        });
      } finally {
        socket.destroy();
      }
    } finally {
      secret.fill(0);
    }
  }

  /**
   * The showing side, for `POST /link/v1/pair` on the listener: the entering machine's proof is checked against the
   * open window, bound to this connection's keying material and the key the machine presented. On success the
   * machine is recorded (role `showed_code`) and the reply carries this side's proof. The window counts every wrong
   * proof and closes itself at the fifth.
   */
  acceptPair(input: { body: unknown; socket: TLSSocket; peerSpki: Buffer }): PairReply {
    const identity = this.identity;
    const window = this.window;
    if (!identity || !window || !window.isOpen()) return { status: 404, body: { error: "no_pairing" } };
    const body = pairRequestSchema.parse(input.body);
    if (input.peerSpki.equals(identity.publicKeyDer) || body.machineId === identity.machineId) {
      return { status: 400, body: { error: "self_pairing" } };
    }
    // The id it claims must be the key it presented; checked before the proof, so it never costs an attempt.
    if (body.machineId !== machineIdOf(input.peerSpki)) return { status: 400, body: { error: "invalid_input" } };
    const remote = ipv4Of(input.socket.remoteAddress);
    const address = remote === null ? null : `${remote}:${body.port}`;
    if (address === null || !machineAddressSchema.safeParse(address).success) return { status: 400, body: { error: "invalid_input" } };
    const ekm = exportEkm(input.socket);
    const verdict = window.verify(body.proof, ekm, input.peerSpki);
    if (verdict === "none") return { status: 404, body: { error: "no_pairing" } };
    if (verdict === "rejected") return { status: 403, body: { error: "pairing_rejected" } };
    const secret = window.secret();
    if (!secret) return { status: 404, body: { error: "no_pairing" } };
    let proof: string;
    try {
      proof = pairingProof(secret, "theterminal-pair-ack-v1", ekm, identity.publicKeyDer);
    } finally {
      secret.fill(0);
    }
    this.recordPaired(OWNER, {
      machineId: body.machineId,
      name: body.name,
      publicKey: input.peerSpki.toString("base64"),
      fingerprint: fingerprintOf(input.peerSpki),
      address,
      role: "showed_code",
    });
    const self = this.self()!;
    return {
      status: 200,
      body: pairResponseSchema.parse({
        v: LINK_PROTOCOL_VERSION,
        machineId: self.machineId,
        name: self.name,
        port: this.listener?.port() ?? LINK_DEFAULT_PORT,
        proof,
      }),
    };
  }

  /** Human only: forgets a paired machine (`machine.unpaired`); its key opens nothing from then on. */
  async unpair(actor: Actor, machineId: string): Promise<void> {
    if (actor.kind !== "human") throw new HumanRequiredError();
    const m = getMachine(this.deps.db, machineId);
    if (!m) throw new NotFoundError("machine", machineId);
    commitEvent(this.deps.db, this.deps.ledger, () => ({
      event: { projectId: null, actor, type: "machine.unpaired", payload: { machineId: m.id, name: m.name } },
      result: () => undefined,
    }));
    this.checked.delete(m.id);
  }

  /**
   * Terminals found on the local network. The first call starts browsing; browsing stops a minute after the last
   * call, so a closed Machines view stops listening for announcements.
   */
  discovered(): Discovered[] {
    if (this.closed) return [];
    if (!this.browse) {
      const state: { stop: () => void; list: Discovered[]; timer: ReturnType<typeof setTimeout> | null } = {
        stop: () => undefined, list: [], timer: null,
      };
      this.browse = state;
      try {
        if (isUnavailable(this.deps.discovery)) this.deps.discovery.destroy();
        state.stop = this.deps.discovery.browse((list) => {
          state.list = list;
        });
      } catch {
        state.list = [];
      }
    }
    const b = this.browse;
    if (b.timer) clearTimeout(b.timer);
    b.timer = setTimeout(() => {
      if (this.browse === b) this.stopBrowsing();
    }, BROWSE_LINGER_MS);
    b.timer.unref?.();
    return b.list;
  }

  /** How many machines are paired and how many answered their last check (no new check is made). */
  counts(): { linked: number; online: number } {
    const rows = this.presence();
    return { linked: rows.length, online: rows.filter((r) => r.online === true).length };
  }

  machines(): Machine[] {
    return listMachines(this.deps.db);
  }

  peerFor(machineId: string): Peer {
    const m = getMachine(this.deps.db, machineId);
    if (!m) throw new NotFoundError("machine", machineId);
    return { machineId: m.id, address: m.address, publicKeyDer: Buffer.from(m.publicKey, "base64") };
  }

  /**
   * A client presenting this computer's identity, which checks each peer's key against the pinned one before it
   * sends anything. IdentityUnavailableError without an identity.
   */
  newClient(timeoutMs?: number): LinkClient {
    if (!this.identity) throw new IdentityUnavailableError();
    return this.deps.client(this.identity, timeoutMs);
  }

  /** The paired machine holding exactly this key, read from the projection on every call. */
  readonly peerCheck: PeerCheck = (spkiDer) => {
    const m = getMachine(this.deps.db, machineIdOf(spkiDer));
    if (!m || !Buffer.from(m.publicKey, "base64").equals(spkiDer)) return null;
    return { machineId: m.id };
  };

  /** Whether the machine answers `GET /link/v1/hello` as itself within 3 s; the answer is kept for 15 s. */
  async hello(machineId: string): Promise<boolean> {
    const cached = this.checked.get(machineId);
    if (cached && this.now().getTime() - cached.checkedAt.getTime() < HELLO_CACHE_MS) return cached.online;
    const inFlight = this.checking.get(machineId);
    if (inFlight) return inFlight;
    const identity = this.identity;
    if (!identity || getMachine(this.deps.db, machineId) === null) return false;
    const check = (async () => {
      let online = false;
      try {
        this.helloClient ??= this.deps.client(identity, HELLO_TIMEOUT_MS);
        const body = await this.helloClient.request(this.peerFor(machineId), "GET", "/link/v1/hello", undefined, helloResponseSchema);
        online = body.machineId === machineId;
      } catch {
        online = false;
      }
      this.checked.set(machineId, { online, checkedAt: this.now() });
      return online;
    })();
    this.checking.set(machineId, check);
    try {
      return await check;
    } finally {
      this.checking.delete(machineId);
    }
  }

  /**
   * What another connection to a paired machine just showed (a remote run's event stream answering, or failing to
   * connect), kept as its last check, so its presence reads offline while a run waits to reconnect.
   */
  observed(machineId: string, online: boolean): void {
    if (getMachine(this.deps.db, machineId) === null) return;
    this.checked.set(machineId, { online, checkedAt: this.now() });
  }

  /** Each paired machine with what its last hello said and when (null when never checked). */
  presence(): MachinePresence[] {
    return this.machines().map((m) => {
      const c = this.checked.get(m.id);
      return { ...m, online: c?.online ?? null, checkedAt: c ? c.checkedAt.toISOString() : null };
    });
  }

  /** Non-internal IPv4 addresses of this computer, as host:port. */
  private localAddresses(port: number): string[] {
    const all = (this.deps.interfaces ?? os.networkInterfaces)();
    const out: string[] = [];
    for (const list of Object.values(all)) {
      for (const i of list ?? []) {
        const family = i.family as string | number;
        if ((family === "IPv4" || family === 4) && !i.internal && !out.includes(`${i.address}:${port}`)) out.push(`${i.address}:${port}`);
      }
    }
    return out;
  }

  /** Stops the listener; nothing starts it again in this process. */
  async shutdown(): Promise<void> {
    this.closed = true;
    this.window?.cancel();
    this.stopBrowsing();
    await this.stopListener();
    try {
      this.deps.discovery.destroy();
    } catch {
      // Best effort: discovery is a convenience.
    }
  }

  private oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.serial.then(fn, fn);
    this.serial = run.catch(() => undefined);
    return run;
  }

  private enabled(): boolean {
    return getSetting(this.deps.db, "link.enabled") === "1";
  }

  /** Whether a pairing window is open: only then may an unknown key reach the pair route. */
  private pairingOpen(): boolean {
    return this.window?.isOpen() ?? false;
  }

  /** Starts the listener; when one already runs, answers its port, so no second listener is ever created. */
  private async startListener(port: number): Promise<number> {
    const running = this.listener?.port() ?? null;
    if (running !== null) return running;
    const identity = this.identity;
    if (!identity) throw new IdentityUnavailableError();
    if (this.closed) throw new LinkingDisabledError();
    const listener = this.deps.listener({
      identity,
      peer: this.peerCheck,
      pairingOpen: () => this.pairingOpen(),
      register: (app) => this.deps.registerProtocol(app),
      ...(this.deps.bind !== undefined && { bind: this.deps.bind }),
    });
    const bound = await listener.start(port);
    this.listener = listener;
    this.announce();
    return bound;
  }

  private async stopListener(): Promise<void> {
    const listener = this.listener;
    this.listener = null;
    this.window?.cancel();
    try {
      this.deps.discovery.unpublish();
    } catch {
      // Best effort.
    }
    if (listener) await listener.stop();
  }

  /** Publishes this computer's record while the listener runs (again after a rename). Never throws. */
  private announce(): void {
    const self = this.self();
    const port = this.listener?.port() ?? null;
    if (!self || port === null) return;
    const discovery = this.deps.discovery;
    try {
      // A multicast socket that failed earlier is given another try each time linking starts or the name changes.
      if (isUnavailable(discovery)) {
        this.stopBrowsing();
        discovery.destroy();
      }
      discovery.publish({ machineId: self.machineId, name: self.name, port });
    } catch {
      // A name the record cannot carry, or a network error: discovery is a convenience, typed addresses still work.
    }
  }

  private stopBrowsing(): void {
    const b = this.browse;
    this.browse = null;
    if (!b) return;
    if (b.timer) clearTimeout(b.timer);
    try {
      b.stop();
    } catch {
      // Best effort.
    }
  }

  /**
   * Commits `machine.paired` and resets its cached presence. The side that entered the code has just been answered by
   * the machine over the pinned connection, so it counts as online; the side that showed the code has not reached it.
   */
  private recordPaired(actor: Actor, payload: {
    machineId: string; name: string; publicKey: string; fingerprint: string; address: string; role: "showed_code" | "entered_code";
  }): Machine {
    commitEvent(this.deps.db, this.deps.ledger, () => ({
      event: { projectId: null, actor, type: "machine.paired", payload },
      result: () => undefined,
    }));
    if (payload.role === "entered_code") this.checked.set(payload.machineId, { online: true, checkedAt: this.now() });
    else this.checked.delete(payload.machineId);
    const m = getMachine(this.deps.db, payload.machineId);
    if (!m) throw new NotFoundError("machine", payload.machineId);
    return m;
  }
}
