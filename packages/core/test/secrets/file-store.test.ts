import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  FileSecretStore,
  KeyInsideDataDirError,
  assertKeyOutsideDataDir,
} from "../../src/secrets/file-store.js";
import { MAX_SECRET_BYTES, SecretStoreUnavailableError } from "../../src/secrets/store.js";

const KEY = "sk-ant-TESTKEY-0000000000";
const OTHER = "sk-ant-TESTKEY-1111111111";
const ACCOUNT = "connection/test-account";
const WIN = process.platform === "win32";

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tt-filestore-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A data dir and a separate key dir holding a fresh 32-byte key. */
function setup(): { data: string; file: string; keyFile: string; store: FileSecretStore } {
  const data = tmp();
  const keyDir = tmp();
  const keyFile = join(keyDir, "secret.key");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  const file = join(data, "secrets.enc.json");
  return { data, file, keyFile, store: new FileSecretStore({ file, keyFile }) };
}

const unavailable = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(SecretStoreUnavailableError);

type Raw = { version: number; entries: Record<string, { n: string; c: string; t: string }> };
const readRaw = (file: string): Raw => JSON.parse(readFileSync(file, "utf8")) as Raw;

describe("FileSecretStore", () => {
  it("round-trips, overwrites, deletes and reports missing accounts as null", async () => {
    const { store } = setup();
    expect(await store.get(ACCOUNT)).toBeNull();
    await store.set(ACCOUNT, KEY);
    expect(await store.get(ACCOUNT)).toBe(KEY);
    await store.set(ACCOUNT, OTHER);
    expect(await store.get(ACCOUNT)).toBe(OTHER);
    await store.set("other", KEY);
    await store.delete(ACCOUNT);
    expect(await store.get(ACCOUNT)).toBeNull();
    expect(await store.get("other")).toBe(KEY);
    await store.delete(ACCOUNT); // idempotent
    await store.delete("never-set");
  });

  it("treats prototype names as plain account names", async () => {
    const { file, keyFile, store } = setup();
    expect(await store.get("toString")).toBeNull();
    await store.set("__proto__", KEY);
    await store.set("constructor", OTHER);
    const again = new FileSecretStore({ file, keyFile });
    expect(await again.get("__proto__")).toBe(KEY);
    expect(await again.get("constructor")).toBe(OTHER);
    await again.delete("__proto__");
    expect(await again.get("__proto__")).toBeNull();
    expect(Object.keys(readRaw(file).entries)).toEqual(["constructor"]);
  });

  it("persists across instances using the same key", async () => {
    const { file, keyFile, store } = setup();
    await store.set(ACCOUNT, KEY);
    expect(await new FileSecretStore({ file, keyFile }).get(ACCOUNT)).toBe(KEY);
  });

  it("handles unicode and the largest allowed value", async () => {
    const { store } = setup();
    const big = "é".repeat(MAX_SECRET_BYTES / 2);
    await store.set(ACCOUNT, big);
    expect(await store.get(ACCOUNT)).toBe(big);
  });

  it("rejects empty and oversized values without writing the file", async () => {
    const { file, store } = setup();
    await expect(store.set(ACCOUNT, "")).rejects.toThrow(RangeError);
    await expect(store.set(ACCOUNT, "x".repeat(MAX_SECRET_BYTES + 1))).rejects.toThrow(RangeError);
    expect(existsSync(file)).toBe(false);
  });

  it("writes the documented format with no plaintext, a fresh 12-byte nonce each write and a 16-byte tag", async () => {
    const { file, store } = setup();
    await store.set(ACCOUNT, KEY);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("TESTKEY");
    expect(text).not.toContain(Buffer.from(KEY).toString("base64"));
    const first = readRaw(file);
    expect(first.version).toBe(1);
    const entry = first.entries[ACCOUNT]!;
    expect(Buffer.from(entry.n, "base64")).toHaveLength(12);
    expect(Buffer.from(entry.t, "base64")).toHaveLength(16);
    await store.set(ACCOUNT, KEY);
    const second = readRaw(file).entries[ACCOUNT]!;
    expect(second.n).not.toBe(entry.n);
    expect(second.c).not.toBe(entry.c);
  });

  it("writes the file with mode 0600 and leaves no temp files behind", async () => {
    const { data, file, store } = setup();
    await store.set(ACCOUNT, KEY);
    await store.set("b", OTHER);
    await store.delete("b");
    expect(readdirSync(data)).toEqual(["secrets.enc.json"]);
    if (!WIN) expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("creates a missing parent folder for the data file", async () => {
    const { data, keyFile } = setup();
    const file = join(data, "nested", "secrets.enc.json");
    const store = new FileSecretStore({ file, keyFile });
    await store.set(ACCOUNT, KEY);
    expect(await store.get(ACCOUNT)).toBe(KEY);
  });

  describe("fails closed", () => {
    it("a different key cannot read, write or delete, and the file is left untouched", async () => {
      const { file, store } = setup();
      await store.set(ACCOUNT, KEY);
      const before = readFileSync(file, "utf8");
      const wrongKey = join(tmp(), "wrong.key");
      writeFileSync(wrongKey, randomBytes(32));
      const wrong = new FileSecretStore({ file, keyFile: wrongKey });
      await unavailable(wrong.get(ACCOUNT));
      await unavailable(wrong.set("another", OTHER));
      await unavailable(wrong.delete(ACCOUNT));
      expect(readFileSync(file, "utf8")).toBe(before);
    });

    it("a key file of the wrong size", async () => {
      const { file } = setup();
      for (const size of [0, 16, 31, 33, 64]) {
        const keyFile = join(tmp(), "bad.key");
        writeFileSync(keyFile, randomBytes(size));
        const store = new FileSecretStore({ file, keyFile });
        await unavailable(store.get(ACCOUNT));
        await unavailable(store.set(ACCOUNT, KEY));
      }
      expect(existsSync(file)).toBe(false);
    });

    it("a missing key file without createKey, which is not created", async () => {
      const { file } = setup();
      const keyFile = join(tmp(), "missing.key");
      const store = new FileSecretStore({ file, keyFile });
      await unavailable(store.get(ACCOUNT));
      await unavailable(store.set(ACCOUNT, KEY));
      expect(existsSync(keyFile)).toBe(false);
      expect(existsSync(file)).toBe(false);
    });

    it("a key path that is a folder", async () => {
      const { file } = setup();
      await unavailable(new FileSecretStore({ file, keyFile: tmp(), createKey: true }).get(ACCOUNT));
    });

    it("a tampered ciphertext, nonce or tag", async () => {
      for (const field of ["c", "n", "t"] as const) {
        const { file, keyFile, store } = setup();
        await store.set(ACCOUNT, KEY);
        const raw = readRaw(file);
        const bytes = Buffer.from(raw.entries[ACCOUNT]![field], "base64");
        bytes[0] = bytes[0]! ^ 0x01;
        raw.entries[ACCOUNT]![field] = bytes.toString("base64");
        writeFileSync(file, JSON.stringify(raw));
        await unavailable(new FileSecretStore({ file, keyFile }).get(ACCOUNT));
      }
    });

    it("an entry moved to another account name", async () => {
      const { file, keyFile, store } = setup();
      await store.set(ACCOUNT, KEY);
      await store.set("victim", OTHER);
      const raw = readRaw(file);
      raw.entries["victim"] = raw.entries[ACCOUNT]!;
      writeFileSync(file, JSON.stringify(raw));
      await unavailable(new FileSecretStore({ file, keyFile }).get("victim"));
    });

    it("a corrupt or malformed data file, which is never overwritten", async () => {
      const bad = [
        "",
        "not json",
        "null",
        "[]",
        JSON.stringify({ version: 2, entries: {} }),
        JSON.stringify({ version: 1 }),
        JSON.stringify({ version: 1, entries: [] }),
        JSON.stringify({ version: 1, entries: { a: { n: "AAAA", c: "AAAA" } } }),
        JSON.stringify({ version: 1, entries: { a: { n: 1, c: "AAAA", t: "AAAA" } } }),
        JSON.stringify({ version: 1, entries: { a: { n: "!!!", c: "AAAA", t: "AAAAAAAAAAAAAAAAAAAAAA==" } } }),
      ];
      for (const content of bad) {
        const { file, keyFile } = setup();
        writeFileSync(file, content);
        const store = new FileSecretStore({ file, keyFile });
        await unavailable(store.get(ACCOUNT));
        await unavailable(store.set(ACCOUNT, KEY));
        await unavailable(store.delete(ACCOUNT));
        expect(readFileSync(file, "utf8")).toBe(content);
      }
    });

    it("a data path that is a folder", async () => {
      const { data, keyFile } = setup();
      const file = join(data, "secrets.enc.json");
      mkdirSync(file);
      await unavailable(new FileSecretStore({ file, keyFile }).get(ACCOUNT));
    });

    it("errors never carry the account, the value or the key", async () => {
      const { file, store } = setup();
      await store.set(ACCOUNT, KEY);
      const keyFile = join(tmp(), "wrong.key");
      writeFileSync(keyFile, randomBytes(32));
      const err = await new FileSecretStore({ file, keyFile }).get(ACCOUNT).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SecretStoreUnavailableError);
      const text = `${(err as Error).message} ${String((err as Error).stack)} ${JSON.stringify(err)}`;
      expect(text).not.toContain(ACCOUNT);
      expect(text).not.toContain("TESTKEY");
      expect((err as Error).cause).toBeUndefined();
    });
  });

  describe("verify", () => {
    it("passes with no data file, with an empty file and when every entry opens with this key", async () => {
      const { store, keyFile, file } = setup();
      expect(() => store.verify()).not.toThrow();
      expect(existsSync(file)).toBe(false);
      await store.set(ACCOUNT, KEY);
      await store.set("another/account", OTHER);
      expect(() => store.verify()).not.toThrow();
      expect(() => new FileSecretStore({ file, keyFile }).verify()).not.toThrow();
    });

    it("a different 32-byte key with existing ciphertext fails with the key message, and leaves the file as it was", async () => {
      const { store, file } = setup();
      await store.set(ACCOUNT, KEY);
      const before = readFileSync(file);
      const otherKey = join(tmp(), "other.key");
      writeFileSync(otherKey, randomBytes(32));
      const wrong = new FileSecretStore({ file, keyFile: otherKey });
      expect(() => wrong.verify()).toThrow(SecretStoreUnavailableError);
      expect(() => wrong.verify()).toThrow("the secret key does not open the secrets file");
      expect(readFileSync(file)).toEqual(before);
    });

    it("a wrong-size or missing key and a corrupt data file fail with their own fixed messages", async () => {
      const { store, file, keyFile } = setup();
      await store.set(ACCOUNT, KEY);
      writeFileSync(keyFile, randomBytes(31));
      expect(() => new FileSecretStore({ file, keyFile }).verify()).toThrow("secret key file unavailable");
      expect(() => new FileSecretStore({ file, keyFile: join(tmp(), "none.key") }).verify()).toThrow("secret key file unavailable");
      const { file: f2, keyFile: k2 } = setup();
      writeFileSync(f2, "{ not json");
      expect(() => new FileSecretStore({ file: f2, keyFile: k2 }).verify()).toThrow("secret store file unavailable");
    });
  });

  describe("createKey", () => {
    it("writes a 32-byte 0600 key file (and its folder) when missing, and uses it", async () => {
      const data = tmp();
      const keyFile = join(tmp(), "key", "secret.key");
      const file = join(data, "secrets.enc.json");
      const store = new FileSecretStore({ file, keyFile, createKey: true });
      await store.set(ACCOUNT, KEY);
      expect(statSync(keyFile).size).toBe(32);
      if (!WIN) expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      expect(await new FileSecretStore({ file, keyFile }).get(ACCOUNT)).toBe(KEY);
      expect(readdirSync(data)).toEqual(["secrets.enc.json"]);
    });

    it("never replaces an existing key file", async () => {
      const { file, keyFile, store } = setup();
      await store.set(ACCOUNT, KEY);
      const key = readFileSync(keyFile);
      const again = new FileSecretStore({ file, keyFile, createKey: true });
      expect(await again.get(ACCOUNT)).toBe(KEY);
      expect(readFileSync(keyFile).equals(key)).toBe(true);
    });

    it("still refuses an existing key file of the wrong size", async () => {
      const { file } = setup();
      const keyFile = join(tmp(), "short.key");
      writeFileSync(keyFile, randomBytes(8));
      await unavailable(new FileSecretStore({ file, keyFile, createKey: true }).get(ACCOUNT));
      expect(statSync(keyFile).size).toBe(8);
    });
  });
});

describe("assertKeyOutsideDataDir", () => {
  const MESSAGE = "Refusing to start: the secret key file is inside the data directory";

  it("refuses a key file inside the data dir, at any depth or via a relative path", () => {
    const data = tmp();
    for (const keyFile of [join(data, "secret.key"), join(data, "a", "b", "secret.key"), join(data, "x", "..", "k")]) {
      expect(() => assertKeyOutsideDataDir(keyFile, data)).toThrow(KeyInsideDataDirError);
      expect(() => assertKeyOutsideDataDir(keyFile, data)).toThrow(MESSAGE);
    }
    expect(() => assertKeyOutsideDataDir(data, data)).toThrow(KeyInsideDataDirError);
  });

  it("allows it when allowKeyInDataDir is set", () => {
    const data = tmp();
    expect(() => assertKeyOutsideDataDir(join(data, "secret.key"), data, true)).not.toThrow();
  });

  it("accepts a key file outside the data dir, including a sibling with a shared prefix", () => {
    const root = tmp();
    const data = join(root, "data");
    mkdirSync(data);
    expect(() => assertKeyOutsideDataDir(join(root, "key", "secret.key"), data)).not.toThrow();
    expect(() => assertKeyOutsideDataDir(join(root, "data-key", "secret.key"), data)).not.toThrow();
    expect(() => assertKeyOutsideDataDir(join(root, "secret.key"), data)).not.toThrow();
  });

  it.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
    "treats a different letter case as the same folder where the file system ignores case",
    () => {
      const data = tmp();
      expect(() => assertKeyOutsideDataDir(join(data.toUpperCase(), "secret.key"), data)).toThrow(KeyInsideDataDirError);
    },
  );
});

describe("assertKeyOutsideDataDir: names that start with two dots", () => {
  it("treats a folder named ..x or ... inside the data folder as inside", () => {
    const data = mkdtempSync(join(tmpdir(), "fs-dots-"));
    for (const name of ["..x", "...", "..secret"]) {
      mkdirSync(join(data, name), { recursive: true });
      expect(() => assertKeyOutsideDataDir(join(data, name, "secret.key"), data)).toThrow(KeyInsideDataDirError);
    }
    expect(() => assertKeyOutsideDataDir(join(data, "..", "elsewhere.key"), data)).not.toThrow();
  });
});
