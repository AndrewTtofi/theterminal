import { describe, expect, it } from "vitest";
import { keyBlockAround, openKeyBlock } from "../../src/agents/gemini/key-blocks.js";

const BODY = "MIIEFAKEKEYBODY0000MIIEFAKEKEYBODY0001MIIEFAKEKEYBODY0002MIIEFAKEKEYBODY0003";

describe("private key blocks in streamed text", () => {
  it("opens at the line start of a BEGIN marker, whatever precedes it on the line, and closes after its END marker", () => {
    const open = `x\n> -----BEGIN RSA PRIVATE KEY-----\n> ${BODY}\n> MIIEpartial`;
    expect(openKeyBlock(open)).toBe(2);
    expect(keyBlockAround(open, open.length)).toBe(2);
    expect(keyBlockAround(open, 2)).toBe(-1); // the block's own start is not inside it
    const closed = `x\n-----BEGIN RSA PRIVATE KEY-----\n${BODY}\n-----END RSA PRIVATE KEY-----\nafter`;
    expect(openKeyBlock(closed)).toBe(-1);
    expect(keyBlockAround(closed, closed.indexOf("-----END") + 5)).toBe(2); // inside the END marker
    expect(keyBlockAround(closed, closed.indexOf("\nafter"))).toBe(-1); // right after the END marker
  });

  it("keeps prose, blank and long lines inside a block: only an END marker closes it", () => {
    const text = `-----BEGIN PRIVATE KEY-----\n${BODY}\nnot body, clearly.\n\n${"A".repeat(200)}\nmore`;
    expect(openKeyBlock(text)).toBe(0);
    expect(keyBlockAround(text, text.length - 1)).toBe(0);
    expect(openKeyBlock("Use -----BEGIN EC PRIVATE KEY----- here.\nmore")).toBe(0);
  });

  it("treats a key escaped onto one line as one block, closed at its END marker", () => {
    const json = `{"key":"-----BEGIN PRIVATE KEY-----\\n${BODY}\\n-----END PRIVATE KEY-----\\n","n":1}`;
    expect(openKeyBlock(json)).toBe(-1);
    expect(keyBlockAround(json, 20)).toBe(0);
    expect(keyBlockAround(json, json.length - 1)).toBe(-1);
    expect(openKeyBlock(`{"key":"-----BEGIN PRIVATE KEY-----\\n${BODY}`)).toBe(0);
  });

  it("closes a block at any private key END label, and finds the block after it", () => {
    const two = `-----BEGIN RSA PRIVATE KEY-----\na\n-----END PRIVATE KEY-----\nmid\n-----BEGIN EC PRIVATE KEY-----\nb`;
    expect(keyBlockAround(two, two.indexOf("mid"))).toBe(-1);
    expect(openKeyBlock(two)).toBe(two.indexOf("-----BEGIN EC"));
    const sameLine = `-----BEGIN RSA PRIVATE KEY----- a -----END RSA PRIVATE KEY----- -----BEGIN EC PRIVATE KEY----- b`;
    const firstEnd = sameLine.indexOf("-----END") + "-----END RSA PRIVATE KEY-----".length;
    expect(openKeyBlock(sameLine)).toBe(firstEnd); // its line start would be inside the block before it: it starts where that one ends
    expect(keyBlockAround(sameLine, firstEnd)).toBe(-1);
  });

  it("never holds a certificate or other non-private block", () => {
    expect(openKeyBlock("-----BEGIN CERTIFICATE-----\nMIIB")).toBe(-1);
    expect(openKeyBlock("-----BEGIN PUBLIC KEY-----\nMIIB")).toBe(-1);
    expect(keyBlockAround("-----BEGIN CERTIFICATE-----\nMIIB", 10)).toBe(-1);
  });
});
