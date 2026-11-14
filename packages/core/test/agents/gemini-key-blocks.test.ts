import { describe, expect, it } from "vitest";
import { keyBlockAround, openKeyBlock, sealKeyBlocks } from "../../src/agents/gemini/key-blocks.js";
import { redact } from "../../src/agents/redact.js";

const BODY = ["MIIEowIBAAKCAQEAx1y2z3w4v5u6t7s8r9q0p1o2n3m4l5k6j7i8h9g0f1e2d3c4", "b5a6Z7Y8X9W0V1U2T3S4R5Q6P7O8N9M0L1K2J3I4H5G6F7E8D9C0B1A2==", ""];

describe("private key blocks in streamed text", () => {
  it("keeps a block open while its body is arriving and closes it at its END line", () => {
    const open = `x\n-----BEGIN RSA PRIVATE KEY-----\n${BODY[0]}\n${BODY[1].slice(0, 20)}`;
    expect(openKeyBlock(open)?.start).toBe(2);
    expect(keyBlockAround(open, open.length)).toBe(2);
    const closed = `x\n-----BEGIN RSA PRIVATE KEY-----\n${BODY.join("\n")}-----END RSA PRIVATE KEY-----\nafter`;
    expect(openKeyBlock(closed)).toBeNull();
    expect(redact(sealKeyBlocks(closed))).toBe("x\n[REDACTED]\nafter");
  });

  it("accepts PEM encryption headers, PGP armor headers and CRLF line ends as body", () => {
    for (const text of [
      `-----BEGIN RSA PRIVATE KEY-----\r\nProc-Type: 4,ENCRYPTED\r\nDEK-Info: AES-128-CBC,0011\r\n\r\n${BODY[0]}\r\n`,
      `-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: Example 1\nComment: test\n\n${BODY[0]}\n=AbCd\n`,
    ]) expect(openKeyBlock(text)?.start).toBe(0);
  });

  it("ends a block at the first line that cannot be body and seals only the lines before it", () => {
    expect(sealKeyBlocks("Use -----BEGIN EC PRIVATE KEY----- here.\nmore")).toBe("Use [REDACTED] here.\nmore");
    expect(sealKeyBlocks(`-----BEGIN PRIVATE KEY-----\n${BODY[0]}\nnot body, clearly.\nmore`)).toBe("[REDACTED]\nnot body, clearly.\nmore");
    expect(openKeyBlock(`-----BEGIN PRIVATE KEY-----\n${"A".repeat(81)}`)).toBeNull(); // a line over 80 is no body
  });

  it("treats a key escaped onto one line as one block, to its END marker or the end of that line", () => {
    const json = `{"key":"-----BEGIN PRIVATE KEY-----\\n${BODY[0]}\\n-----END PRIVATE KEY-----\\n","n":1}`;
    expect(redact(sealKeyBlocks(json))).not.toContain(BODY[0].slice(0, 12));
    const partial = `{"key":"-----BEGIN PRIVATE KEY-----\\n${BODY[0]}`;
    expect(openKeyBlock(partial)?.escaped).toBe(true);
    expect(sealKeyBlocks(`${partial}"}\nnext`)).toBe('{"key":"[REDACTED]\nnext');
  });

  it("never holds a certificate or other non-private block", () => {
    expect(openKeyBlock("-----BEGIN CERTIFICATE-----\nMIIB")).toBeNull();
  });
});
