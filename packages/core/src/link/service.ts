import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  LINK_DEFAULT_PORT, LINKING_ACK, helloResponseSchema, machineNameSchema,
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
import { LinkIdentity, machineIdOf } from "./identity.js";
import type { LinkClient, Peer } from "./client.js";
import type { LinkListener, ListenerDeps, PeerCheck } from "./listener.js";

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

export type LinkServiceDeps = {
  db: Db;
  ledger: Ledger;
  secrets: SecretStore;
  listener: (deps: ListenerDeps) => LinkListener;
  /** A client for this identity; `timeoutMs` overrides its default (hello uses 3 s). */
  client: (identity: LinkIdentity, timeoutMs?: number) => LinkClient;
  /** Adds the `/link/v1/*` routes; evaluated when the listener starts, so it may reference this service. */
  registerProtocol: (app: FastifyInstance) => void;
  bind?: string;
  now?: () => Date;
  platform?: NodeJS.Platform;
};

const HELLO_TIMEOUT_MS = 3_000;
const HELLO_CACHE_MS = 15_000;
const SYSTEM = { kind: "system", id: "link" } as const;
/** Fixed text: console output ends up in bug reports, so it never holds an address or an OS error. */
const BIND_FAILED = "The Terminal: linking is on, but the link listener could not start; other computers cannot reach this one until it does";
const IDENTITY_UNREADABLE = "The Terminal: the link identity stored in the keychain could not be read; linking is unavailable";
const IDENTITY_FAILED = "The Terminal: this computer's link identity could not be loaded; linking is unavailable";

const ackSchema = z.object({ acknowledgement: z.literal(LINKING_ACK) });
const portSchema = z.number().int().min(0).max(65535);

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
      this.state = "ok";
    } catch (err) {
      // An unavailable keychain is reported through identityState(). Anything else (a stored key that does not parse)
      // gets one fixed sentence: the error itself may quote the stored value, so it is never logged.
      if (!(err instanceof SecretStoreUnavailableError)) console.warn(IDENTITY_UNREADABLE);
      this.identity = null;
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
    if (this.enabled()) {
      commitEvent(this.deps.db, this.deps.ledger, () => ({
        event: { projectId: null, actor, type: "machine.linking_disabled", payload: {} },
        result: () => undefined,
      }));
    }
    await this.stopListener();
  }

  machines(): Machine[] {
    return listMachines(this.deps.db);
  }

  peerFor(machineId: string): Peer {
    const m = getMachine(this.deps.db, machineId);
    if (!m) throw new NotFoundError("machine", machineId);
    return { machineId: m.id, address: m.address, publicKeyDer: Buffer.from(m.publicKey, "base64") };
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

  /** Each paired machine with what its last hello said and when (null when never checked). */
  presence(): MachinePresence[] {
    return this.machines().map((m) => {
      const c = this.checked.get(m.id);
      return { ...m, online: c?.online ?? null, checkedAt: c ? c.checkedAt.toISOString() : null };
    });
  }

  /** Stops the listener; nothing starts it again in this process. */
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.stopListener();
  }

  private oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.serial.then(fn, fn);
    this.serial = run.catch(() => undefined);
    return run;
  }

  private enabled(): boolean {
    return getSetting(this.deps.db, "link.enabled") === "1";
  }

  /** Whether a pairing window is open (Task 4 opens them). */
  private pairingOpen(): boolean {
    return false;
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
    return bound;
  }

  private async stopListener(): Promise<void> {
    const listener = this.listener;
    this.listener = null;
    if (listener) await listener.stop();
  }
}
