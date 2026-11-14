import { assertStorableSecret, SecretStoreUnavailableError } from "./store.js";
import type { SecretStore } from "./store.js";

type Operation = "get" | "set" | "delete";

/** In-process test double. `failOn` makes the listed operations fail as an unavailable keychain would. */
export class MemorySecretStore implements SecretStore {
  private readonly entries = new Map<string, string>();
  private readonly failOn: ReadonlySet<Operation>;

  constructor(opts: { failOn?: Set<Operation> } = {}) {
    this.failOn = opts.failOn ?? new Set();
  }

  async get(account: string): Promise<string | null> {
    this.check("get");
    return this.entries.get(account) ?? null;
  }

  async set(account: string, value: string): Promise<void> {
    assertStorableSecret(value);
    this.check("set");
    this.entries.set(account, value);
  }

  async delete(account: string): Promise<void> {
    this.check("delete");
    this.entries.delete(account);
  }

  size(): number {
    return this.entries.size;
  }

  private check(op: Operation): void {
    if (this.failOn.has(op)) throw new SecretStoreUnavailableError();
  }
}
