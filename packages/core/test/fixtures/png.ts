/** A 1×1 PNG. */
export const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c6360000200000500017a5eab3f0000000049454e44ae426082",
  "hex",
);

/** A PNG signature and IHDR of `width`×`height`, then `tail`: enough for the header checks. */
export function pngOf(width: number, height: number, tail = "x"): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(6, 17);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), ihdr, Buffer.from(tail)]);
}
