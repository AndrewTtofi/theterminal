import { createRequire } from "node:module";
import { assertStorableSecret, SECRET_SERVICE, SecretStoreUnavailableError } from "./store.js";
import type { SecretStore } from "./store.js";

/** The subset of `@napi-rs/keyring`'s `Entry` / `AsyncEntry` this store uses. */
export interface KeyringEntryLike {
  /** The stored password, or `null` when there is none. */
  getPassword(): string | null | Promise<string | null>;
  setPassword(password: string): void | Promise<void>;
  /** `true` when a credential was deleted, `false` when there was none. */
  deletePassword(): boolean | Promise<boolean>;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntryLike;

/** Loads the native binding on first use, so importing core never requires it. */
const defaultEntry: KeyringEntryFactory = (service, account) => {
  const require = createRequire(import.meta.url);
  const { AsyncEntry } = require("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
  return new AsyncEntry(service, account);
};

/**
 * Secrets in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service).
 * Every keyring failure becomes a `SecretStoreUnavailableError` with a fixed message: the library's text may
 * name the account, so it is dropped rather than wrapped.
 */
export class KeychainSecretStore implements SecretStore {
  private readonly service: string;
  private readonly entry: KeyringEntryFactory;

  constructor(opts: { service?: string; entry?: KeyringEntryFactory } = {}) {
    this.service = opts.service ?? SECRET_SERVICE;
    this.entry = opts.entry ?? defaultEntry;
  }

  get(account: string): Promise<string | null> {
    return this.call(account, async (e) => (await e.getPassword()) ?? null);
  }

  async set(account: string, value: string): Promise<void> {
    assertStorableSecret(value);
    await this.call(account, async (e) => {
      await e.setPassword(value);
    });
  }

  async delete(account: string): Promise<void> {
    await this.call(account, async (e) => {
      await e.deletePassword();
    });
  }

  private async call<T>(account: string, op: (entry: KeyringEntryLike) => Promise<T>): Promise<T> {
    try {
      return await op(this.entry(this.service, account));
    } catch {
      throw new SecretStoreUnavailableError();
    }
  }
}
