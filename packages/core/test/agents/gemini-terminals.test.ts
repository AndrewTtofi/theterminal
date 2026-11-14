import { EventEmitter } from "node:events";
import type { spawn as nodeSpawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { redact } from "../../src/agents/redact.js";
import { Terminals } from "../../src/agents/gemini/terminals.js";
import { KEY_FORMS, RSA_KEY, leakedKeyBody } from "../fixtures/key-forms.js";

const STORED = "stored-conn-value-0123456789";
const SECRETS = [STORED, "sk-ant-api03-TESTKEYabcdefghijklmnop", "ghp_TESTKEY0123456789abcdefghij"];
const clean = (t: string) => redact(t, [STORED]);

/** A child whose output the test writes chunk by chunk. */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
  return child;
}

/** Runs one terminal that prints `chunks` (each its own data event), and returns the record handed on at exit. */
function recordOf(chunks: string[], outputByteLimit: number): string {
  const child = fakeChild();
  let record: string | undefined;
  const terminals = new Terminals((() => child) as unknown as typeof nodeSpawn, clean, (_id, _status, r) => (record = r));
  terminals.create("cmd", [], { cwd: ".", env: {}, outputByteLimit });
  for (const c of chunks) child.stdout.emit("data", Buffer.from(c, "utf8"));
  child.emit("close", 0, null);
  return record!;
}

function expectNoFragment(text: string, secret: string, label: string): void {
  for (let i = 0; i + 6 <= secret.length; i++) expect(text, label).not.toContain(secret.slice(i, i + 6));
}

describe("Terminals record", () => {
  it("holds an unfinished line raw across a record cut, so a key split across two chunks at any position leaves no fragment", () => {
    const filler = `${"y".repeat(79)}\n`.repeat(8); // 640 bytes: well past twice the cap, so the record is cut on this chunk
    for (const secret of SECRETS) {
      for (let at = 1; at < secret.length; at++) {
        for (const [prefix, limit] of [[filler, 200], [filler, 40], ["x".repeat(700), 200]] as const) {
          const label = `${secret.slice(0, 4)} split at ${at}, cap ${limit}`;
          const record = recordOf([`${prefix}token ${secret.slice(0, at)}`, `${secret.slice(at)} rejected\n`], limit);
          expectNoFragment(record, secret, label);
          expect(record.endsWith("[REDACTED] rejected\n"), label).toBe(true);
        }
      }
    }
  });

  it("cleans the whole held line once it passes 8 KiB", () => {
    const long = `token ${SECRETS[1]} ${"z".repeat(9000)}`;
    const record = recordOf(["y".repeat(700) + "\n", long, " more", " end\n"], 200);
    expectNoFragment(record, SECRETS[1]!, "long line");
    expect(record.endsWith(" more end\n")).toBe(true);
  });

  it("holds a private key block, or a secret block scalar, that has not ended yet across a record cut", () => {
    const filler = `${"y".repeat(79)}\n`.repeat(8);
    const key = KEY_FORMS.plain!(RSA_KEY);
    for (const at of [key.indexOf("\n") + 1, Math.floor(key.length / 2), key.lastIndexOf("-----END")]) {
      const record = recordOf([`${filler}${key.slice(0, at)}`, `${key.slice(at)}after\n`], 200);
      expect(leakedKeyBody(record, RSA_KEY), `key split at ${at}`).toBeNull();
      expect(record.endsWith("[REDACTED]\nafter\n")).toBe(true);
    }
    const body = ["  zq0RS6kd83JWnB2yT5pe7MaV4cUx", "  9hLf1Gt0aB3cD5eF7gH9iJ1kL3mN"];
    const record = recordOf([`${filler}password: |\n${body[0]}\n`, `${body[1]}\ndone\n`], 200);
    for (const line of body) expect(record).not.toContain(line.trim().slice(0, 10));
    expect(record.endsWith("password: [REDACTED]\ndone\n")).toBe(true);
  });
});
