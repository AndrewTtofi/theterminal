import { X509Certificate, createPrivateKey } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import net, { isIP, isIPv6, type AddressInfo } from "node:net";
import { join } from "node:path";
import tls, { type TLSSocket } from "node:tls";
import {
  DEFAULT_REMOTE,
  domainSchema,
  type Actor,
  type LedgerEntry,
  type Listener,
  type NewLedgerEntry,
  type RemoteState,
  type TlsMode,
} from "@theterminal/shared";
import type { Db } from "../db.js";
import { LedgerReadOnlyError, type Ledger } from "../ledger/ledger.js";
import { commitEvents } from "../events/commit.js";
import type { SecretStore } from "../secrets/store.js";
import { OwnerCredentialRequiredError } from "../people/service.js";
import { AcmeError, type AcmeManager } from "./acme.js";
import { localAddresses as machineAddresses, loadProvided, selfSignedTlsCertificate, type CertMaterial } from "./certs.js";

/** Secret-store account holding the self-signed certificate's private key (PKCS#8 PEM). */
export const REMOTE_KEY_SECRET = "remote/tls/key";
/** Secret-store account holding the provided certificate's two paths as JSON; never in the ledger. */
export const REMOTE_FILES_SECRET = "remote/tls/files";
/** The only unauthenticated route; exempt from the remote Host check. */
export const HEALTHZ_PATH = "/healthz";
/** Milliseconds a client has to finish the TLS handshake. */
export const REMOTE_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Concurrent TCP connections the TLS listener accepts. */
export const REMOTE_MAX_CONNECTIONS = 256;
/**
 * Milliseconds of silence after which a TLS connection is closed. Long enough for a slow request; the event stream's
 * ping (events-ws.ts) keeps a live WebSocket inside it, and a peer that stops answering pings is cut by that stream.
 */
export const REMOTE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** How long the machine's names and addresses are kept before os.networkInterfaces() and os.hostname() are read again. */
export const ADDRESS_CACHE_MS = 5_000;
/** Milliseconds to bind the port, and to close it. */
const LISTEN_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;
/** A self-signed certificate this close to expiry is replaced. */
const RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;
const MAX_CERT_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 4096;
const SYSTEM: Actor = { kind: "system", id: "remote" };
/** The port Let's Encrypt validates HTTP-01 on. Privileged outside Docker on Linux; see acme.ts. */
export const ACME_CHALLENGE_PORT = 80;
/** How often the ACME certificate is checked for renewal. */
export const ACME_RENEW_CHECK_MS = 12 * 60 * 60 * 1000;
/** After n consecutive renewal failures, the next min(2^n - 1, this) checks are skipped. */
const ACME_MAX_SKIPPED_CHECKS = 3;
const CHALLENGE_PATH = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]{1,128})$/;
const CHALLENGE_MAX_CONNECTIONS = 64;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BYTES = 1024;
const MAX_REDIRECT_PATH = 2048;
const REMOTE_TYPES = new Set(["remote.enabled", "remote.disabled", "remote.certificate_changed"]);

/** The listener could not bind its port. The message is fixed. → 502 remote_start_failed */
export class RemoteStartError extends Error {
  constructor() {
    super("the remote listener could not start");
    this.name = "RemoteStartError";
  }
}

/**
 * The Owner has no passkey or key, so turning remote access on from the UI would lock them out of it. → 409
 * owner_credential_required. One class, the people service's, so the remote routes and the people routes agree.
 */
export { OwnerCredentialRequiredError } from "../people/service.js";

export type RemoteInputCode =
  | "invalid_port"
  | "invalid_bind"
  | "invalid_domain"
  | "invalid_tls"
  | "certificate_files_required"
  | "certificate_domain_mismatch"
  | "acme_domain_required"
  | "acme_unavailable";

const INPUT_MESSAGES: Record<RemoteInputCode, string> = {
  invalid_port: "The port must be a whole number from 1 to 65535.",
  invalid_bind: "The address to listen on must be an IP address.",
  invalid_domain: "The domain is not a valid DNS name.",
  invalid_tls: "The certificate mode is not known.",
  certificate_files_required: "Both a certificate file and a key file are needed.",
  certificate_domain_mismatch: "The certificate does not cover the domain.",
  acme_domain_required: "Certificates from Let's Encrypt need a domain.",
  acme_unavailable: "Certificates from Let's Encrypt are not available.",
};

/** The settings asked for cannot be used. The message is fixed and never holds the input. → 400 invalid_input */
export class RemoteInputError extends Error {
  readonly code: RemoteInputCode;
  constructor(code: RemoteInputCode) {
    super(INPUT_MESSAGES[code]);
    this.name = "RemoteInputError";
    this.code = code;
  }
}

export type RemoteDeps = {
  /** The app's HTTP server: decrypted TLS sockets are handed to it, so both listeners share one route table. */
  http: HttpServer;
  db: Db;
  ledger: Ledger;
  secrets: SecretStore;
  /** Not the whole PeopleService: one boolean, so this module is testable against a stub. */
  people: { hasOwnerCredential(): boolean };
  dataDir: string;
  /** The UI folder, denied to provided certificate files; null when the server serves none. */
  uiDir: string | null;
  now?: () => Date;
  /** The machine's names and addresses for the certificate and the wildcard bind; tests inject fixed ones. */
  localAddresses?: () => { hostnames: string[]; addresses: string[] };
  /** Tests only: a shorter idle timeout for TLS connections. Default REMOTE_IDLE_TIMEOUT_MS. */
  idleTimeoutMs?: number;
  /** Certificates from Let's Encrypt for `tls: "acme"`; without it that mode is refused (`acme_unavailable`). */
  acme?: AcmeManager;
  /** The plain challenge listener's port when the input names none: 80, except in tests. */
  acmePort?: number;
};

export type EnableInput = {
  port?: number;
  bind?: string;
  domain?: string | null;
  tls?: TlsMode;
  certFile?: string;
  keyFile?: string;
  /** The plain ACME challenge listener's port (default 80). A test knob: Let's Encrypt connects to port 80 only. */
  acmePort?: number;
};

/** `acme.lastError` is the last ACME error type (an allowlisted URN or "unknown"), for the Owner only. */
export type RemoteView = RemoteState & { listening: boolean; addresses: string[]; acme: { lastError: string | null } };

/**
 * Remote state before any entry: off, with the shared default bind. Remote access is off by default and turning it
 * on means the Owner wants the network; the listener binds exactly what the state or the configuration says.
 */
export const INITIAL_REMOTE: RemoteState = DEFAULT_REMOTE;

/** Applies one `remote.*` entry to the state; any other entry leaves it as it is. */
export function applyRemoteEntry(s: RemoteState, e: Pick<LedgerEntry, "type" | "payload">): RemoteState {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "remote.enabled":
      return {
        ...s,
        enabled: true,
        port: p.port as number,
        bind: p.bind as string,
        domain: (p.domain as string | null) ?? null,
        tls: p.tls as TlsMode,
        fingerprint: p.fingerprint as string,
      };
    case "remote.disabled":
      return { ...s, enabled: false };
    case "remote.certificate_changed":
      return { ...s, tls: p.tls as TlsMode, fingerprint: p.fingerprint as string, expiresAt: p.expiresAt as string };
    default:
      return s;
  }
}

/** Remote state folded from the ledger's `remote.*` entries (Task 1's `getRemoteState` projection agrees with it). */
export function readRemoteState(db: Db): RemoteState {
  const rows = db
    .prepare(
      "SELECT type, payload FROM ledger WHERE type IN ('remote.enabled', 'remote.disabled', 'remote.certificate_changed') ORDER BY seq",
    )
    .iterate() as Iterable<{ type: string; payload: string }>;
  let s = INITIAL_REMOTE;
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    s = applyRemoteEntry(s, { type: row.type as LedgerEntry["type"], payload: payload as LedgerEntry["payload"] });
  }
  return s;
}

/** Which listener a request came in on: a TLS socket is the remote listener's, anything else the local one's. */
export function listenerOf(request: { raw: { socket: unknown } }): Listener {
  return (request.raw.socket as Partial<TLSSocket> | null | undefined)?.encrypted === true ? "remote" : "local";
}

/**
 * What the remote Host check compares against: the listener's port, its domain, and (without a domain) the names
 * that are this listener's own: its addresses (IPv6 without brackets) and the machine's own hostnames.
 */
export type HostRule = { port: number; domain: string | null; names: string[] };

/**
 * The remote Host rule, case-insensitive. With a domain: `<domain>`, `<domain>:443` or `<domain>:<port>`. Without:
 * `<name>:<port>` for one of the listener's own names, an IPv6 address in brackets. Anything else is refused.
 */
export function remoteHostAllowed(host: string, rule: HostRule): boolean {
  if (typeof host !== "string" || host.length === 0 || host.length > 300) return false;
  const h = host.toLowerCase();
  if (rule.domain !== null) {
    const d = rule.domain.toLowerCase();
    return h === d || h === `${d}:443` || h === `${d}:${rule.port}`;
  }
  const suffix = `:${rule.port}`;
  if (!h.endsWith(suffix)) return false;
  let name = h.slice(0, -suffix.length);
  if (name.startsWith("[")) {
    if (!name.endsWith("]")) return false;
    name = name.slice(1, -1);
    if (name.includes("%") || !isIPv6(name)) return false;
  } else if (name.includes(":")) {
    return false;
  }
  return rule.names.some((n) => n.toLowerCase() === name);
}

/** Whether a request is the health probe, which alone skips the Host check (it answers `{ ok: true }` only). */
export function isHealthz(request: { method: string; routeOptions: { url?: string } }): boolean {
  return (request.method === "GET" || request.method === "HEAD") && request.routeOptions.url === HEALTHZ_PATH;
}

/** Step (2) of the auth hook for the remote listener: the health probe passes, anything else needs an allowed Host. */
export function checkRemoteHost(
  request: { method: string; routeOptions: { url?: string }; headers: { host?: string } },
  rule: HostRule,
): boolean {
  return isHealthz(request) || remoteHostAllowed(request.headers.host ?? "", rule);
}

type Config = { port: number; bind: string; domain: string | null; tls: TlsMode; acmePort?: number };

/**
 * The network listener: off by default, TLS only, every change in the ledger. It owns a `tls.Server` whose
 * decrypted sockets are handed to the app's HTTP server, so requests over it are the same Fastify requests as the
 * local listener's, told apart by `listenerOf`.
 */
export class RemoteListener {
  private readonly now: () => Date;
  private readonly addressesOf: () => { hostnames: string[]; addresses: string[] };
  private current: RemoteState;
  private server: tls.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  /** The material the TLS listener serves right now. */
  private served: CertMaterial | null = null;
  /** `domain` and `tlsPort` are the redirect target, from the configuration, never from a request's Host. */
  private challenge: {
    server: http.Server;
    bind: string;
    port: number;
    sockets: Set<net.Socket>;
    domain: string;
    tlsPort: number;
  } | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private renewFailures = 0;
  private skipChecks = 0;
  private lastAcmeError: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: RemoteDeps) {
    this.now = deps.now ?? (() => new Date());
    // The Host rule runs on every remote request: the interfaces and hostname are read at most once per ADDRESS_CACHE_MS.
    const read = deps.localAddresses ?? (() => machineAddresses());
    let cached: { at: number; value: { hostnames: string[]; addresses: string[] } } | null = null;
    this.addressesOf = () => {
      const t = Date.now();
      if (cached === null || t - cached.at >= ADDRESS_CACHE_MS || t < cached.at) cached = { at: t, value: read() };
      return cached.value;
    };
    this.current = readRemoteState(deps.db);
    this.unsubscribe = deps.ledger.onAppend((e) => {
      if (REMOTE_TYPES.has(e.type)) this.current = applyRemoteEntry(this.current, e);
    });
  }

  state(): RemoteView {
    const listening = this.server !== null;
    return {
      ...this.current,
      listening,
      addresses: listening ? this.addressesFor(this.current.bind) : [],
      acme: { lastError: this.lastAcmeError },
    };
  }

  /** The plain ACME challenge listener's port while it is up, else null. */
  challengePort(): number | null {
    const a = this.challenge?.server.address();
    return a && typeof a === "object" ? a.port : null;
  }

  /** The Host rule for requests over this listener, from the current state (see `remoteHostAllowed`). */
  hostRule(): HostRule {
    const { port, domain, bind } = this.current;
    const loopback = bind === "0.0.0.0" ? ["127.0.0.1"] : bind === "::" ? ["127.0.0.1", "::1"] : [];
    const names = unique([...this.addressesFor(bind), ...loopback, ...this.addressesOf().hostnames].map((n) => n.toLowerCase()));
    return { port, domain, names };
  }

  /**
   * Turns remote access on (or reconfigures it). Order: certificate material → `remote.certificate_changed` when the
   * certificate is new → `remote.enabled` → listen; a listen failure commits `remote.disabled` and throws
   * RemoteStartError. Errors before the commit record nothing.
   *
   * A human (the UI switch) needs an Owner credential first, or they would lock themselves out of what they turned on.
   * A system actor is the server itself acting on the operator's command line (`--remote`), where the way in is the
   * bootstrap invite printed at start, so that check does not apply, as it does not at a restart (startIfEnabled).
   */
  enable(actor: Actor, i: EnableInput): Promise<RemoteState> {
    return this.serial(async () => {
      if (actor.kind === "human" && !this.deps.people.hasOwnerCredential()) throw new OwnerCredentialRequiredError();
      if (this.deps.ledger.readOnly) throw new LedgerReadOnlyError();
      const cfg = this.resolve(i);
      const material = await this.enableMaterial(cfg, i);
      await this.stopServer();
      let port = cfg.port;
      if (port === 0) {
        try {
          port = await probePort(cfg.bind);
        } catch {
          await this.stopAcme();
          if (this.current.enabled) this.commitDisabled(SYSTEM);
          throw new RemoteStartError();
        }
      }
      const events: NewLedgerEntry[] = [];
      if (material.fingerprint !== this.current.fingerprint || cfg.tls !== this.current.tls) {
        events.push(this.certificateChanged(actor, cfg, material));
      }
      events.push({
        projectId: null,
        actor,
        type: "remote.enabled",
        payload: { port, bind: cfg.bind, domain: cfg.domain, tls: cfg.tls, fingerprint: material.fingerprint },
      });
      commitEvents(this.deps.db, this.deps.ledger, () => ({ events, result: () => undefined }));
      if (this.challenge !== null) this.challenge.tlsPort = port;
      try {
        await this.listen(material, port, cfg.bind);
      } catch {
        await this.stopAcme();
        this.commitDisabled(SYSTEM);
        throw new RemoteStartError();
      }
      if (cfg.tls === "acme") this.startRenewals();
      else await this.stopAcme();
      return this.publicState();
    });
  }

  /**
   * Closes the listener and every connection on it, then commits `remote.disabled` (when it was on). `spare` is the
   * connection the request to disable came in on, when that was over this listener: it is left to finish its response
   * (the route sends `connection: close`) and destroyed after a bounded wait.
   */
  disable(actor: Actor, opts: { spare?: unknown } = {}): Promise<void> {
    return this.serial(async () => {
      await this.stopServer(opts.spare);
      await this.stopAcme();
      if (this.current.enabled) this.commitDisabled(actor);
    });
  }

  /** At boot: listens again when the ledger says remote access is on. A failure logs a fixed line and turns it off. */
  startIfEnabled(): Promise<void> {
    return this.serial(async () => {
      const s = this.current;
      if (!s.enabled || this.server !== null) return;
      const cfg: Config = { port: s.port, bind: s.bind, domain: s.domain, tls: s.tls };
      try {
        if (cfg.tls === "acme") {
          try {
            await this.ensureChallenge(cfg, this.deps.acmePort ?? ACME_CHALLENGE_PORT);
          } catch {
            console.error("the ACME challenge listener could not start, so the certificate cannot be renewed");
          }
        }
        const material = cfg.tls === "acme" ? await this.acmeMaterial(cfg, { reuseDue: true }) : await this.material(cfg, {});
        if (material.fingerprint !== s.fingerprint) {
          commitEvents(this.deps.db, this.deps.ledger, () => ({
            events: [this.certificateChanged(SYSTEM, cfg, material)],
            result: () => undefined,
          }));
        }
        await this.listen(material, cfg.port, cfg.bind);
        if (cfg.tls === "acme") {
          this.startRenewals();
          const acme = this.deps.acme;
          if (acme !== undefined && acme.isDue(material)) {
            setTimeout(() => void this.renewalTick().catch(() => undefined), 0).unref();
          }
        }
      } catch {
        await this.stopAcme();
        console.error("remote access could not start, so it is now off");
        try {
          this.commitDisabled(SYSTEM);
        } catch {
          // a read-only ledger: the listener is not running, which is what the entry would have said
        }
      }
    });
  }

  /** Shutdown: stops listening without recording anything, so the next start listens again. */
  close(): Promise<void> {
    return this.serial(async () => {
      this.unsubscribe();
      await this.stopServer();
      await this.stopAcme();
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private publicState(): RemoteState {
    const { listening: _l, addresses: _a, acme: _m, ...rest } = this.state();
    return rest;
  }

  private resolve(i: EnableInput): Config {
    const prev = this.current;
    const port = i.port ?? prev.port;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RemoteInputError("invalid_port");
    const bind = i.bind ?? prev.bind;
    if (typeof bind !== "string" || bind.length > 45 || bind.includes("%") || isIP(bind) === 0) {
      throw new RemoteInputError("invalid_bind");
    }
    const domain = i.domain === undefined ? prev.domain : i.domain;
    if (domain !== null && !domainSchema.safeParse(domain).success) throw new RemoteInputError("invalid_domain");
    const mode = i.tls ?? prev.tls;
    if (mode !== "self_signed" && mode !== "provided" && mode !== "acme") throw new RemoteInputError("invalid_tls");
    if (mode === "acme" && this.deps.acme === undefined) throw new RemoteInputError("acme_unavailable");
    if (mode === "acme" && domain === null) throw new RemoteInputError("acme_domain_required");
    const acmePort = i.acmePort ?? this.deps.acmePort ?? ACME_CHALLENGE_PORT;
    if (!Number.isInteger(acmePort) || acmePort < 0 || acmePort > 65535) throw new RemoteInputError("invalid_port");
    for (const p of [i.certFile, i.keyFile]) {
      if (p !== undefined && (typeof p !== "string" || p.length === 0 || p.length > MAX_PATH_LENGTH)) {
        throw new RemoteInputError("certificate_files_required");
      }
    }
    if ((i.certFile === undefined) !== (i.keyFile === undefined)) throw new RemoteInputError("certificate_files_required");
    return { port, bind, domain: domain === null ? null : domain.toLowerCase(), tls: mode, acmePort };
  }

  /**
   * `enable`'s material. For ACME the plain challenge listener comes up first; a failure (port 80 in use or not
   * permitted, the order refused) is an AcmeError, records nothing, and leaves the listeners as they were (the
   * challenge listener stays only while an ACME certificate is being served, for its renewals).
   */
  private async enableMaterial(cfg: Config, i: EnableInput): Promise<CertMaterial> {
    if (cfg.tls !== "acme") return this.material(cfg, i);
    const keep = () => this.server !== null && this.current.enabled && this.current.tls === "acme";
    try {
      await this.ensureChallenge(cfg, cfg.acmePort ?? ACME_CHALLENGE_PORT);
      const m = await this.acmeMaterial(cfg, { reuseDue: false });
      this.lastAcmeError = null;
      return m;
    } catch (err) {
      const e = err instanceof AcmeError ? err : new AcmeError("unknown");
      this.lastAcmeError = e.type;
      if (!keep()) await this.stopChallenge();
      throw e;
    }
  }

  /** The stored ACME certificate while it covers the domain (and, unless `reuseDue`, is not due), else a new order. */
  private async acmeMaterial(cfg: Config, opts: { reuseDue: boolean }): Promise<CertMaterial> {
    const acme = this.deps.acme;
    if (acme === undefined || cfg.domain === null) throw new AcmeError("unknown");
    const stored = await acme.load(cfg.domain);
    if (stored !== null && (opts.reuseDue || !acme.isDue(stored))) return stored;
    if (this.challenge === null) throw new AcmeError("unknown");
    return acme.obtain(cfg.domain, { probe: (token) => this.probe(token) });
  }

  /**
   * One renewal check (every ACME_RENEW_CHECK_MS): a new certificate is committed as `remote.certificate_changed`
   * first, then swapped into the TLS listener with setSecureContext. A failure keeps the current certificate, keeps
   * the error type for the Owner and skips the next min(2^n - 1, 3) checks after n failures in a row.
   */
  renewalTick(): Promise<void> {
    return this.serial(async () => {
      const s = this.current;
      const acme = this.deps.acme;
      const server = this.server;
      const current = this.served;
      if (!s.enabled || s.tls !== "acme" || s.domain === null || acme === undefined || server === null || current === null) return;
      if (this.skipChecks > 0) {
        this.skipChecks--;
        return;
      }
      const cfg: Config = { port: s.port, bind: s.bind, domain: s.domain, tls: s.tls };
      const failed = (type: string): void => {
        this.renewFailures++;
        this.skipChecks = Math.min(2 ** this.renewFailures - 1, ACME_MAX_SKIPPED_CHECKS);
        this.lastAcmeError = type;
        console.error("the remote certificate could not be renewed; trying again later");
      };
      if (!acme.isDue(current)) return;
      let next: CertMaterial;
      try {
        // A certificate an earlier tick obtained but could not record is reused: no new order for it.
        const stored = await acme.load(s.domain);
        if (stored !== null && stored.fingerprint !== current.fingerprint && !acme.isDue(stored)) next = stored;
        else {
          if (this.challenge === null) await this.ensureChallenge(cfg, this.deps.acmePort ?? ACME_CHALLENGE_PORT);
          next = await acme.obtain(s.domain, { probe: (token) => this.probe(token) });
        }
      } catch (err) {
        failed(err instanceof AcmeError ? err.type : "unknown");
        return;
      }
      try {
        commitEvents(this.deps.db, this.deps.ledger, () => ({
          events: [this.certificateChanged(SYSTEM, cfg, next)],
          result: () => undefined,
        }));
      } catch {
        // A read-only ledger: the served certificate stays the one the ledger names, and the next attempt backs off.
        failed("unknown");
        return;
      }
      server.setSecureContext({ cert: next.certPem, key: next.keyPem, minVersion: "TLSv1.2" });
      this.served = next;
      this.renewFailures = 0;
      this.skipChecks = 0;
      this.lastAcmeError = null;
    });
  }

  private startRenewals(): void {
    if (this.renewTimer !== null) return;
    this.renewTimer = setInterval(() => void this.renewalTick().catch(() => undefined), ACME_RENEW_CHECK_MS);
    this.renewTimer.unref();
  }

  /** Stops the renewal checks and the plain challenge listener. */
  private async stopAcme(): Promise<void> {
    if (this.renewTimer !== null) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    this.renewFailures = 0;
    this.skipChecks = 0;
    await this.stopChallenge();
  }

  /**
   * The plain HTTP listener for HTTP-01 on `bind`:`port`. It answers GET/HEAD
   * `/.well-known/acme-challenge/<token>` with the key authorization while that token's order is open; any other GET
   * or HEAD gets a 301 to `https://<configured domain>[:<TLS port>]<path>` (never the request's Host), and any other
   * method 404. Nothing from the app is served here. A port that cannot be bound is an AcmeError.
   */
  private async ensureChallenge(cfg: Config, port: number): Promise<void> {
    const { bind } = cfg;
    const domain = cfg.domain;
    if (domain === null) throw new AcmeError("unknown");
    const c = this.challenge;
    if (c !== null && c.bind === bind && (port === 0 || c.port === port)) {
      c.domain = domain;
      c.tlsPort = cfg.port;
      return;
    }
    await this.stopChallenge();
    const sockets = new Set<net.Socket>();
    const server = http.createServer(
      { requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 1_000, maxHeaderSize: 8 * 1024 },
      (req, res) => this.answerChallenge(req, res),
    );
    server.maxConnections = CHALLENGE_MAX_CONNECTIONS;
    server.on("connection", (socket: net.Socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("clientError", (_err, socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          server.close();
          reject(new Error("listen timeout"));
        }, LISTEN_TIMEOUT_MS);
        server.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        server.listen({ port, host: bind, exclusive: true }, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } catch {
      throw new AcmeError("unknown");
    }
    server.on("error", () => undefined);
    this.challenge = { server, bind, port: (server.address() as AddressInfo).port, sockets, domain, tlsPort: cfg.port };
  }

  private answerChallenge(req: IncomingMessage, res: ServerResponse): void {
    const m = CHALLENGE_PATH.exec(req.url ?? "");
    const body = m && (req.method === "GET" || req.method === "HEAD") ? (this.deps.acme?.challengeResponse(m[1]!) ?? null) : null;
    const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
    const c = this.challenge;
    if (body === null && c !== null && (req.method === "GET" || req.method === "HEAD")) {
      const url = req.url ?? "";
      const path = url.startsWith("/") && url.length <= MAX_REDIRECT_PATH ? url : "/";
      const port = c.tlsPort === 443 ? "" : `:${c.tlsPort}`;
      res.writeHead(301, { ...headers, location: `https://${c.domain}${port}${path}`, "content-length": "0", connection: "close" });
      res.end();
      return;
    }
    if (body === null) {
      res.writeHead(404, { ...headers, "content-length": "9", connection: "close" });
      res.end(req.method === "HEAD" ? undefined : "not found");
      return;
    }
    res.writeHead(200, { ...headers, "content-length": String(Buffer.byteLength(body)) });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  private async stopChallenge(): Promise<void> {
    const c = this.challenge;
    if (c === null) return;
    this.challenge = null;
    const closed = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      c.server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    for (const s of c.sockets) s.destroy();
    c.sockets.clear();
    await closed;
  }

  /** What the challenge listener serves for `token`, fetched over loopback (fakeAcme's "validation"). */
  private probe(token: string): Promise<string | null> {
    const c = this.challenge;
    if (c === null) return Promise.resolve(null);
    const host = c.bind === "0.0.0.0" ? "127.0.0.1" : c.bind === "::" ? "::1" : c.bind;
    return new Promise((resolve) => {
      const req = http.get(
        { host, port: c.port, path: `/.well-known/acme-challenge/${encodeURIComponent(token)}`, agent: false, timeout: PROBE_TIMEOUT_MS },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > PROBE_MAX_BYTES) req.destroy();
          });
          res.on("end", () => resolve(res.statusCode === 200 ? body : null));
          res.on("error", () => resolve(null));
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(null));
    });
  }

  private async material(cfg: Config, i: EnableInput): Promise<CertMaterial> {
    return cfg.tls === "provided" ? this.providedMaterial(cfg, i) : this.selfSignedMaterial(cfg);
  }

  private async providedMaterial(cfg: Config, i: EnableInput): Promise<CertMaterial> {
    let files: { certFile: string; keyFile: string } | null = null;
    const given = i.certFile !== undefined && i.keyFile !== undefined;
    if (given) files = { certFile: i.certFile!, keyFile: i.keyFile! };
    else files = parseFiles(await this.deps.secrets.get(REMOTE_FILES_SECRET));
    if (files === null) throw new RemoteInputError("certificate_files_required");
    const m = loadProvided(files.certFile, files.keyFile, { uiDir: this.deps.uiDir, dataDir: this.deps.dataDir }, { now: this.now });
    if (cfg.domain !== null && new X509Certificate(m.certPem).checkHost(cfg.domain) === undefined) {
      throw new RemoteInputError("certificate_domain_mismatch");
    }
    if (given) await this.deps.secrets.set(REMOTE_FILES_SECRET, JSON.stringify(files));
    return m;
  }

  /** Reuses `<dataDir>/remote/cert.pem` with its key from the secret store while they match, last and cover the domain. */
  private async selfSignedMaterial(cfg: Config): Promise<CertMaterial> {
    const dir = join(this.deps.dataDir, "remote");
    const certPath = join(dir, "cert.pem");
    const certPem = readBoundedText(certPath);
    const keyPem = await this.deps.secrets.get(REMOTE_KEY_SECRET);
    if (certPem !== null && keyPem !== null) {
      const reused = this.reusable(certPem, keyPem, cfg.domain);
      if (reused) return reused;
    }
    const local = this.addressesOf();
    const hostnames = unique([...(cfg.domain ? [cfg.domain] : []), ...local.hostnames, "localhost"]);
    const specific = cfg.bind !== "0.0.0.0" && cfg.bind !== "::" ? [cfg.bind] : [];
    const addresses = unique(["127.0.0.1", "::1", ...local.addresses, ...specific]);
    const m = await selfSignedTlsCertificate({ hostnames, addresses, now: this.now });
    await this.deps.secrets.set(REMOTE_KEY_SECRET, m.keyPem);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `cert.pem.${process.pid}.tmp`);
    try {
      writeFileSync(tmp, m.certPem, { mode: 0o644 });
      renameSync(tmp, certPath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return m;
  }

  private reusable(certPem: string, keyPem: string, domain: string | null): CertMaterial | null {
    try {
      const x = new X509Certificate(certPem);
      if (!x.checkPrivateKey(createPrivateKey(keyPem))) return null;
      const now = this.now().getTime();
      const from = new Date(x.validFrom).getTime();
      const to = new Date(x.validTo).getTime();
      if (!(from <= now && now < to - RENEW_MARGIN_MS)) return null;
      if (domain !== null && x.checkHost(domain) === undefined) return null;
      const sans = (x.subjectAltName ?? "").split(", ").filter((s) => s.length > 0);
      return { certPem, keyPem, fingerprint: x.fingerprint256, expiresAt: new Date(to).toISOString(), subjectAltNames: sans };
    } catch {
      return null;
    }
  }

  private certificateChanged(actor: Actor, cfg: Config, m: CertMaterial): NewLedgerEntry {
    return {
      projectId: null,
      actor,
      type: "remote.certificate_changed",
      payload: { tls: cfg.tls, fingerprint: m.fingerprint, domain: cfg.domain, expiresAt: m.expiresAt },
    };
  }

  private commitDisabled(actor: Actor): void {
    commitEvents(this.deps.db, this.deps.ledger, () => ({
      events: [{ projectId: null, actor, type: "remote.disabled", payload: {} }],
      result: () => undefined,
    }));
  }

  private async listen(m: CertMaterial, port: number, bind: string): Promise<void> {
    const server = tls.createServer(
      {
        cert: m.certPem,
        key: m.keyPem,
        minVersion: "TLSv1.2",
        ALPNProtocols: ["http/1.1"],
        handshakeTimeout: REMOTE_HANDSHAKE_TIMEOUT_MS,
      },
      (socket) => {
        if (this.server !== server) {
          socket.destroy();
          return;
        }
        this.track(socket);
        // An idle network connection is closed. Reads and writes both count as activity, so a WebSocket kept alive by
        // the stream's pings stays; the http server's own header, request and keep-alive timeouts apply as well.
        socket.setTimeout(this.deps.idleTimeoutMs ?? REMOTE_IDLE_TIMEOUT_MS, () => socket.destroy());
        this.deps.http.emit("connection", socket);
      },
    );
    server.maxConnections = REMOTE_MAX_CONNECTIONS;
    server.on("connection", (socket: net.Socket) => this.track(socket));
    // A failed handshake (plain HTTP, a bad client hello, a timeout) closes the socket: no plain fallback, no log.
    server.on("tlsClientError", (_err, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.close();
        reject(new Error("listen timeout"));
      }, LISTEN_TIMEOUT_MS);
      server.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      server.listen({ port, host: bind, exclusive: true }, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    server.on("error", () => undefined);
    this.server = server;
    this.served = m;
  }

  private track(socket: net.Socket): void {
    if (this.sockets.has(socket)) return;
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  private async stopServer(spare?: unknown): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    this.served = null;
    // close() stops accepting at once; its callback waits for the open connections, which are destroyed below.
    const closed = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    const spared = spare instanceof net.Socket && (spare as Partial<TLSSocket>).encrypted === true ? spare : null;
    const kept = sameConnection(spared);
    for (const s of this.sockets) if (!kept(s)) s.destroy();
    this.sockets.clear();
    if (spared !== null) {
      // The spared connection ends after its response; a client that holds it open is cut off after the wait.
      setTimeout(() => spared.destroy(), CLOSE_TIMEOUT_MS).unref();
      return;
    }
    await closed;
  }

  private addressesFor(bind: string): string[] {
    if (bind !== "0.0.0.0" && bind !== "::") return [bind];
    const found = this.addressesOf().addresses;
    return found.length > 0 ? found : [bind === "::" ? "::1" : "127.0.0.1"];
  }
}

/** Matches a TLS socket and the TCP socket under it (same peer address and port). */
function sameConnection(spared: net.Socket | null): (s: net.Socket) => boolean {
  if (spared === null) return () => false;
  const { remoteAddress, remotePort } = spared;
  if (remoteAddress === undefined || remotePort === undefined) return (s) => s === spared;
  return (s) => s === spared || (s.remoteAddress === remoteAddress && s.remotePort === remotePort);
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

function parseFiles(raw: string | null): { certFile: string; keyFile: string } | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const { certFile, keyFile } = v as Record<string, unknown>;
    return typeof certFile === "string" && typeof keyFile === "string" ? { certFile, keyFile } : null;
  } catch {
    return null;
  }
}

/** The file's text when it exists and is at most 64 KiB, else null. */
function readBoundedText(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    if (!fstatSync(fd).isFile() || size > MAX_CERT_BYTES) return null;
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** A port free right now on `bind`, for `port: 0`: the entry must name the real port before the listener starts. */
function probePort(bind: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen({ port: 0, host: bind, exclusive: true }, () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}
