import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  CONNECTION_CATALOG,
  connectionConfigSchema,
  connectionNameSchema,
  eventPayloadSchemas,
  type Actor,
  type CatalogEntry,
  type Connection,
  type ConnectionField,
  type ConnectionKind,
  type ConnectionProvider,
  type FieldStorage,
  type CapacityHardware,
  type HardwareInfo,
  type NewLedgerEntry,
  type Provider,
} from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { commitEvent } from "../events/commit.js";
import { NotFoundError } from "../board/board-service.js";
import { redact, truncate } from "../agents/redact.js";
import { MAX_SECRET_BYTES, SecretStoreUnavailableError, type SecretStore } from "../secrets/store.js";
import { pairsKind, parsePairs, toMcpSpec, type McpServerSpec } from "./mcp.js";
import { privateKeySecrets } from "./cloud/gcp.js";
import { hardwareConfig, hardwareFromConfig } from "../capacity/hardware.js";

/** A provider that allows one connection already has one. */
export class ConflictError extends Error {
  constructor(message = "this provider is already connected") {
    super(message);
    this.name = "ConflictError";
  }
}

/** A config value looks like a credential; it belongs in a secret field. */
export class SecretInConfigError extends Error {
  constructor() {
    super("config contains a secret");
    this.name = "SecretInConfigError";
  }
}

/** A field (or provider) the catalog does not offer, or a field given under the wrong storage. */
export class UnknownFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownFieldError";
  }
}

/** A connection that is switched off was asked for. */
export class ConnectionDisabledError extends Error {
  constructor(message = "connection is disabled") {
    super(message);
    this.name = "ConnectionDisabledError";
  }
}

/** A connection that cannot be used this way: given to a run (a model, GitHub, hardware), or written by hand (hardware). */
export class UnsupportedConnectionError extends Error {
  constructor(message = "this connection cannot be given to a run") {
    super(message);
    this.name = "UnsupportedConnectionError";
  }
}

export type CloudSource = {
  connectionId: string;
  name: string;
  provider: "aws" | "gcp" | "azure";
  config: Record<string, string>;
  secrets: Record<string, string>;
};
export type RunSelection = { cloud: CloudSource[]; mcp: McpServerSpec[] };
export type GitHubSource = { connectionId: string; token: string; repo: string } | null;
export type Budget = { connectionId: string; provider: Provider; name: string; plan: string | null; monthlyBudgetUsd: number | null };

export type ConnectionTester = (
  input: { config: Record<string, string>; private: Record<string, string>; secrets: Record<string, string> },
  deps: { fetch: typeof fetch; signal: AbortSignal },
) => Promise<{ ok: boolean; message: string }>;

export type Credentials = {
  connectionId: string;
  name: string;
  apiKey?: string;
  cliHome?: string;
  googleCloudProject?: string;
};

export type ConnectionServiceDeps = {
  db: Db;
  ledger: Ledger;
  secrets: SecretStore;
  testers: Partial<Record<ConnectionProvider, ConnectionTester>>;
  fetch?: typeof fetch;
  newId?: () => string;
  testTimeoutMs?: number;
};

export type AddConnectionInput = {
  kind: ConnectionKind;
  provider: ConnectionProvider;
  name: string;
  config?: Record<string, string>;
  secrets?: Record<string, string>;
  private?: Record<string, string>;
};

export type UpdateConnectionPatch = {
  name?: string;
  config?: Record<string, string>;
  enabled?: boolean;
  secrets?: Record<string, string | null>;
  private?: Record<string, string | null>;
};

type Row = {
  id: string; kind: ConnectionKind; provider: ConnectionProvider; name: string; enabled: number; config: string;
  secret_fields: string; private_fields: string; status_state: Connection["status"]["state"]; status_message: string;
  tested_at: string | null; created_at: string; updated_at: string;
};

/** One keychain write (`value`) or delete (`null`) for a field. */
type KeychainOp = { field: string; value: string | null; secret: boolean };
/** What a done op replaced, so it can be put back: `undefined` means nothing was stored. */
type Undo = { account: string; previous: string | undefined };

const UNTESTABLE = "Testing is not available for this connection yet";
const UNREACHABLE = "Could not reach the provider";
/** How long past its own timeout a tester may run before it is abandoned. */
const TESTER_GRACE_MS = 1000;
/** Written only by hardware detection, never through `add`/`update`. */
const DETECTED_PROVIDER: ConnectionProvider = "local_hardware";
const MANAGED_BY_DETECTION = "this connection is managed by detection";
/** Kinds whose connections a run may be given. */
const RUN_KINDS: ReadonlySet<ConnectionKind> = new Set(["cloud", "mcp"]);
const NUMBER_VALUE = /^\d{1,9}(\.\d{1,2})?$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

const accountFor = (connectionId: string, field: string): string => `connection/${connectionId}/${field}`;

/** Caller-supplied field names are echoed in errors only when they have this plain shape. */
const PLAIN_FIELD_NAME = /^[a-z][A-Za-z0-9]{0,40}$/;
/** Shorter secrets (flags, short words) would redact ordinary text everywhere once stored. */
const MIN_SECRET_LENGTH = 8;
/** How long after a failed load the next read-driven retry (a test, a status read) may try again. */
const RETRY_LOAD_MS = 30_000;

/**
 * The non-null string values of a request's secret and private fields, so names and config are checked against them
 * too. Values shorter than a secret may be (a private folder such as `/x`) are left out: they would refuse ordinary names.
 */
function requestValues(...groups: Record<string, string | null>[]): string[] {
  return groups
    .flatMap((g) => Object.values(g))
    .filter((v): v is string => typeof v === "string" && v.length >= MIN_SECRET_LENGTH);
}

/**
 * The secret strings in a Google Cloud key, if it parses: its private key (whole, JSON-escaped and line by line, see
 * privateKeySecrets) and private_key_id, those long enough to be secrets.
 */
function serviceAccountSecrets(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return [];
    const { private_key: key, private_key_id: keyId } = parsed as Record<string, unknown>;
    const values = [...(typeof key === "string" ? privateKeySecrets(key) : []), keyId];
    return values.filter((v): v is string => typeof v === "string" && v.length >= MIN_SECRET_LENGTH);
  } catch {
    return []; // A value that is not JSON stays redacted as a whole.
  }
}

/** Writes and deletes for the given secret and private values, secrets first. */
function toOps(secrets: Record<string, string | null>, priv: Record<string, string | null>): KeychainOp[] {
  return [
    ...Object.entries(secrets).map(([field, value]) => ({ field, value, secret: true })),
    ...Object.entries(priv).map(([field, value]) => ({ field, value, secret: false })),
  ];
}

const MCP_PROVIDERS: ReadonlySet<ConnectionProvider> = new Set(["mcp_stdio", "mcp_http"]);
const MCP_VAR_REFERENCE = 'must not contain "${": the agent program would read it as a reference to one of its variables';

function invalid(path: (string | number)[], message: string): never {
  throw new z.ZodError([{ code: "custom", path, message }]);
}

const catalogFor = (provider: ConnectionProvider): CatalogEntry | undefined =>
  CONNECTION_CATALOG.find((e) => e.provider === provider);

/**
 * Why a URL is refused, or null: it must be https, or http to this computer only. A URL is config and reaches the
 * ledger, so one carrying a user name, a password, a query string or a fragment (where tokens tend to go) is refused too.
 */
function urlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an https URL, or http on localhost";
  }
  if (!(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))) {
    return "must be an https URL, or http on localhost";
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || /[?#]/.test(url.href)) {
    return "Put credentials in Headers, not in the URL.";
  }
  return null;
}

/**
 * Checks a value against its field's input type and catalog pattern. Failures name the field's path, never the value.
 * A "pairs" field is parsed, so a bad line is refused at [field, line] before anything is stored.
 */
function checkFormat(provider: ConnectionProvider, field: ConnectionField, value: string, path: (string | number)[]): void {
  if (field.input === "number" && !NUMBER_VALUE.test(value)) invalid(path, "must be a number with at most 2 decimals");
  const badUrl = field.input === "url" ? urlProblem(value) : null;
  if (badUrl !== null) invalid(path, badUrl);
  if (field.pattern !== undefined && !new RegExp(field.pattern).test(value)) invalid(path, "is not in the expected format");
  if (field.format === "pairs") parsePairs(value, pairsKind(provider));
  // Claude Code expands ${VAR} in an MCP server's command, arguments, URL, env and headers from its own env, which
  // holds the run's other secrets: a reference there could hand one to the server. Its syntax has no escape.
  if (MCP_PROVIDERS.has(provider) && value.includes("${")) invalid(path, MCP_VAR_REFERENCE);
}

/**
 * Connections to model providers and services. Secret and private values live only in the keychain (and an
 * in-process cache); the ledger and the projection hold field names. Every change is a `connection.*` event.
 */
export class ConnectionService {
  private readonly db: Db;
  private readonly ledger: Ledger;
  private readonly secrets: SecretStore;
  private readonly testers: Partial<Record<ConnectionProvider, ConnectionTester>>;
  private readonly fetchImpl: typeof fetch;
  private readonly newId: () => string;
  private readonly testTimeoutMs: number;
  /** connectionId → field → value, for secret and private fields. */
  private cache = new Map<string, Record<string, string>>();
  /** Every secret value loaded or set in this process, removed ones included, for redaction. */
  private readonly seen = new Set<string>();
  private state: "ok" | "unavailable" = "ok";
  /** The last keychain write or delete failed as unavailable (the cache stays good); cleared by the next success. */
  private writeFailed = false;
  /** The tail of the hardware detections being recorded (see writeHardware). */
  private hardwareWrites: Promise<unknown> = Promise.resolve();
  /** Whether a `load()` has succeeded since the process started. */
  private loaded = false;
  private loading: Promise<void> | null = null;
  /** When `retryIfUnavailable` last loaded. */
  private lastRetryAt = 0;
  /** Per-connection tail of the operation chain; operations on one id run one at a time. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Bumped when a cache-changing operation on a connection starts and ends; lets a load keep newer entries. */
  private readonly versions = new Map<string, number>();
  /** Cache-changing operations in progress per connection. */
  private readonly inFlight = new Map<string, number>();

  constructor(deps: ConnectionServiceDeps) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.secrets = deps.secrets;
    this.testers = deps.testers;
    this.fetchImpl = deps.fetch ?? fetch;
    this.newId = deps.newId ?? (() => randomUUID());
    this.testTimeoutMs = deps.testTimeoutMs ?? 10_000;
  }

  /**
   * Reads every stored value into the cache. A keychain failure marks it unavailable and leaves the cache as it was
   * (empty before the first good load; never values dropped that a good load already read).
   * Safe to run alongside other operations: a connection changed or removed while the load ran keeps its current
   * cache entry (or none), never the values the load read before the change.
   */
  async load(): Promise<void> {
    const startVersions = new Map(this.versions);
    const next = new Map<string, Record<string, string>>();
    let read = false; // whether the keychain answered at least one read, which shows it is back after a failed write
    try {
      for (const row of this.rows()) {
        const values: Record<string, string> = {};
        for (const [field, storage] of this.storedFields(row)) {
          const value = await this.secrets.get(accountFor(row.id, field));
          read = true;
          if (value === null) continue;
          values[field] = value;
          if (storage === "secret") this.remember(row.provider, field, value);
        }
        next.set(row.id, values);
      }
    } catch {
      this.state = "unavailable";
      return;
    }
    const merged = new Map<string, Record<string, string>>();
    for (const { id } of this.rows()) {
      const changed = (this.versions.get(id) ?? 0) !== (startVersions.get(id) ?? 0) || (this.inFlight.get(id) ?? 0) > 0;
      const entry = changed ? this.cache.get(id) : next.get(id);
      if (entry) merged.set(id, entry);
    }
    this.cache = merged;
    this.state = "ok";
    if (read) this.writeFailed = false;
    this.loaded = true;
  }

  /** "unavailable" after a failed load, or after a failed write until a later write or load succeeds. */
  keychainState(): "ok" | "unavailable" {
    return this.state === "ok" && !this.writeFailed ? "ok" : "unavailable";
  }

  /**
   * While the keychain is unavailable, tries it again, at most once per RETRY_LOAD_MS: a read (a connection test, a
   * status read) is enough for the state to recover once the keychain is back. After a failed load it loads again.
   * After a failed write (the cache is good) it only probes with one read that leaves the cache alone, and clears the
   * mark when that read succeeds. Never throws.
   */
  async retryIfUnavailable(): Promise<void> {
    if (this.keychainState() === "ok") return;
    const now = Date.now();
    if (now - this.lastRetryAt < RETRY_LOAD_MS) return;
    this.lastRetryAt = now;
    if (this.state === "unavailable") return this.reload();
    const account = this.firstStoredAccount();
    if (account === null) return; // nothing to read: only a good write can show the keychain is back
    try {
      await this.secrets.get(account);
      this.writeFailed = false;
    } catch {
      // Still down: the cache and the state stay as they are.
    }
  }

  /** The keychain account of some field the projection lists, or null when none is stored. */
  private firstStoredAccount(): string | null {
    for (const row of this.rows()) {
      const [first] = this.storedFields(row);
      if (first) return accountFor(row.id, first[0]);
    }
    return null;
  }

  list(): Connection[] {
    return this.rows().map((r) => this.toConnection(r));
  }

  get(id: string): Connection {
    return this.toConnection(this.requireRow(id));
  }

  async add(actor: Actor, input: AddConnectionInput): Promise<Connection> {
    if (input.provider === DETECTED_PROVIDER) throw new UnsupportedConnectionError(MANAGED_BY_DETECTION);
    await this.tryLoad();
    const entry = this.availableEntry(input.provider);
    if (entry.kind !== input.kind) invalid(["provider"], "provider does not belong to this kind");
    const secrets = input.secrets ?? {};
    const priv = input.private ?? {};
    this.checkValues(entry, "secret", secrets, ["secrets"]);
    this.checkValues(entry, "private", priv, ["private"]);
    const same = requestValues(secrets, priv);
    const name = this.checkName(input.name, same);
    const config = this.checkConfig(entry, input.config ?? {}, same);
    for (const f of entry.fields) {
      const given = f.storage === "secret" ? secrets : f.storage === "private" ? priv : config;
      if (f.required && given[f.name] === undefined) invalid([f.storage === "secret" ? "secrets" : f.storage, f.name], "required");
    }
    this.assertNoConflict(entry);

    const connectionId = this.newId();
    const payload = eventPayloadSchemas["connection.added"].parse({
      connectionId, kind: entry.kind, provider: entry.provider, name, config,
      secretFields: Object.keys(secrets).sort(), privateFields: Object.keys(priv).sort(),
    });
    const ops = toOps(secrets, priv);
    return this.exclusive(connectionId, async () => {
      await this.commitWithKeychain(connectionId, entry.provider, ops, () => {
        this.assertNoConflict(entry);
        return { projectId: null, actor, type: "connection.added", payload };
      });
      return this.get(connectionId);
    });
  }

  update(actor: Actor, id: string, patch: UpdateConnectionPatch): Promise<Connection> {
    return this.exclusive(id, () => this.updateNow(actor, id, patch));
  }

  private async updateNow(actor: Actor, id: string, patch: UpdateConnectionPatch): Promise<Connection> {
    const row = this.requireRow(id);
    // The Owner may switch This computer off or on; only detection writes its fields.
    const onlyEnabled = Object.keys(patch).every((k) => k === "enabled" || patch[k as keyof UpdateConnectionPatch] === undefined);
    if (row.provider === DETECTED_PROVIDER && !onlyEnabled) throw new UnsupportedConnectionError(MANAGED_BY_DETECTION);
    await this.tryLoad();
    const entry = this.availableEntry(row.provider);
    const changes: Record<string, unknown> = {};
    const secrets = patch.secrets ?? {};
    const priv = patch.private ?? {};
    this.checkValues(entry, "secret", secrets, ["secrets"]);
    this.checkValues(entry, "private", priv, ["private"]);
    const same = requestValues(secrets, priv);
    if (patch.name !== undefined) changes.name = this.checkName(patch.name, same);
    if (patch.config !== undefined) changes.config = this.checkConfig(entry, patch.config, same);
    if (patch.enabled !== undefined) changes.enabled = z.boolean().parse(patch.enabled);
    for (const f of entry.fields) {
      const given = f.storage === "secret" ? secrets : f.storage === "private" ? priv : {};
      if (f.required && given[f.name] === null) invalid([f.storage === "secret" ? "secrets" : f.storage, f.name], "required");
      // A new config replaces the old one whole, so it must still hold every required field.
      if (f.required && f.storage === "config" && patch.config !== undefined && patch.config[f.name] === undefined) {
        invalid(["config", f.name], "required");
      }
    }
    const setOf = (values: Record<string, string | null>) => Object.keys(values).filter((k) => values[k] !== null).sort();
    const removedOf = (values: Record<string, string | null>) => Object.keys(values).filter((k) => values[k] === null).sort();
    const lists = {
      secretsSet: setOf(secrets), secretsRemoved: removedOf(secrets), privateSet: setOf(priv), privateRemoved: removedOf(priv),
    };
    for (const [key, fields] of Object.entries(lists)) if (fields.length > 0) changes[key] = fields;

    const payload = eventPayloadSchemas["connection.updated"].parse({
      connectionId: id, name: (changes.name as string | undefined) ?? row.name, changes,
    });
    // Writes before deletes: a failed write then leaves nothing deleted.
    const all = toOps(secrets, priv);
    const ops = [...all.filter((op) => op.value !== null), ...all.filter((op) => op.value === null)];
    await this.commitWithKeychain(id, row.provider, ops, () => {
      this.requireRow(id);
      return { projectId: null, actor, type: "connection.updated", payload };
    });
    return this.get(id);
  }

  remove(actor: Actor, id: string): Promise<void> {
    return this.exclusive(id, () => this.removeNow(actor, id));
  }

  private removeNow(actor: Actor, id: string): Promise<void> {
    return this.mutating(id, () => this.removeTracked(actor, id));
  }

  private async removeTracked(actor: Actor, id: string): Promise<void> {
    const row = this.requireRow(id);
    if (this.storedFields(row).length > 0) await this.ensureKeychain();
    commitEvent(this.db, this.ledger, () => {
      this.requireRow(id);
      return { event: { projectId: null, actor, type: "connection.removed", payload: { connectionId: id, name: row.name } }, result: () => undefined };
    });
    // The connection is gone from the ledger; a leftover keychain entry is harmless and must not fail the removal.
    for (const [field] of this.storedFields(row)) {
      await this.secrets.delete(accountFor(id, field)).catch(() => undefined);
    }
    this.cache.delete(id);
  }

  test(actor: Actor, id: string): Promise<{ ok: boolean; message: string }> {
    return this.exclusive(id, () => this.testNow(actor, id));
  }

  private async testNow(actor: Actor, id: string): Promise<{ ok: boolean; message: string }> {
    const row = this.requireRow(id);
    await this.retryIfUnavailable();
    const tester = catalogFor(row.provider)?.available ? this.testers[row.provider] : undefined;
    let result: { ok: boolean; message: string };
    if (!tester) {
      result = { ok: false, message: UNTESTABLE };
    } else {
      const values = this.cache.get(id) ?? {};
      const stored = new Map(this.storedFields(row));
      const pick = (storage: FieldStorage) =>
        Object.fromEntries(Object.entries(values).filter(([f]) => stored.get(f) === storage));
      // A tester that ignores the signal must still let go of the connection's lock.
      let timer: NodeJS.Timeout | undefined;
      const hung = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("tester timed out")), this.testTimeoutMs + TESTER_GRACE_MS);
      });
      try {
        result = await Promise.race([
          tester(
            { config: JSON.parse(row.config), private: pick("private"), secrets: pick("secret") },
            { fetch: this.fetchImpl, signal: AbortSignal.timeout(this.testTimeoutMs) },
          ),
          hung,
        ]);
      } catch {
        result = { ok: false, message: UNREACHABLE };
      } finally {
        clearTimeout(timer);
      }
    }
    // Redact before truncating, so a cut can never leave half a secret unmatched.
    const message = truncate(redact(String(result.message), this.secretValues()), 500);
    const ok = result.ok === true;
    commitEvent(this.db, this.ledger, () => {
      this.requireRow(id);
      return {
        event: { projectId: null, actor, type: "connection.tested", payload: { connectionId: id, name: row.name, ok, message } },
        result: () => undefined,
      };
    });
    return { ok, message };
  }

  /** The enabled model connection for `provider`, from the cache. */
  credentialsFor(provider: Provider): Credentials | null {
    if (this.state !== "ok") return null;
    const row = this.db
      .prepare("SELECT * FROM connections WHERE provider = ? AND kind = 'llm' AND enabled = 1 ORDER BY created_at, rowid LIMIT 1")
      .get(provider) as Row | undefined;
    if (!row) return null;
    const values = this.cache.get(row.id) ?? {};
    const config = JSON.parse(row.config) as Record<string, string>;
    const creds: Credentials = { connectionId: row.id, name: row.name };
    if (values.apiKey) creds.apiKey = values.apiKey;
    if (values.cliHome) creds.cliHome = values.cliHome;
    if (config.googleCloudProject) creds.googleCloudProject = config.googleCloudProject;
    return creds;
  }

  secretValues(): string[] {
    return [...this.seen];
  }

  /**
   * What a run is given for `ids`, from the cache: cloud accounts with their secrets and MCP server specs, in the order
   * asked, duplicates collapsed. Refuses unknown, wrong-kind and disabled ids, and an unavailable keychain (a run must
   * not start with half its secrets), before anything is returned.
   */
  selectForRun(ids: string[]): RunSelection {
    const rows = [...new Set(ids)].map((id) => this.requireRow(id));
    for (const row of rows) {
      if (!RUN_KINDS.has(row.kind)) throw new UnsupportedConnectionError();
      if (row.enabled !== 1) throw new ConnectionDisabledError();
    }
    if (rows.length > 0 && this.keychainState() !== "ok") throw new SecretStoreUnavailableError();
    // Every field the projection lists must be in the cache: a run never gets an incomplete source.
    for (const row of rows) {
      const values = this.cache.get(row.id) ?? {};
      if (this.storedFields(row).some(([f]) => values[f] === undefined)) throw new SecretStoreUnavailableError();
    }
    const selection: RunSelection = { cloud: [], mcp: [] };
    for (const row of rows) {
      const values = this.cache.get(row.id) ?? {};
      if (row.kind === "mcp") {
        selection.mcp.push(toMcpSpec(this.toConnection(row), values));
        continue;
      }
      const secretFields = new Set(JSON.parse(row.secret_fields) as string[]);
      selection.cloud.push({
        connectionId: row.id, name: row.name, provider: row.provider as CloudSource["provider"],
        config: JSON.parse(row.config) as Record<string, string>,
        secrets: Object.fromEntries(Object.entries(values).filter(([f]) => secretFields.has(f))),
      });
    }
    return selection;
  }

  /** The enabled GitHub connection with a stored token and a repository, else null. */
  githubSource(): GitHubSource {
    const row = this.db
      .prepare("SELECT * FROM connections WHERE provider = 'github' AND enabled = 1 ORDER BY created_at, rowid LIMIT 1")
      .get() as Row | undefined;
    if (!row) return null;
    const token = this.cache.get(row.id)?.token;
    const repo = (JSON.parse(row.config) as Record<string, string>).repo;
    return token && repo ? { connectionId: row.id, token, repo } : null;
  }

  /**
   * Records a hardware detection in the This computer connection: added when absent, else updated with the new config
   * (every detection is recorded, as its time changes). Whether it is enabled stays the Owner's choice. Detections run
   * one at a time, so two at once never both add it.
   */
  writeHardware(actor: Actor, info: HardwareInfo): Promise<Connection> {
    const next = this.hardwareWrites.then(() => this.writeHardwareNow(actor, info));
    this.hardwareWrites = next.catch(() => undefined);
    return next;
  }

  private async writeHardwareNow(actor: Actor, info: HardwareInfo): Promise<Connection> {
    const entry = this.availableEntry(DETECTED_PROVIDER);
    const config = this.checkConfig(entry, hardwareConfig(info), []);
    const existing = this.rows().find((r) => r.provider === DETECTED_PROVIDER);
    if (existing) {
      const payload = eventPayloadSchemas["connection.updated"].parse({ connectionId: existing.id, name: existing.name, changes: { config } });
      return this.exclusive(existing.id, async () => {
        await this.commitWithKeychain(existing.id, DETECTED_PROVIDER, [], () => {
          this.requireRow(existing.id);
          return { projectId: null, actor, type: "connection.updated", payload };
        });
        return this.get(existing.id);
      });
    }
    const connectionId = this.newId();
    const payload = eventPayloadSchemas["connection.added"].parse({
      connectionId, kind: entry.kind, provider: entry.provider, name: entry.label, config, secretFields: [], privateFields: [],
    });
    return this.exclusive(connectionId, async () => {
      await this.commitWithKeychain(connectionId, DETECTED_PROVIDER, [], () => {
        this.assertNoConflict(entry);
        return { projectId: null, actor, type: "connection.added", payload };
      });
      return this.get(connectionId);
    });
  }

  /** The last detection recorded in the This computer connection, with whether it is enabled; null when none. */
  hardware(): CapacityHardware | null {
    const row = this.rows().find((r) => r.provider === DETECTED_PROVIDER);
    const info = row ? hardwareFromConfig(JSON.parse(row.config) as Record<string, string>) : null;
    return row && info ? { ...info, enabled: row.enabled === 1 } : null;
  }

  /** The plan and monthly budget of each enabled model connection. */
  budgets(): Budget[] {
    return this.rows()
      .filter((r) => r.kind === "llm" && r.enabled === 1)
      .map((r) => {
        const config = JSON.parse(r.config) as Record<string, string>;
        return {
          connectionId: r.id, provider: r.provider as Provider, name: r.name, plan: config.plan ?? null,
          monthlyBudgetUsd: config.monthlyBudgetUsd === undefined ? null : Number(config.monthlyBudgetUsd),
        };
      });
  }

  /**
   * Adds a secret value to the redaction list. The values of a "pairs" field are added one by one too (those long
   * enough to be secrets), so a header or variable is redacted on its own, not only as the whole blob. Likewise a
   * Google Cloud key's private key (parsed, JSON-escaped and each long body line) and private_key_id: in the JSON the
   * key's line breaks are escaped, so the key as a tool might print it would not match the stored text.
   */
  private remember(provider: ConnectionProvider, field: string, value: string): void {
    this.seen.add(value);
    if (provider === "gcp" && field === "serviceAccountJson") {
      for (const v of serviceAccountSecrets(value)) this.seen.add(v);
      return;
    }
    const def = catalogFor(provider)?.fields.find((f) => f.name === field);
    if (def?.format !== "pairs") return;
    try {
      for (const v of Object.values(parsePairs(value, pairsKind(provider)))) {
        if (v.length >= MIN_SECRET_LENGTH) this.seen.add(v);
      }
    } catch {
      // A stored value that no longer parses stays redacted as a whole.
    }
  }

  /**
   * Applies `ops` to the keychain, then commits the event. If a keychain op or the commit fails, every op done
   * in this call is undone (best effort: the previous value is put back, or the entry deleted) and the error rethrown.
   */
  private async commitWithKeychain(
    connectionId: string, provider: ConnectionProvider, ops: KeychainOp[], build: () => NewLedgerEntry,
  ): Promise<void> {
    if (ops.length > 0) await this.ensureKeychain();
    await this.mutating(connectionId, () => this.applyAndCommit(connectionId, provider, ops, build));
  }

  private async applyAndCommit(
    connectionId: string, provider: ConnectionProvider, ops: KeychainOp[], build: () => NewLedgerEntry,
  ): Promise<void> {
    const cached = this.cache.get(connectionId) ?? {};
    const done: Undo[] = [];
    try {
      for (const op of ops) {
        const account = accountFor(connectionId, op.field);
        // A value the cache does not hold (an entry the projection does not list) is read, so undo can restore it.
        const previous = Object.hasOwn(cached, op.field) ? cached[op.field] : ((await this.secrets.get(account)) ?? undefined);
        if (previous !== undefined && op.secret) this.remember(provider, op.field, previous);
        done.push({ account, previous });
        if (op.value === null) await this.secrets.delete(account);
        else await this.secrets.set(account, op.value);
      }
      if (ops.length > 0) this.writeFailed = false;
      commitEvent(this.db, this.ledger, () => ({ event: build(), result: () => undefined }));
    } catch (err) {
      if (err instanceof SecretStoreUnavailableError) this.writeFailed = true;
      for (const u of done.reverse()) {
        const undo = u.previous === undefined ? this.secrets.delete(u.account) : this.secrets.set(u.account, u.previous);
        await undo.catch(() => undefined);
      }
      throw err;
    }
    const next = { ...cached };
    for (const op of ops) {
      if (op.value === null) delete next[op.field];
      else next[op.field] = op.value;
      if (op.value !== null && op.secret) this.remember(provider, op.field, op.value);
    }
    this.cache.set(connectionId, next);
  }

  /**
   * Makes sure the cache reflects the keychain before it is changed: loads it if no load has succeeded yet (or the
   * last one failed). Throws `SecretStoreUnavailableError`, before anything is written, when the keychain stays down.
   */
  private async ensureKeychain(): Promise<void> {
    await this.tryLoad();
    if (this.state !== "ok") throw new SecretStoreUnavailableError();
  }

  /**
   * Loads the cache if no load has succeeded yet or the last one failed, so name and config checks see every stored
   * secret. Never throws: with the keychain still down, callers go on with pattern redaction only.
   */
  private async tryLoad(): Promise<void> {
    if (this.loaded && this.state === "ok") return;
    await this.reload();
  }

  /** One `load()` at a time: concurrent callers share the one under way. */
  private reload(): Promise<void> {
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** Marks a cache-changing operation on `id` for the duration of `fn`, so a concurrent `load()` keeps its result. */
  private async mutating<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const bump = () => this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1);
    bump();
    try {
      return await fn();
    } finally {
      bump();
      const left = this.inFlight.get(id)! - 1;
      if (left === 0) this.inFlight.delete(id);
      else this.inFlight.set(id, left);
    }
  }

  /** Runs `fn` after every earlier operation on the same connection has settled. */
  private exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  /**
   * Names reach the ledger too, so a name that `redact` would change is refused like a config value. `same` holds the
   * secret and private values of the request itself, which are not stored yet when the name is checked.
   */
  private checkName(input: string, same: string[]): string {
    const name = connectionNameSchema.parse(input);
    if (redact(name, [...this.secretValues(), ...same]) !== name) throw new SecretInConfigError();
    return name;
  }

  private availableEntry(provider: ConnectionProvider): CatalogEntry {
    const entry = catalogFor(provider);
    if (!entry) throw new UnknownFieldError("unknown provider");
    if (!entry.available) throw new UnknownFieldError(`${entry.label} connections are not available yet`);
    return entry;
  }

  private assertNoConflict(entry: CatalogEntry): void {
    if (!entry.single) return;
    if (this.db.prepare("SELECT 1 FROM connections WHERE provider = ?").get(entry.provider)) {
      throw new ConflictError(`${entry.label} is already connected`);
    }
  }

  private checkFields(entry: CatalogEntry, storage: FieldStorage, names: string[]): void {
    for (const name of names) {
      if (!entry.fields.some((f) => f.name === name && f.storage === storage)) {
        throw new UnknownFieldError(PLAIN_FIELD_NAME.test(name) ? `unknown ${storage} field: ${name}` : "unknown field");
      }
    }
  }

  /** Config goes to the ledger, so a value that `redact` would change is refused outright (`same`: see `checkName`). */
  private checkConfig(entry: CatalogEntry, input: Record<string, string>, same: string[]): Record<string, string> {
    const config = connectionConfigSchema.parse(input);
    this.checkFields(entry, "config", Object.keys(config));
    for (const [name, value] of Object.entries(config)) checkFormat(entry.provider, entry.fields.find((f) => f.name === name)!, value, ["config", name]);
    const secrets = [...this.secretValues(), ...same];
    if (JSON.stringify(redact(config, secrets)) !== JSON.stringify(config)) throw new SecretInConfigError();
    return config;
  }

  private checkValues(entry: CatalogEntry, storage: "secret" | "private", values: Record<string, string | null>, path: string[]): void {
    this.checkFields(entry, storage, Object.keys(values));
    for (const [name, value] of Object.entries(values)) {
      if (value === null) continue;
      const field = entry.fields.find((f) => f.name === name)!;
      if (typeof value !== "string" || value.length === 0) invalid([...path, name], "must be a non-empty string");
      if (storage === "secret" && value.length < MIN_SECRET_LENGTH) invalid([...path, name], `must be at least ${MIN_SECRET_LENGTH} characters`);
      if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) invalid([...path, name], `must be at most ${MAX_SECRET_BYTES} bytes`);
      if (field.input !== "multiline" && /[\r\n]/.test(value)) invalid([...path, name], "must be a single line");
      // A relative folder would resolve against wherever the CLI happens to start (the run's worktree).
      if (field.input === "path" && !isAbsolute(value)) invalid([...path, name], "must be an absolute path");
      checkFormat(entry.provider, field, value, [...path, name]);
    }
  }

  private rows(): Row[] {
    return this.db.prepare("SELECT * FROM connections ORDER BY created_at, rowid").all() as Row[];
  }

  private requireRow(id: string): Row {
    const row = this.db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError("connection", id);
    return row;
  }

  /** Every keychain-held field the projection lists for `row`, with its storage. */
  private storedFields(row: Row): [string, "secret" | "private"][] {
    return [
      ...(JSON.parse(row.secret_fields) as string[]).map((f): [string, "secret"] => [f, "secret"]),
      ...(JSON.parse(row.private_fields) as string[]).map((f): [string, "private"] => [f, "private"]),
    ];
  }

  private toConnection(r: Row): Connection {
    const values = this.cache.get(r.id) ?? {};
    const privateFields = JSON.parse(r.private_fields) as string[];
    const priv: Record<string, string> = {};
    for (const f of privateFields) if (values[f] !== undefined) priv[f] = values[f]!;
    return {
      id: r.id, kind: r.kind, provider: r.provider, name: r.name, enabled: r.enabled === 1,
      config: JSON.parse(r.config), private: priv, secretFields: JSON.parse(r.secret_fields),
      status: { state: r.status_state, message: r.status_message, testedAt: r.tested_at },
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
}
