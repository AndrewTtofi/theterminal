import { describe, it, expect } from "vitest";
import { base32Decode, base32Encode } from "../../src/link/base32.js";

describe("Crockford base32", () => {
  it("encodes one zero byte as two symbols, without padding", () => {
    expect(base32Encode(new Uint8Array([0]))).toBe("00");
  });

  it("round-trips 12 bytes as 20 symbols", () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x7a, 0x13, 0x88, 0x01, 0xfe, 0x42, 0x99, 0x10, 0xab, 0xcd]);
    const text = base32Encode(bytes);
    expect(text).toHaveLength(20);
    expect(text).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
    expect([...base32Decode(text)]).toEqual([...bytes]);
  });

  it("encodes the empty input as the empty string", () => {
    expect(base32Encode(new Uint8Array())).toBe("");
    expect(base32Decode("")).toEqual(new Uint8Array());
  });

  it("throws RangeError on a symbol outside the alphabet", () => {
    expect(() => base32Decode("U")).toThrow(RangeError);
    expect(() => base32Decode("0O")).toThrow(RangeError);
    expect(() => base32Decode("0a")).toThrow(RangeError);
  });
});
