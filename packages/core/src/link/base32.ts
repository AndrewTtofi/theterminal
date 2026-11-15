/** Crockford's base32 alphabet: digits and upper-case letters without I, L, O and U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Crockford base32, most significant bit first, no padding: the last symbol's unused low bits are zero. */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The bytes `base32Encode` wrote; trailing bits that do not fill a byte are dropped. Throws RangeError on any other symbol. */
export function base32Decode(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let value = 0;
  let bits = 0;
  let n = 0;
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new RangeError("symbol outside the base32 alphabet");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out[n++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}
