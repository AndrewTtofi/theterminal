import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/ledger/canonical.js";

/**
 * The encoding as it was before the canonical string was built directly: a reference copy, kept here so the tests
 * can prove the new encoder is byte-identical to it for every value that has no own `__proto__` key. (For values
 * that do have one, this copy silently drops the key, which is the bug the encoder fixes.)
 */
function legacyCanonicalJson(value: unknown): string {
  const canonicalize = (v: unknown): unknown => {
    if (typeof v !== "object" || v === null) return v;
    if (Array.isArray(v)) return v.map(canonicalize);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) out[key] = canonicalize((v as Record<string, unknown>)[key]);
    return out;
  };
  return JSON.stringify(canonicalize(value));
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("canonicalJson", () => {
  it("sorts keys recursively with no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it("keeps array order and handles null", () => {
    expect(canonicalJson({ x: [3, { b: 1, a: null }] })).toBe('{"x":[3,{"a":null,"b":1}]}');
  });
  it("rejects undefined and functions", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
    expect(() => canonicalJson(undefined)).toThrow();
  });
  it("orders array-index keys first, numerically, then the rest by code unit (the engine's own-key order)", () => {
    const v = { b: 1, a: 2, "10": 3, "9": 4, "01": 5, "-1": 6, "4294967294": 7, "4294967295": 8, "": 9 };
    expect(canonicalJson(v)).toBe('{"9":4,"10":3,"4294967294":7,"":9,"-1":6,"01":5,"4294967295":8,"a":2,"b":1}');
  });
  it("rejects symbols, bigints and non-finite numbers, naming the path", () => {
    expect(() => canonicalJson({ a: [1, Symbol("s")] })).toThrow(/\$\.a\[1\]/);
    expect(() => canonicalJson({ a: 1n })).toThrow(/bigint at \$\.a/);
    expect(() => canonicalJson({ a: { b: NaN } })).toThrow(/non-finite number at \$\.a\.b/);
    expect(() => canonicalJson(Infinity)).toThrow(/non-finite number at \$/);
  });

  describe("prototype-named keys", () => {
    it("keeps an own __proto__ key that JSON.parse created, at any depth", () => {
      const top = JSON.parse('{"a":1,"__proto__":{"polluted":true}}');
      expect(Object.keys(top)).toEqual(["a", "__proto__"]);
      expect(canonicalJson(top)).toBe('{"__proto__":{"polluted":true},"a":1}');
      const nested = JSON.parse('{"input":{"command":"ls","__proto__":{"x":1}},"z":[{"__proto__":null}]}');
      expect(canonicalJson(nested)).toBe('{"input":{"__proto__":{"x":1},"command":"ls"},"z":[{"__proto__":null}]}');
    });
    it("is injective: values that differ only by a __proto__ key encode differently", () => {
      const plain = JSON.parse('{"a":1}');
      const withProto = JSON.parse('{"a":1,"__proto__":{"polluted":true}}');
      expect(canonicalJson(withProto)).not.toBe(canonicalJson(plain));
      expect(sha256(canonicalJson(withProto))).not.toBe(sha256(canonicalJson(plain)));
      // Round trip: the stored bytes parse back to a value that encodes to the same bytes.
      expect(canonicalJson(JSON.parse(canonicalJson(withProto)))).toBe(canonicalJson(withProto));
    });
    it("keeps constructor, prototype and other Object.prototype names as ordinary keys", () => {
      const v = JSON.parse('{"prototype":1,"constructor":2,"hasOwnProperty":3,"toString":4,"valueOf":5,"__defineGetter__":6}');
      expect(canonicalJson(v)).toBe(
        '{"__defineGetter__":6,"constructor":2,"hasOwnProperty":3,"prototype":1,"toString":4,"valueOf":5}',
      );
    });
    it("does not pollute Object.prototype while encoding", () => {
      canonicalJson(JSON.parse('{"__proto__":{"canonicalPolluted":true}}'));
      expect(({} as Record<string, unknown>).canonicalPolluted).toBeUndefined();
    });
    it("ignores inherited properties, as before", () => {
      const v = Object.create({ inherited: 1 }) as Record<string, unknown>;
      v.own = 2;
      expect(canonicalJson(v)).toBe('{"own":2}');
    });
  });

  describe("compatibility with the previous encoding", () => {
    const payloads: unknown[] = [
      null,
      true,
      false,
      0,
      -0,
      1e21,
      1.5e-7,
      -123.456,
      "",
      "plain",
      'quotes " and \\ backslash \n newline \t tab \u0000 nul \u2028 \u2029',
      "ünïcödé 😀 \ud83d\ude00 lone surrogate \ud800",
      [],
      {},
      [[], {}, [{}], { a: [] }],
      { b: 1, a: { d: 2, c: 3 } },
      { x: [3, { b: 1, a: null }] },
      { "": 0, " ": 1, "\u0000": 2, "😀": 3, Z: 4, a: 5, A: 6, "10": 7, "9": 8, "1": 9 },
      {
        b: 1, a: 1, "10": 1, "9": 1, "1": 1, "0": 1, "-1": 1, "01": 1, "1.0": 1, "4294967294": 1, "4294967295": 1,
        "4294967296": 1, "9007199254740991": 1, "9007199254740992": 1, "18446744073709551616": 1, "1e3": 1, "00": 1,
        " 1": 1, "-0": 1, "": 1, nested: { "2": [{ "1": 1, "0": 0, x: "y" }], "1": 0 },
      },
      { prototype: 1, constructor: 2, hasOwnProperty: 3, toString: 4 },
      { date: new Date(0) },
      { nested: { deep: { deeper: { deepest: [1, "two", { three: 3 }] } } } },
      {
        seq: 2,
        id: "00000000-0000-4000-8000-000000000002",
        ts: "2026-01-02T03:04:06.000Z",
        projectId: "p1",
        actor: { kind: "agent", id: "run-1" },
        type: "agent.action.requested",
        payload: {
          actionId: "a1",
          runId: "r1",
          kind: "tool",
          tool: "Bash",
          summary: "ls",
          input: { command: "ls", args: ["-l", "/tmp"], env: { Z: "1", A: 'ünï "q" \\ \n', b: -0, c: 1e21, d: 1.5e-7 }, flag: false, nothing: null },
        },
        prevHash: "a".repeat(64),
      },
    ];

    it("is byte-identical to the previous encoder for every value without an own __proto__ key", () => {
      for (const p of payloads) {
        expect(canonicalJson(p), JSON.stringify(p)).toBe(legacyCanonicalJson(p));
      }
    });

    it("is byte-identical to the previous encoder for 2000 generated values (seeded)", () => {
      // A small deterministic PRNG (mulberry32), so a failure reproduces.
      let seed = 0x5eed1234;
      const rand = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
      const keys = [
        "a", "b", "A", "", " ", "0", "1", "9", "10", "01", "-1", "1.0", "4294967294", "4294967295", "constructor",
        "prototype", "hasOwnProperty", "toString", "\u0000", "😀", "ü", "key with spaces", "\"quoted\"", "\\",
      ] as const;
      const strings = ["", "x", "ünï \"q\" \\ \n\t\u0000\u2028", "\ud800", "😀"] as const;
      const numbers = [0, -0, 1, -1, 1.5, 1e21, 1e-7, 123456789, -0.000001, 2 ** 53] as const;
      const gen = (depth: number): unknown => {
        const r = rand();
        if (depth === 0 || r < 0.3) {
          const k = rand();
          return k < 0.25 ? null : k < 0.5 ? pick(strings) : k < 0.75 ? pick(numbers) : rand() < 0.5;
        }
        if (r < 0.55) return Array.from({ length: Math.floor(rand() * 4) }, () => gen(depth - 1));
        const o: Record<string, unknown> = {};
        for (let i = Math.floor(rand() * 6); i > 0; i--) o[pick(keys)] = gen(depth - 1);
        return o;
      };
      for (let i = 0; i < 2000; i++) {
        const v = gen(4);
        expect(canonicalJson(v), JSON.stringify(v)).toBe(legacyCanonicalJson(v));
      }
    });

    it("reproduces the hash of an entry written by the previous encoder (golden fixture)", () => {
      const entry = {
        seq: 1,
        id: "00000000-0000-4000-8000-000000000001",
        ts: "2026-01-02T03:04:05.000Z",
        projectId: null,
        actor: { kind: "human", id: "owner" },
        type: "project.created",
        payload: { projectId: "p1", name: "n", pitch: "p" },
        prevHash: "0".repeat(64),
      };
      expect(sha256(canonicalJson(entry))).toBe("8433b75ad1373a3fd09ba9938ee14fb29012f3b80ebed703bd0cc33d383cc56b");
      const entry2 = {
        seq: 2,
        id: "00000000-0000-4000-8000-000000000002",
        ts: "2026-01-02T03:04:06.000Z",
        projectId: "p1",
        actor: { kind: "agent", id: "run-1" },
        type: "agent.action",
        payload: {
          actionId: "a1",
          runId: "r1",
          kind: "tool",
          tool: "Bash",
          summary: "ls",
          input: {
            command: "ls",
            args: ["-l", "/tmp"],
            env: { Z: "1", A: 'ünï "q" \\ \n', b: -0, c: 1e21, d: 1.5e-7 },
            flag: false,
            nothing: null,
            prototype: 1,
            constructor: 2,
            hasOwnProperty: 3,
            "": 4,
            "\u0000": 5,
            "😀": 6,
          },
        },
        prevHash: "a".repeat(64),
      };
      expect(canonicalJson(entry2)).toBe(
        '{"actor":{"id":"run-1","kind":"agent"},"id":"00000000-0000-4000-8000-000000000002","payload":{"actionId":"a1","input":{"":4,"\\u0000":5,"args":["-l","/tmp"],"command":"ls","constructor":2,"env":{"A":"ünï \\"q\\" \\\\ \\n","Z":"1","b":0,"c":1e+21,"d":1.5e-7},"flag":false,"hasOwnProperty":3,"nothing":null,"prototype":1,"😀":6},"kind":"tool","runId":"r1","summary":"ls","tool":"Bash"},"prevHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","projectId":"p1","seq":2,"ts":"2026-01-02T03:04:06.000Z","type":"agent.action"}',
      );
      expect(sha256(canonicalJson(entry2))).toBe("803591817cfc29a15f06d5545c9f1b3f2e2afe07e615c66c1d100328ce6f5378");
    });
  });
});

describe("canonicalJson: sparse arrays", () => {
  it("encodes a hole as null, as the old encoder did, so the output is always valid JSON", () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    expect(canonicalJson(sparse)).toBe("[1,null,3]");
    expect(canonicalJson(new Array(2))).toBe("[null,null]");
    expect(canonicalJson({ a: [, "x"] })).toBe('{"a":[null,"x"]}');
    expect(() => JSON.parse(canonicalJson(sparse))).not.toThrow();
  });
});
