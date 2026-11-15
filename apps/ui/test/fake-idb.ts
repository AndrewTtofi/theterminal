/**
 * A small in-memory IndexedDB for tests (jsdom has none): `open` with an upgrade, one object store per name, `get`
 * and `put` with out-of-line keys, and transactions that complete after their requests. Values are kept as given
 * (a CryptoKey stays the same object), which is what the browser's structured clone keeps for a CryptoKey too.
 */
type Req<T> = { result: T; error: DOMException | null; onsuccess: (() => void) | null; onerror: (() => void) | null };

export class FakeIdb {
  readonly dbs = new Map<string, Map<string, Map<unknown, unknown>>>();
  opens = 0;
  puts = 0;

  open(name: string, _version?: number) {
    this.opens++;
    const req = { result: undefined as unknown, error: null, onsuccess: null, onerror: null, onupgradeneeded: null } as Req<unknown> & {
      onupgradeneeded: (() => void) | null;
    };
    queueMicrotask(() => {
      const fresh = !this.dbs.has(name);
      if (fresh) this.dbs.set(name, new Map());
      const stores = this.dbs.get(name)!;
      req.result = this.db(stores);
      if (fresh) req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  }

  private db(stores: Map<string, Map<unknown, unknown>>) {
    const fake = this;
    return {
      objectStoreNames: { contains: (n: string) => stores.has(n) },
      createObjectStore: (n: string) => stores.set(n, new Map()),
      close: () => {},
      transaction(name: string) {
        const tx = { oncomplete: null as (() => void) | null, onerror: null, onabort: null, error: null, objectStore: (_: string) => store };
        const data = stores.get(name);
        if (!data) throw new Error(`no store ${name}`);
        const request = <T>(value: () => T) => {
          const r: Req<T> = { result: undefined as T, error: null, onsuccess: null, onerror: null };
          queueMicrotask(() => {
            r.result = value();
            r.onsuccess?.();
            queueMicrotask(() => tx.oncomplete?.());
          });
          return r;
        };
        const store = {
          get: (key: unknown) => request(() => data.get(key)),
          put: (value: unknown, key: unknown) =>
            request(() => {
              fake.puts++;
              data.set(key, value);
              return key;
            }),
        };
        return tx;
      },
    };
  }
}
