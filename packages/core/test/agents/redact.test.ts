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

describe("redact: leak fixes", () => {
  const r = (s: string) => redact(s);
  it("redacts quoted values, keeping the quotes", () => {
    expect(r('export DB_PASSWORD="hunter2 with space"')).toBe(`export DB_PASSWORD="${REDACTED}"`);
    expect(r("export OPENAI_API_KEY='shortsecretval'")).toBe(`export OPENAI_API_KEY='${REDACTED}'`);
  });
  it("redacts an unterminated PEM block and PGP blocks", () => {
    const out = r("x -----BEGIN PRIVATE KEY-----\nFAKEBODYFAKEBODY\nmore");
    expect(out).toBe(`x ${REDACTED}`);
    expect(r("-----BEGIN PGP PRIVATE KEY BLOCK-----\nFAKE\n-----END PGP PRIVATE KEY BLOCK-----!")).toBe(`${REDACTED}!`);
  });
  it("handles case-insensitive Bearer and Basic", () => {
    expect(r("authorization: bearer abcdef123456")).toBe(`authorization: bearer ${REDACTED}`);
    expect(r("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe(`Authorization: Basic ${REDACTED}`);
  });
  it("redacts header, JSON and YAML key syntaxes", () => {
    expect(r("x-api-key: FAKEVALUE1")).toBe(`x-api-key: ${REDACTED}`);
    expect(r("anthropic-api-key: FAKEVALUE1")).toBe(`anthropic-api-key: ${REDACTED}`);
    expect(r('{"password": "pw with space", "user": "bob"}')).toBe(`{"password": "${REDACTED}", "user": "bob"}`);
    expect(r("client_secret: FAKEVALUE1\nname: x")).toBe(`client_secret: ${REDACTED}\nname: x`);
    expect(r("Cookie: a=1; b=2\nHost: example.com")).toBe(`Cookie: ${REDACTED}\nHost: example.com`);
    expect(r("Set-Cookie: sid=FAKE; Path=/")).toBe(`Set-Cookie: ${REDACTED}`);
    expect(r("AWS_SECRET_ACCESS_KEY=FAKEFAKE")).toBe(`AWS_SECRET_ACCESS_KEY=${REDACTED}`);
  });
  it("redacts URL userinfo", () => {
    expect(r("git clone https://user:FAKEPASS@example.com/x.git")).toBe(
      `git clone https://user:${REDACTED}@example.com/x.git`,
    );
    expect(r("https://x-access-token:ghs_" + "F".repeat(24) + "@example.com/x")).toBe(
      `https://x-access-token:${REDACTED}@example.com/x`,
    );
  });
  it("redacts more token shapes", () => {
    const samples = [
      "github_pat_" + "F".repeat(25),
      "npm_" + "F".repeat(25),
      "sk_live_" + "F".repeat(12),
      "rk_test_" + "F".repeat(12),
      "ASIA" + "F".repeat(16),
      "eyJhbGciOiJGQUtF.eyJzdWIiOiJGQUtF.FAKESIG",
      "https://hooks.slack.com/services/TFAKE/BFAKE/FAKEFAKE",
    ];
    for (const s of samples) expect(r(`a ${s} b`)).toBe(`a ${REDACTED} b`);
  });
  it("keeps ordinary words and counters", () => {
    expect(r("task-management-system-name-here")).toBe("task-management-system-name-here");
    expect(redact({ max_tokens: 5, author: "x" })).toEqual({ max_tokens: 5, author: "x" });
  });
  it("redacts whole non-string values under secret keys", () => {
    expect(redact({ password: 12345678, token: ["abc"], secret: { v: "plain" } })).toEqual({
      password: REDACTED,
      token: REDACTED,
      secret: REDACTED,
    });
  });
  it("redacts secret pairs that follow a non-secret key or separator", () => {
    expect(r("docker run --env=API_KEY=FAKESECRET1 img")).toBe(`docker run --env=API_KEY=${REDACTED} img`);
    expect(r("env: API_KEY=FAKESECRET1")).toBe(`env: API_KEY=${REDACTED}`);
    expect(r("https://x.com/api?access_token=FAKESECRET1&b=1")).toBe(`https://x.com/api?access_token=${REDACTED}&b=1`);
    expect(r("note:password=FAKESECRET1")).toBe(`note:password=${REDACTED}`);
    expect(r("x=DB_PASSWORD=FAKESECRET1")).toBe(`x=DB_PASSWORD=${REDACTED}`);
    expect(r("ENV:SECRET_KEY=FAKESECRET1")).toBe(`ENV:SECRET_KEY=${REDACTED}`);
  });
  it("redacts long and multi-line quoted values entirely", () => {
    const long = "a".repeat(5000);
    expect(r(`password="${long}"`)).toBe(`password="${REDACTED}"`);
    expect(r(`password='${long}' x`)).toBe(`password='${REDACTED}' x`);
    expect(r(`Cookie: "${long}"`)).toBe(`Cookie: "${REDACTED}"`);
    expect(r('password="line1\nline2" after')).toBe(`password="${REDACTED}" after`);
    expect(r('password="line1\nline2')).toBe(`password="${REDACTED}`);
  });
  it("treats only known counters as non-secret tokens", () => {
    expect(r("GITHUB_TOKENS=FAKESECRET1")).toBe(`GITHUB_TOKENS=${REDACTED}`);
    expect(redact({ github_tokens: "FAKESECRET1" })).toEqual({ github_tokens: REDACTED });
    expect(redact({ max_tokens: 1, input_tokens: 2, max_output_tokens: 3, maxTokens: 4 })).toEqual({
      max_tokens: 1,
      input_tokens: 2,
      max_output_tokens: 3,
      maxTokens: 4,
    });
  });
  it("is linear on large input", () => {
    const inputs = [
      "a".repeat(1_000_000),
      "some words here key=value and more text sk-notasecret ".repeat(20_000),
      'k="'.repeat(300_000),
      " ".repeat(1_000_000) + "a",
      "a=b=c=".repeat(170_000),
      '"'.repeat(1_000_000),
      'password="'.repeat(100_000),
    ];
    for (const input of inputs) {
      const t = performance.now();
      redact(input);
      expect(performance.now() - t).toBeLessThan(200);
    }
  });
});

describe("truncate", () => {
  it("never exceeds max, even below the marker length", () => {
    expect(truncate("x".repeat(50), 0)).toBe("");
    expect(truncate("x".repeat(50), 5)).toHaveLength(5);
    expect(truncate("x".repeat(50), 12)).toBe("…[truncated]");
  });
  it("returns short strings unchanged", () => expect(truncate("abc", 3)).toBe("abc"));
  it("cuts to exactly max with a marker", () => {
    const out = truncate("x".repeat(100), 40);
    expect(out).toHaveLength(40);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });
});
