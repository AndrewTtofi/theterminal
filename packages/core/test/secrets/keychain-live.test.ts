import { describe, it, expect } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { ChunkedSecretStore } from "../../src/secrets/store.js";
import { KeychainSecretStore } from "../../src/secrets/keychain-store.js";

// Touches the real OS keychain: opt in with THETERMINAL_LIVE_KEYCHAIN=1.
describe.skipIf(process.env.THETERMINAL_LIVE_KEYCHAIN !== "1")("KeychainSecretStore (live)", () => {
  it("sets, reads back and deletes a random value", async () => {
    const store = new KeychainSecretStore();
    const account = `theterminal-test/${randomUUID()}`;
    const value = `test-${randomBytes(24).toString("hex")}`;
    try {
      await store.set(account, value);
      expect(await store.get(account)).toBe(value);
    } finally {
      await store.delete(account);
    }
    expect(await store.get(account)).toBeNull();
  });

  it("round-trips a value larger than one chunk through the default composition", async () => {
    const store = new ChunkedSecretStore(new KeychainSecretStore());
    const account = `theterminal-test/${randomUUID()}`;
    const value = randomBytes(3000).toString("hex"); // 6000 bytes, 3 chunks
    try {
      await store.set(account, value);
      expect(await store.get(account)).toBe(value);
    } finally {
      await store.delete(account);
    }
    expect(await store.get(account)).toBeNull();
  });
});
