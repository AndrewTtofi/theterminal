import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertStorableSecret, SecretStoreUnavailableError } from "./store.js";
import type { SecretStore } from "./store.js";

/** Which backend holds the Owner's credentials. */
export type SecretStoreKind = "keychain" | "file" | "memory";

/** The key file sits inside the data folder, so one backup would hold the key and the ciphertext together. */
export class KeyInsideDataDirError extends Error {
  constructor() {
    super("Refusing to start: the secret key file is inside the data directory");
    this.name = "KeyInsideDataDirError";
  }
}

/** The real path of `p` when it exists, else of its nearest existing ancestor with the rest appended. */
function canonical(p: string): string {
  const abs = resolve(p);
  const parent = dirname(abs);
  let real: string;
  try {
    real = realpathSync.native(abs);
  } catch {
    real = parent === abs ? abs : join(canonical(parent), basename(abs));
  }
  // Windows and macOS file systems ignore case by default: compare case-blind there. A false match only
  // refuses to start (the safe direction) and `allowKeyInDataDir` overrides it.
  return process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real;
}

/**
 * Throws `KeyInsideDataDirError` when `keyFile` resolves to a path at or under `dataDir` (symlinks followed
 * where they exist), unless `allowKeyInDataDir`.
 */
export function assertKeyOutsideDataDir(keyFile: string, dataDir: string, allowKeyInDataDir = false): void {
  if (allowKeyInDataDir) return;
  const rel = relative(canonical(dataDir), canonical(keyFile));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new KeyInsideDataDirError();
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 1;
const ALGORITHM = "aes-256-gcm";

interface Entry {
  n: string;
  c: string;
  t: string;
}
interface FileContents {
  version: typeof VERSION;
  entries: Record<string, Entry>;
}

const KEY_UNAVAILABLE = "secret key file unavailable";
const FILE_UNAVAILABLE = "secret store file unavailable";

/** Decodes canonical base64 only: Node's decoder silently skips junk, so re-encode and compare. */
function strictBase64(value: unknown, bytes?: number): Buffer | null {
  if (typeof value !== "string") return null;
  const buf = Buffer.from(value, "base64");
  if (buf.toString("base64") !== value) return null;
  if (bytes !== undefined && buf.length !== bytes) return null;
  return buf;
}

/** Binds a ciphertext to its account so an entry cannot be moved to another account name. */
const aad = (account: string): Buffer => Buffer.from(`theterminal-secrets:v${VERSION}:${account}`, "utf8");

/**
 * Secrets encrypted on disk, for headless servers that have no OS keychain.
 *
 * - AES-256-GCM with a 32-byte key read from `keyFile`; each value gets a fresh random 12-byte nonce, and the
 *   account name is authenticated as associated data. File: `{ version: 1, entries: { [account]: { n, c, t } } }`
 *   (base64 nonce, ciphertext, tag).
 * - Fails closed: a missing, unreadable or wrong-size key, a corrupt or unknown-format file, or any entry that
 *   does not authenticate throws `SecretStoreUnavailableError`. A write first checks that every existing entry
 *   authenticates with this key, so a wrong key never mixes into the file, and a corrupt file is never replaced.
 *   Only a missing data file reads as empty.
 * - Writes go to a temp file in the same folder (mode 0o600, fsynced) that is renamed over the data file.
 * - Errors carry fixed messages and no cause: never an account name, a value or key material.
 *
 * Windows: POSIX modes are not enforced there (Node maps 0o600 to "not read-only"); the files inherit the ACL of
 * their folder, so the data and key folders must be ones only the service account can read. The in-process
 * operations are synchronous so concurrent calls cannot interleave a read-modify-write; across processes the
 * data-folder lock is what keeps a single writer.
 */
export class FileSecretStore implements SecretStore {
  private readonly file: string;
  private readonly keyFile: string;
  private readonly createKey: boolean;
  private key: Buffer | null = null;

  constructor(opts: { file: string; keyFile: string; createKey?: boolean }) {
    this.file = resolve(opts.file);
    this.keyFile = resolve(opts.keyFile);
    this.createKey = opts.createKey ?? false;
  }

  async get(account: string): Promise<string | null> {
    const key = this.loadKey();
    const entry = this.read().entries[account];
    return entry === undefined ? null : this.decrypt(key, account, entry);
  }

  async set(account: string, value: string): Promise<void> {
    assertStorableSecret(value);
    const key = this.loadKey();
    const contents = this.readVerified(key);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(account));
    const c = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    contents.entries[account] = {
      n: nonce.toString("base64"),
      c: c.toString("base64"),
      t: cipher.getAuthTag().toString("base64"),
    };
    this.write(contents);
  }

  async delete(account: string): Promise<void> {
    const key = this.loadKey();
    const contents = this.readVerified(key);
    if (contents.entries[account] === undefined) return;
    delete contents.entries[account];
    this.write(contents);
  }

  /** The key, read once and cached; created first (32 random bytes, 0o600, never replacing) with `createKey`. */
  private loadKey(): Buffer {
    if (this.key) return this.key;
    try {
      if (this.createKey) this.createKeyIfMissing();
      const key = readFileSync(this.keyFile);
      if (key.length !== KEY_BYTES) {
        key.fill(0);
        throw new Error("wrong key size");
      }
      this.key = key;
      return key;
    } catch {
      throw new SecretStoreUnavailableError(KEY_UNAVAILABLE);
    }
  }

  private createKeyIfMissing(): void {
    mkdirSync(dirname(this.keyFile), { recursive: true, mode: 0o700 });
    let fd: number;
    try {
      fd = openSync(this.keyFile, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
      throw err;
    }
    const key = randomBytes(KEY_BYTES);
    try {
      writeSync(fd, key);
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      rmSync(this.keyFile, { force: true });
      throw err;
    } finally {
      key.fill(0);
    }
    closeSync(fd);
  }

  /** The parsed file; `{}` entries only when the file does not exist. */
  private read(): FileContents {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: VERSION, entries: Object.create(null) };
      throw new SecretStoreUnavailableError(FILE_UNAVAILABLE);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SecretStoreUnavailableError(FILE_UNAVAILABLE);
    }
    if (!isContents(parsed)) throw new SecretStoreUnavailableError(FILE_UNAVAILABLE);
    // A prototype-free map: an account named "__proto__" or "toString" is just a key.
    return { version: VERSION, entries: Object.assign(Object.create(null) as Record<string, Entry>, parsed.entries) };
  }

  /** The parsed file, after checking every entry authenticates with `key`. */
  private readVerified(key: Buffer): FileContents {
    const contents = this.read();
    for (const [account, entry] of Object.entries(contents.entries)) this.decrypt(key, account, entry);
    return contents;
  }

  private decrypt(key: Buffer, account: string, entry: Entry): string {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, strictBase64(entry.n, NONCE_BYTES)!, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad(account));
      decipher.setAuthTag(strictBase64(entry.t, TAG_BYTES)!);
      return Buffer.concat([decipher.update(strictBase64(entry.c)!), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretStoreUnavailableError(FILE_UNAVAILABLE);
    }
  }

  private write(contents: FileContents): void {
    const dir = dirname(this.file);
    const tmp = join(dir, `.${basename(this.file)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(contents));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file);
    } catch {
      rmSync(tmp, { force: true });
      throw new SecretStoreUnavailableError(FILE_UNAVAILABLE);
    }
  }
}

function isContents(value: unknown): value is FileContents {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as { version?: unknown; entries?: unknown };
  if (v.version !== VERSION) return false;
  const entries = v.entries;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return false;
  return Object.values(entries).every(
    (e: unknown) =>
      typeof e === "object" &&
      e !== null &&
      strictBase64((e as Entry).n, NONCE_BYTES) !== null &&
      strictBase64((e as Entry).c) !== null &&
      strictBase64((e as Entry).t, TAG_BYTES) !== null,
  );
}
