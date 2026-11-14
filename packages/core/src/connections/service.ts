import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CONNECTION_CATALOG,
  connectionConfigSchema,
  connectionNameSchema,
  eventPayloadSchemas,
  type Actor,
  type CatalogEntry,
  type Connection,
  type ConnectionKind,
  type ConnectionProvider,
  type FieldStorage,
  type NewLedgerEntry,
  type Provider,
} from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { commitEvent } from "../events/commit.js";
import { NotFoundError } from "../board/board-service.js";
import { redact, truncate } from "../agents/redact.js";
import { MAX_SECRET_BYTES, type SecretStore } from "../secrets/store.js";

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
type KeychainOp = { field: string; value: string | null };
/** What a done op replaced, so it can be put back: `undefined` means nothing was stored. */
type Undo = { account: string; previous: string | undefined };

const UNTESTABLE = "Testing is not available for this connection yet";

const accountFor = (connectionId: string, field: string): string => `connection/${connectionId}/${field}`;

function invalid(path: (string | number)[], message: string): never {
  throw new z.ZodError([{ code: "custom", path, message }]);
}

const catalogFor = (provider: ConnectionProvider): CatalogEntry | undefined =>
  CONNECTION_CATALOG.find((e) => e.provider === provider);

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

  constructor(deps: ConnectionServiceDeps) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.secrets = deps.secrets;
    this.testers = deps.testers;
    this.fetchImpl = deps.fetch ?? fetch;
    this.newId = deps.newId ?? (() => randomUUID());
    this.testTimeoutMs = deps.testTimeoutMs ?? 10_000;
  }

  /** Reads every stored value into the cache. A keychain failure leaves the cache empty and marks it unavailable. */
  async load(): Promise<void> {
    const next = new Map<string, Record<string, string>>();
    try {
      for (const row of this.rows()) {
        const values: Record<string, string> = {};
        for (const [field, storage] of this.storedFields(row)) {
          const value = await this.secrets.get(accountFor(row.id, field));
          if (value === null) continue;
          values[field] = value;
          if (storage === "secret") this.seen.add(value);
        }
        next.set(row.id, values);
      }
    } catch {
      this.cache = new Map();
      this.state = "unavailable";
      return;
    }
    this.cache = next;
    this.state = "ok";
  }

  keychainState(): "ok" | "unavailable" {
    return this.state;
  }

  list(): Connection[] {
    return this.rows().map((r) => this.toConnection(r));
  }

  get(id: string): Connection {
    return this.toConnection(this.requireRow(id));
  }

  async add(actor: Actor, input: AddConnectionInput): Promise<Connection> {
    const name = connectionNameSchema.parse(input.name);
    const entry = this.availableEntry(input.provider);
    if (entry.kind !== input.kind) invalid(["provider"], "provider does not belong to this kind");
    const config = this.checkConfig(entry, input.config ?? {});
    const secrets = input.secrets ?? {};
    const priv = input.private ?? {};
    this.checkValues(entry, "secret", secrets, ["secrets"]);
    this.checkValues(entry, "private", priv, ["private"]);
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
    const ops: KeychainOp[] = [...Object.entries(secrets), ...Object.entries(priv)].map(([field, value]) => ({ field, value }));
    await this.commitWithKeychain(connectionId, ops, () => {
      this.assertNoConflict(entry);
      return { projectId: null, actor, type: "connection.added", payload };
    });
    for (const v of Object.values(secrets)) this.seen.add(v);
    return this.get(connectionId);
  }

  async update(actor: Actor, id: string, patch: UpdateConnectionPatch): Promise<Connection> {
    const row = this.requireRow(id);
    const entry = this.availableEntry(row.provider);
    const changes: Record<string, unknown> = {};
    if (patch.name !== undefined) changes.name = connectionNameSchema.parse(patch.name);
    if (patch.config !== undefined) changes.config = this.checkConfig(entry, patch.config);
    if (patch.enabled !== undefined) changes.enabled = z.boolean().parse(patch.enabled);
    const secrets = patch.secrets ?? {};
    const priv = patch.private ?? {};
    this.checkValues(entry, "secret", secrets, ["secrets"]);
    this.checkValues(entry, "private", priv, ["private"]);
    for (const f of entry.fields) {
      const given = f.storage === "secret" ? secrets : f.storage === "private" ? priv : {};
      if (f.required && given[f.name] === null) invalid([f.storage === "secret" ? "secrets" : f.storage, f.name], "required");
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
    const ops: KeychainOp[] = [
      ...[...Object.entries(secrets), ...Object.entries(priv)].filter(([, v]) => v !== null),
      ...[...Object.entries(secrets), ...Object.entries(priv)].filter(([, v]) => v === null),
    ].map(([field, value]) => ({ field, value }));
    await this.commitWithKeychain(id, ops, () => {
      this.requireRow(id);
      return { projectId: null, actor, type: "connection.updated", payload };
    });
    for (const v of Object.values(secrets)) if (v !== null) this.seen.add(v);
    return this.get(id);
  }

  async remove(actor: Actor, id: string): Promise<void> {
    const row = this.requireRow(id);
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

  async test(actor: Actor, id: string): Promise<{ ok: boolean; message: string }> {
    const row = this.requireRow(id);
    const tester = catalogFor(row.provider)?.available ? this.testers[row.provider] : undefined;
    let result: { ok: boolean; message: string };
    if (!tester) {
      result = { ok: false, message: UNTESTABLE };
    } else {
      const values = this.cache.get(id) ?? {};
      const stored = new Map(this.storedFields(row));
      const pick = (storage: FieldStorage) =>
        Object.fromEntries(Object.entries(values).filter(([f]) => stored.get(f) === storage));
      try {
        result = await tester(
          { config: JSON.parse(row.config), private: pick("private"), secrets: pick("secret") },
          { fetch: this.fetchImpl, signal: AbortSignal.timeout(this.testTimeoutMs) },
        );
      } catch {
        result = { ok: false, message: "Could not reach the provider" };
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
   * Applies `ops` to the keychain, then commits the event. If a keychain op or the commit fails, every op done
   * in this call is undone (best effort: the previous value is put back, or the entry deleted) and the error rethrown.
   */
  private async commitWithKeychain(connectionId: string, ops: KeychainOp[], build: () => NewLedgerEntry): Promise<void> {
    const cached = this.cache.get(connectionId) ?? {};
    const done: Undo[] = [];
    try {
      for (const op of ops) {
        const account = accountFor(connectionId, op.field);
        done.push({ account, previous: cached[op.field] });
        if (op.value === null) await this.secrets.delete(account);
        else await this.secrets.set(account, op.value);
      }
      commitEvent(this.db, this.ledger, () => ({ event: build(), result: () => undefined }));
    } catch (err) {
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
    }
    this.cache.set(connectionId, next);
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
        throw new UnknownFieldError(`unknown ${storage} field: ${name}`);
      }
    }
  }

  /** Config goes to the ledger, so a value that `redact` would change is refused outright. */
  private checkConfig(entry: CatalogEntry, input: Record<string, string>): Record<string, string> {
    const config = connectionConfigSchema.parse(input);
    this.checkFields(entry, "config", Object.keys(config));
    if (JSON.stringify(redact(config, this.secretValues())) !== JSON.stringify(config)) throw new SecretInConfigError();
    return config;
  }

  private checkValues(entry: CatalogEntry, storage: "secret" | "private", values: Record<string, string | null>, path: string[]): void {
    this.checkFields(entry, storage, Object.keys(values));
    for (const [name, value] of Object.entries(values)) {
      if (value === null) continue;
      const field = entry.fields.find((f) => f.name === name)!;
      if (typeof value !== "string" || value.length === 0) invalid([...path, name], "must be a non-empty string");
      if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) invalid([...path, name], `must be at most ${MAX_SECRET_BYTES} bytes`);
      if (field.input !== "multiline" && /[\r\n]/.test(value)) invalid([...path, name], "must be a single line");
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
