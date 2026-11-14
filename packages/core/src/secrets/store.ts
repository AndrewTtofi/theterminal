/** Where credentials the Owner pastes into The Terminal live. Values never appear in errors or logs. */
export interface SecretStore {
  /** The stored value, or `null` when the account has none. */
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  /** Idempotent: deleting a missing account succeeds. */
  delete(account: string): Promise<void>;
}

/** The backing store cannot be used. The message is fixed and never carries an account name or value. */
export class SecretStoreUnavailableError extends Error {
  constructor(message = "keychain unavailable") {
    super(message);
    this.name = "SecretStoreUnavailableError";
  }
}

/** Keychain service name every entry is filed under. */
export const SECRET_SERVICE = "TheTerminal";

/** Largest value (UTF-8 bytes) any store accepts. */
export const MAX_SECRET_BYTES = 16 * 1024;

/** Rejects empty and oversized values before any backend is touched. */
export function assertStorableSecret(value: string): void {
  if (typeof value !== "string" || value.length === 0) throw new RangeError("secret value must not be empty");
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
    throw new RangeError(`secret value exceeds ${MAX_SECRET_BYTES} bytes`);
  }
}

const MANIFEST = /^chunks:([1-9][0-9]*)$/;
const manifestFor = (count: number): string => `chunks:${count}`;
const chunkAccount = (account: string, index: number): string => `${account}#${index}`;

/** Splits a string into pieces of at most `maxBytes` UTF-8 bytes without splitting a code point. */
function splitUtf8(value: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of value) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Splits values over `maxChunkBytes` into `<account>#<n>` entries behind a `<account>` manifest "chunks:<n>".
 * Values that fit are stored directly, unless they look like a manifest, which are always chunked.
 */
export class ChunkedSecretStore implements SecretStore {
  constructor(
    private readonly backend: SecretStore,
    private readonly maxChunkBytes = 2048,
  ) {
    // A UTF-8 code point is at most 4 bytes; smaller chunks could not hold one.
    if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 4) {
      throw new RangeError("maxChunkBytes must be an integer of at least 4");
    }
  }

  async get(account: string): Promise<string | null> {
    const head = await this.backend.get(account);
    if (head === null) return null;
    const count = this.chunkCount(head);
    if (count === 0) return head;
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const part = await this.backend.get(chunkAccount(account, i));
      if (part === null) throw new SecretStoreUnavailableError("keychain entry incomplete");
      parts.push(part);
    }
    return parts.join("");
  }

  async set(account: string, value: string): Promise<void> {
    assertStorableSecret(value);
    const previous = this.chunkCount(await this.backend.get(account));
    const direct = Buffer.byteLength(value, "utf8") <= this.maxChunkBytes && !MANIFEST.test(value);
    if (direct) {
      await this.backend.set(account, value);
      await this.deleteChunks(account, 0, previous);
      return;
    }
    const chunks = splitUtf8(value, this.maxChunkBytes);
    let attempted = 0;
    try {
      // Drop the old manifest first: an interrupted write then reads as null, never as old and new chunks mixed.
      if (previous > 0) await this.backend.delete(account);
      for (; attempted < chunks.length; ) {
        const index = attempted++;
        await this.backend.set(chunkAccount(account, index), chunks[index]!);
      }
      await this.backend.set(account, manifestFor(chunks.length));
    } catch (err) {
      await this.discard(account, Math.max(attempted, previous));
      throw err;
    }
    await this.deleteChunks(account, chunks.length, previous);
  }

  /** Best-effort removal of the head and chunks `#0..count-1` after a failed write; cleanup errors are dropped. */
  private async discard(account: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) await this.backend.delete(chunkAccount(account, i)).catch(() => undefined);
    await this.backend.delete(account).catch(() => undefined);
  }

  async delete(account: string): Promise<void> {
    const count = this.chunkCount(await this.backend.get(account));
    await this.deleteChunks(account, 0, count);
    await this.backend.delete(account);
  }

  /** The number of chunks a stored head value points at; 0 when it is a direct value or absent. */
  private chunkCount(head: string | null): number {
    const match = head === null ? null : MANIFEST.exec(head);
    return match ? Number(match[1]) : 0;
  }

  private async deleteChunks(account: string, from: number, to: number): Promise<void> {
    for (let i = from; i < to; i++) await this.backend.delete(chunkAccount(account, i));
  }
}
