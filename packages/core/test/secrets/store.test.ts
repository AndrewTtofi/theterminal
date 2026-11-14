import { describe, it, expect } from "vitest";
import {
  ChunkedSecretStore,
  MAX_SECRET_BYTES,
  SECRET_SERVICE,
  SecretStoreUnavailableError,
} from "../../src/secrets/store.js";
import type { SecretStore } from "../../src/secrets/store.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { KeychainSecretStore } from "../../src/secrets/keychain-store.js";
import type { KeyringEntryLike } from "../../src/secrets/keychain-store.js";

const KEY = "sk-ant-TESTKEY-0000000000";
const ACCOUNT = "connection/test-account";

/** Records every call so tests can assert the backend was (or was not) touched. */
class SpyStore implements SecretStore {
  readonly calls: string[] = [];
  constructor(private readonly inner: SecretStore = new MemorySecretStore()) {}
  async get(account: string): Promise<string | null> {
    this.calls.push(`get:${account}`);
    return this.inner.get(account);
  }
  async set(account: string, value: string): Promise<void> {
    this.calls.push(`set:${account}`);
    return this.inner.set(account, value);
  }
  async delete(account: string): Promise<void> {
    this.calls.push(`delete:${account}`);
    return this.inner.delete(account);
  }
}

/**
 * A memory backend that, once armed, fails the Nth `set` (1-based) as an unavailable keychain would.
 * With `failDeletesAfterFirst`, every delete after the first armed one fails too.
 */
class FailingStore implements SecretStore {
  readonly inner = new MemorySecretStore();
  private setsLeft = Infinity;
  private deletesBeforeFailure = Infinity;
  arm(failOnSet: number, opts: { failDeletesAfterFirst?: boolean } = {}): void {
    this.setsLeft = failOnSet;
    if (opts.failDeletesAfterFirst) this.deletesBeforeFailure = 1;
  }
  async get(account: string): Promise<string | null> {
    return this.inner.get(account);
  }
  async set(account: string, value: string): Promise<void> {
    if (--this.setsLeft === 0) throw new SecretStoreUnavailableError();
    return this.inner.set(account, value);
  }
  async delete(account: string): Promise<void> {
    if (this.deletesBeforeFailure-- <= 0) throw new SecretStoreUnavailableError();
    return this.inner.delete(account);
  }
  /** Every entry belonging to `account`: the head and any `#k` chunk up to `max`. */
  async entriesFor(account: string, max = 32): Promise<string[]> {
    const found: string[] = [];
    if ((await this.inner.get(account)) !== null) found.push(account);
    for (let k = 0; k < max; k++) if ((await this.inner.get(`${account}#${k}`)) !== null) found.push(`${account}#${k}`);
    return found;
  }
}

/** A fake keyring: a shared map keyed by service + account, with optional failures. */
function fakeKeyring(fail: { set?: boolean; get?: boolean; delete?: boolean; create?: boolean } = {}) {
  const data = new Map<string, string>();
  const created: Array<[string, string]> = [];
  const libraryError = (op: string, account: string) =>
    new Error(`Platform secure storage failure on ${op} for ${account}: ${KEY}`);
  const entry = (service: string, account: string): KeyringEntryLike => {
    created.push([service, account]);
    if (fail.create) throw libraryError("create", account);
    const key = `${service}\u0000${account}`;
    return {
      getPassword: async () => {
        if (fail.get) throw libraryError("get", account);
        return data.get(key) ?? null;
      },
      setPassword: async (password: string) => {
        if (fail.set) throw libraryError("set", account);
        data.set(key, password);
      },
      deletePassword: async () => {
        if (fail.delete) throw libraryError("delete", account);
        return data.delete(key);
      },
    };
  };
  return { entry, data, created };
}

describe("secret store constants", () => {
  it("uses a fixed service name and a 16 KiB cap", () => {
    expect(SECRET_SERVICE).toBe("TheTerminal");
    expect(MAX_SECRET_BYTES).toBe(16 * 1024);
  });
});

describe("MemorySecretStore", () => {
  it("round-trips a value", async () => {
    const store = new MemorySecretStore();
    await store.set(ACCOUNT, KEY);
    expect(await store.get(ACCOUNT)).toBe(KEY);
    expect(store.size()).toBe(1);
  });

  it("returns null for a missing account", async () => {
    expect(await new MemorySecretStore().get("missing")).toBeNull();
  });

  it("deletes idempotently", async () => {
    const store = new MemorySecretStore();
    await store.set(ACCOUNT, KEY);
    await store.delete(ACCOUNT);
    await store.delete(ACCOUNT);
    expect(await store.get(ACCOUNT)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("fails the configured operations with SecretStoreUnavailableError", async () => {
    const store = new MemorySecretStore({ failOn: new Set(["set"]) });
    const err = await store.set(ACCOUNT, KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretStoreUnavailableError);
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(store.size()).toBe(0);
    expect(await store.get(ACCOUNT)).toBeNull();
  });

  it("rejects empty and oversized values with RangeError", async () => {
    const store = new MemorySecretStore();
    await expect(store.set(ACCOUNT, "")).rejects.toBeInstanceOf(RangeError);
    await expect(store.set(ACCOUNT, "x".repeat(MAX_SECRET_BYTES + 1))).rejects.toBeInstanceOf(RangeError);
    expect(store.size()).toBe(0);
  });
});

describe("ChunkedSecretStore", () => {
  const value100 = Array.from({ length: 100 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");

  it("round-trips a value larger than one chunk as a manifest plus chunks", async () => {
    const backend = new MemorySecretStore();
    const store = new ChunkedSecretStore(backend, 16);
    await store.set(ACCOUNT, value100);
    expect(await store.get(ACCOUNT)).toBe(value100);
    expect(backend.size()).toBe(8); // manifest + ceil(100 / 16) = 7 chunks
    expect(await backend.get(ACCOUNT)).toBe("chunks:7");
    for (let i = 0; i < 7; i++) {
      expect(await backend.get(`${ACCOUNT}#${i}`)).toBe(value100.slice(i * 16, i * 16 + 16));
    }
  });

  it("stores a value that fits in one chunk directly", async () => {
    const backend = new MemorySecretStore();
    const store = new ChunkedSecretStore(backend, 16);
    await store.set(ACCOUNT, "short");
    expect(backend.size()).toBe(1);
    expect(await backend.get(ACCOUNT)).toBe("short");
    expect(await store.get(ACCOUNT)).toBe("short");
  });

  it("chunks a short value that looks like a manifest, so it reads back unchanged", async () => {
    const backend = new MemorySecretStore();
    const store = new ChunkedSecretStore(backend, 16);
    await store.set(ACCOUNT, "chunks:3");
    expect(await store.get(ACCOUNT)).toBe("chunks:3");
    expect(await backend.get(ACCOUNT)).toBe("chunks:1");
  });

  it("delete removes the manifest and every chunk, idempotently", async () => {
    const backend = new MemorySecretStore();
    const store = new ChunkedSecretStore(backend, 16);
    await store.set(ACCOUNT, value100);
    await store.delete(ACCOUNT);
    expect(backend.size()).toBe(0);
    expect(await store.get(ACCOUNT)).toBeNull();
    await store.delete(ACCOUNT);
    expect(backend.size()).toBe(0);
  });

  it("overwriting with a shorter value leaves no stale chunk", async () => {
    const backend = new MemorySecretStore();
    const store = new ChunkedSecretStore(backend, 16);
    await store.set(ACCOUNT, value100);
    await store.set(ACCOUNT, value100.slice(0, 40));
    expect(await store.get(ACCOUNT)).toBe(value100.slice(0, 40));
    expect(backend.size()).toBe(4); // manifest + 3 chunks
    for (let i = 3; i < 7; i++) expect(await backend.get(`${ACCOUNT}#${i}`)).toBeNull();

    await store.set(ACCOUNT, "tiny");
    expect(backend.size()).toBe(1);
    expect(await store.get(ACCOUNT)).toBe("tiny");
  });

  it("never splits a multi-byte character across chunks", async () => {
    const backend = new MemorySecretStore();
    const store = new ChunkedSecretStore(backend, 16);
    const value = "é€😀".repeat(10); // 2 + 3 + 4 bytes per repeat
    await store.set(ACCOUNT, value);
    expect(await store.get(ACCOUNT)).toBe(value);
    const manifest = await backend.get(ACCOUNT);
    const n = Number(manifest?.slice("chunks:".length));
    for (let i = 0; i < n; i++) {
      const chunk = (await backend.get(`${ACCOUNT}#${i}`)) ?? "";
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(16);
      expect(chunk).not.toContain("�");
    }
  });

  it("fails closed when a chunk is missing, without revealing the value", async () => {
    const backend = new MemorySecretStore();
    const store = new ChunkedSecretStore(backend, 16);
    await store.set(ACCOUNT, value100);
    await backend.delete(`${ACCOUNT}#3`);
    const err = await store.get(ACCOUNT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretStoreUnavailableError);
    expect((err as Error).message).not.toContain(ACCOUNT);
    expect((err as Error).message).not.toContain(value100.slice(0, 16));
  });

  it("rejects a 20 KiB value with RangeError before touching the backend", async () => {
    const backend = new SpyStore();
    const store = new ChunkedSecretStore(backend, 16);
    await expect(store.set(ACCOUNT, "x".repeat(20 * 1024))).rejects.toBeInstanceOf(RangeError);
    await expect(store.set(ACCOUNT, "")).rejects.toBeInstanceOf(RangeError);
    expect(backend.calls).toEqual([]);
  });

  it("a failed 3 → 9 chunk overwrite leaves nothing behind and reads as null", async () => {
    const backend = new FailingStore();
    const store = new ChunkedSecretStore(backend, 16);
    const old = "o".repeat(48); // 3 chunks
    const next = "n".repeat(144); // 9 chunks
    await store.set(ACCOUNT, old);
    expect(await backend.entriesFor(ACCOUNT)).toHaveLength(4);
    backend.arm(7); // the 7th set is chunk #6
    const err = await store.set(ACCOUNT, next).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretStoreUnavailableError);
    expect(await store.get(ACCOUNT)).toBeNull();
    expect(await backend.entriesFor(ACCOUNT)).toEqual([]);
  });

  it("a failed chunked-over-chunked overwrite never returns a mixed value, at any failure point", async () => {
    const old = "o".repeat(48);
    const next = "n".repeat(48); // same chunk count: the case where a stale manifest would mix chunks
    for (const failDeletesAfterFirst of [false, true]) {
      for (let n = 1; n <= 4; n++) {
        const backend = new FailingStore();
        const store = new ChunkedSecretStore(backend, 16);
        await store.set(ACCOUNT, old);
        backend.arm(n, { failDeletesAfterFirst });
        await expect(store.set(ACCOUNT, next)).rejects.toBeInstanceOf(SecretStoreUnavailableError);
        const read = await store.get(ACCOUNT);
        expect(read).toBeNull();
        if (!failDeletesAfterFirst) expect(await backend.entriesFor(ACCOUNT)).toEqual([]);
      }
    }
  });

  it("defaults to 2048-byte chunks", async () => {
    const backend = new MemorySecretStore();
    const store = new ChunkedSecretStore(backend);
    await store.set(ACCOUNT, "k".repeat(2048));
    expect(backend.size()).toBe(1);
    await store.set(ACCOUNT, "k".repeat(2049));
    expect(await backend.get(ACCOUNT)).toBe("chunks:2");
  });
});

describe("KeychainSecretStore", () => {
  it("round-trips through the injected entry under the TheTerminal service", async () => {
    const kr = fakeKeyring();
    const store = new KeychainSecretStore({ entry: kr.entry });
    await store.set(ACCOUNT, KEY);
    expect(await store.get(ACCOUNT)).toBe(KEY);
    expect(kr.created.every(([service]) => service === SECRET_SERVICE)).toBe(true);
    await store.delete(ACCOUNT);
    await store.delete(ACCOUNT);
    expect(await store.get(ACCOUNT)).toBeNull();
  });

  it("honours a custom service name", async () => {
    const kr = fakeKeyring();
    const store = new KeychainSecretStore({ service: "TheTerminal-test", entry: kr.entry });
    await store.set(ACCOUNT, KEY);
    expect(kr.created[0]).toEqual(["TheTerminal-test", ACCOUNT]);
  });

  it("returns null for a missing entry", async () => {
    const store = new KeychainSecretStore({ entry: fakeKeyring().entry });
    expect(await store.get("missing")).toBeNull();
  });

  it("maps a throwing setPassword to SecretStoreUnavailableError without the account or value", async () => {
    const store = new KeychainSecretStore({ entry: fakeKeyring({ set: true }).entry });
    const err = await store.set(ACCOUNT, KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretStoreUnavailableError);
    const e = err as Error;
    expect(e.message).toBe("keychain unavailable");
    expect(e.message).not.toContain(ACCOUNT);
    expect(e.message).not.toContain(KEY);
    expect(e.stack ?? "").not.toContain(ACCOUNT);
    expect(e.stack ?? "").not.toContain(KEY);
    expect((e as { cause?: unknown }).cause).toBeUndefined();
  });

  it("maps get, delete and entry-construction failures the same way", async () => {
    for (const fail of [{ get: true }, { delete: true }, { create: true }]) {
      const store = new KeychainSecretStore({ entry: fakeKeyring(fail).entry });
      const results = await Promise.allSettled([store.get(ACCOUNT), store.delete(ACCOUNT), store.set(ACCOUNT, KEY)]);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected.length).toBeGreaterThan(0);
      for (const r of rejected) {
        expect(r.reason).toBeInstanceOf(SecretStoreUnavailableError);
        expect((r.reason as Error).message).toBe("keychain unavailable");
      }
    }
  });

  it("rejects a 20 KiB value with RangeError and never creates an entry", async () => {
    const kr = fakeKeyring();
    const store = new KeychainSecretStore({ entry: kr.entry });
    await expect(store.set(ACCOUNT, "x".repeat(20 * 1024))).rejects.toBeInstanceOf(RangeError);
    await expect(store.set(ACCOUNT, "")).rejects.toBeInstanceOf(RangeError);
    expect(kr.created).toEqual([]);
  });

  it("chunks over the keychain store, keeping every entry under 2048 bytes", async () => {
    const kr = fakeKeyring();
    const store = new ChunkedSecretStore(new KeychainSecretStore({ entry: kr.entry }));
    const value = "v".repeat(5000);
    await store.set(ACCOUNT, value);
    expect(await store.get(ACCOUNT)).toBe(value);
    expect(kr.data.size).toBe(4); // manifest + 3 chunks
    for (const stored of kr.data.values()) expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(2048);
  });
});
