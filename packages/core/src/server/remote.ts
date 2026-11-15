import { X509Certificate, createPrivateKey } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import net, { isIP, isIPv4, isIPv6, type AddressInfo } from "node:net";
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
/** Milliseconds to bind the port, and to close it. */
const LISTEN_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;
/** Remote access binds loopback unless an address is configured: never wider than asked. */
const DEFAULT_BIND = "127.0.0.1";
/** A self-signed certificate this close to expiry is replaced. */
const RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;
const MAX_CERT_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 4096;
const SYSTEM: Actor = { kind: "system", id: "remote" };
const REMOTE_TYPES = new Set(["remote.enabled", "remote.disabled", "remote.certificate_changed"]);

/** The listener could not bind its port. The message is fixed. → 502 remote_start_failed */
export class RemoteStartError extends Error {
  constructor() {
    super("the remote listener could not start");
    this.name = "RemoteStartError";
  }
}

/**
 * The Owner has no passkey or key, so turning remote access on would lock them out of it. → 409
 * owner_credential_required. Task 1's people/service.ts defines the same error; the wiring task re-exports that one
 * from here so both modules throw one class.
 */
export class OwnerCredentialRequiredError extends Error {
  constructor() {
    super("the Owner needs a passkey or key before remote access can be turned on");
    this.name = "OwnerCredentialRequiredError";
  }
}

export type RemoteInputCode =
  | "invalid_port"
  | "invalid_bind"
  | "invalid_domain"
  | "invalid_tls"
  | "certificate_files_required"
  | "certificate_domain_mismatch"
  | "acme_unavailable";

const INPUT_MESSAGES: Record<RemoteInputCode, string> = {
  invalid_port: "The port must be a whole number from 1 to 65535.",
  invalid_bind: "The address to listen on must be an IP address.",
  invalid_domain: "The domain is not a valid DNS name.",
  invalid_tls: "The certificate mode is not known.",
  certificate_files_required: "Both a certificate file and a key file are needed.",
  certificate_domain_mismatch: "The certificate does not cover the domain.",
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
  uiDir: string;
  now?: () => Date;
  /** The machine's names and addresses for the certificate and the wildcard bind; tests inject fixed ones. */
  localAddresses?: () => { hostnames: string[]; addresses: string[] };
};

export type EnableInput = {
  port?: number;
  bind?: string;
  domain?: string | null;
  tls?: TlsMode;
  certFile?: string;
  keyFile?: string;
  /** Task 7 (ACME): the plain challenge server's port. */
  acmePort?: number;
};

export type RemoteView = RemoteState & { listening: boolean; addresses: string[] };

/** Remote state before any entry: off, on loopback. */
export const INITIAL_REMOTE: RemoteState = { ...DEFAULT_REMOTE, bind: DEFAULT_BIND };

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
 * The remote Host rule. With a domain: exactly `<domain>:<port>`. Without: an IPv4 literal, a bracketed IPv6 literal
 * or a `*.local` name, with the remote port. DNS rebinding needs a public name, which none of these is.
 */
export function remoteHostAllowed(host: string, remote: Pick<RemoteState, "port" | "domain">): boolean {
  if (typeof host !== "string" || host.length === 0 || host.length > 300) return false;
  const h = host.toLowerCase();
  const suffix = `:${remote.port}`;
  if (!h.endsWith(suffix)) return false;
  const name = h.slice(0, -suffix.length);
  if (remote.domain !== null) return name === remote.domain.toLowerCase();
  if (name.startsWith("[") && name.endsWith("]")) {
    const inner = name.slice(1, -1);
    return !inner.includes("%") && isIPv6(inner);
  }
  if (isIPv4(name)) return true;
  return name.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/.test(name);
}

/** Whether a request is the health probe, which alone skips the Host check (it answers `{ ok: true }` only). */
export function isHealthz(request: { method: string; routeOptions: { url?: string } }): boolean {
  return (request.method === "GET" || request.method === "HEAD") && request.routeOptions.url === HEALTHZ_PATH;
}

/** Step (2) of the auth hook for the remote listener: the health probe passes, anything else needs an allowed Host. */
export function checkRemoteHost(
  request: { method: string; routeOptions: { url?: string }; headers: { host?: string } },
  remote: Pick<RemoteState, "port" | "domain">,
): boolean {
  return isHealthz(request) || remoteHostAllowed(request.headers.host ?? "", remote);
}

type Config = { port: number; bind: string; domain: string | null; tls: TlsMode };

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
  private chain: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: RemoteDeps) {
    this.now = deps.now ?? (() => new Date());
    this.addressesOf = deps.localAddresses ?? (() => machineAddresses());
    this.current = readRemoteState(deps.db);
    this.unsubscribe = deps.ledger.onAppend((e) => {
      if (REMOTE_TYPES.has(e.type)) this.current = applyRemoteEntry(this.current, e);
    });
  }

  state(): RemoteView {
    const listening = this.server !== null;
    return { ...this.current, listening, addresses: listening ? this.addressesFor(this.current.bind) : [] };
  }

  /**
   * Turns remote access on (or reconfigures it). Order: certificate material → `remote.certificate_changed` when the
   * certificate is new → `remote.enabled` → listen; a listen failure commits `remote.disabled` and throws
   * RemoteStartError. Errors before the commit record nothing.
   */
  enable(actor: Actor, i: EnableInput): Promise<RemoteState> {
    return this.serial(async () => {
      if (!this.deps.people.hasOwnerCredential()) throw new OwnerCredentialRequiredError();
      if (this.deps.ledger.readOnly) throw new LedgerReadOnlyError();
      const cfg = this.resolve(i);
      const material = await this.material(cfg, i);
      await this.stopServer();
      let port = cfg.port;
      if (port === 0) {
        try {
          port = await probePort(cfg.bind);
        } catch {
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
      try {
        await this.listen(material, port, cfg.bind);
      } catch {
        this.commitDisabled(SYSTEM);
        throw new RemoteStartError();
      }
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
        const material = await this.material(cfg, {});
        if (material.fingerprint !== s.fingerprint) {
          commitEvents(this.deps.db, this.deps.ledger, () => ({
            events: [this.certificateChanged(SYSTEM, cfg, material)],
            result: () => undefined,
          }));
        }
        await this.listen(material, cfg.port, cfg.bind);
      } catch {
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
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private publicState(): RemoteState {
    const { listening: _l, addresses: _a, ...rest } = this.state();
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
    if (mode === "acme") throw new RemoteInputError("acme_unavailable");
    for (const p of [i.certFile, i.keyFile]) {
      if (p !== undefined && (typeof p !== "string" || p.length === 0 || p.length > MAX_PATH_LENGTH)) {
        throw new RemoteInputError("certificate_files_required");
      }
    }
    if ((i.certFile === undefined) !== (i.keyFile === undefined)) throw new RemoteInputError("certificate_files_required");
    return { port, bind, domain: domain === null ? null : domain.toLowerCase(), tls: mode };
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
