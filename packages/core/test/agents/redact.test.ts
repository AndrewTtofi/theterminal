import { describe, expect, it } from "vitest";
import { REDACTED, redact, truncate } from "../../src/index.js";

describe("redact", () => {
  it("redacts bearer tokens and sk-ant keys", () => {
    const out = redact("curl -H 'Authorization: Bearer sk-ant-TESTKEY000000abcdef'");
    expect(out).not.toContain("sk-ant");
    expect(out).toContain("Bearer [REDACTED]");
  });
  it("redacts known key formats", () => {
    const samples = [
      "sk-ant-TESTKEY000000abcdef",
      "sk-FAKEFAKEFAKEFAKEFAKE0000",
      "AKIAFAKEFAKEFAKE0000",
      "ghp_FAKEFAKEFAKEFAKEFAKE0000",
      "xoxb-FAKE-FAKE-FAKE0000",
      "AIza" + "F".repeat(35),
    ];
    for (const s of samples) {
      const out = redact(`token is ${s} ok`);
      expect(out).toBe(`token is ${REDACTED} ok`);
    }
  });
  it("redacts the value of KEY=value pairs", () => {
    expect(redact({ env: "ANTHROPIC_API_KEY=xyz123" })).toEqual({ env: "ANTHROPIC_API_KEY=[REDACTED]" });
    expect(redact("DB_PASSWORD=hunter2 other=1")).toBe("DB_PASSWORD=[REDACTED] other=1");
  });
  it("redacts values of secret-named object keys", () => {
    expect(redact({ apiKey: "abc", nested: [{ password: "p" }], name: "n" })).toEqual({
      apiKey: REDACTED,
      nested: [{ password: REDACTED }],
      name: "n",
    });
  });
  it("redacts a whole PEM block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nFAKEFAKE\nFAKE\n-----END RSA PRIVATE KEY-----";
    expect(redact(`a\n${pem}\nb`)).toBe(`a\n${REDACTED}\nb`);
  });
  it("honours extraSecrets", () => {
    expect(redact("hello workspace-tok-123 bye", ["workspace-tok-123"])).toBe(`hello ${REDACTED} bye`);
  });
  it("leaves non-secret text and non-string values unchanged", () => {
    expect(redact("just some text, 42 files")).toBe("just some text, 42 files");
    expect(redact({ n: 1, b: true, z: null })).toEqual({ n: 1, b: true, z: null });
  });
  it("does not mutate the input", () => {
    const input = { a: "Bearer abcdefghij", list: ["sk-ant-TESTKEY000000abcdef"] };
    const copy = JSON.parse(JSON.stringify(input));
    const out = redact(input);
    expect(input).toEqual(copy);
    expect(out).not.toBe(input);
  });
});

describe("truncate", () => {
  it("returns short strings unchanged", () => expect(truncate("abc", 3)).toBe("abc"));
  it("cuts to exactly max with a marker", () => {
    const out = truncate("x".repeat(100), 40);
    expect(out).toHaveLength(40);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });
});
