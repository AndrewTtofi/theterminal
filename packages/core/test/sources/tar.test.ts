import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readTarGz, TarInvalidError, TarLimitError, type TarEntry } from "../../src/sources/tar.js";
import { paxRecord, setChecksum, tar, tgz, type FixtureEntry } from "./tar-fixture.js";

const OPTS = { maxCompressedBytes: 10 * 1024 * 1024, maxEntries: 100 };
const ROOT = "octo-example-0123abc/";

type Seen = { entry: TarEntry; body: Buffer };

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function collect(archive: Buffer | Readable, opts: Parameters<typeof readTarGz>[2] = OPTS): Promise<Seen[]> {
  const seen: Seen[] = [];
  const input = Buffer.isBuffer(archive) ? Readable.from([archive]) : archive;
  await readTarGz(input, async (entry, body) => {
    seen.push({ entry, body: await readAll(body) });
  }, opts);
  return seen;
}

function dir(name: string): FixtureEntry {
  return { name, type: "5", mode: 0o755 };
}

describe("readTarGz", () => {
  it("reads three files, one in a subdirectory, with stripped paths and exact contents", async () => {
    const binary = Buffer.from([0, 1, 2, 255, 0, 10]);
    const seen = await collect(tgz([
      dir(ROOT),
      { name: `${ROOT}README.md`, body: "hello\n" },
      dir(`${ROOT}src/`),
      { name: `${ROOT}src/main.ts`, body: "export {};\n", mode: 0o755 },
      { name: `${ROOT}data.bin`, body: binary },
    ]));
    const files = seen.filter((s) => s.entry.kind === "file");
    expect(files.map((s) => s.entry.path)).toEqual(["README.md", "src/main.ts", "data.bin"]);
    expect(files[0].body.toString()).toBe("hello\n");
    expect(files[1].body.toString()).toBe("export {};\n");
    expect(files[1].entry.mode).toBe(0o755);
    expect(files[2].body.equals(binary)).toBe(true);
    expect(files[2].entry.size).toBe(binary.length);
    expect(seen.filter((s) => s.entry.kind === "dir").map((s) => s.entry.path)).toEqual(["src"]);
  });

  it("returns a 150-character path through pax x whole", async () => {
    const long = `${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(26)}.t`;
    expect(long.length).toBe(150);
    const pax = paxRecord("path", ROOT + long);
    const seen = await collect(tgz([
      { name: "pax_global_header", type: "g", body: paxRecord("comment", "0123abc") },
      { name: "PaxHeaders/x", type: "x", body: pax },
      { name: `${ROOT}truncated-name`, body: "long" },
      { name: `${ROOT}after.txt`, body: "after" },
    ]));
    expect(seen.map((s) => s.entry.path)).toEqual([long, "after.txt"]);
    expect(seen[0].body.toString()).toBe("long");
  });

  it("uses the pax size over the header's size", async () => {
    const seen = await collect(tgz([
      { name: "PaxHeaders/x", type: "x", body: paxRecord("size", "3") },
      { name: `${ROOT}a.txt`, body: "abc", size: 0 },
    ]));
    expect(seen[0].entry.size).toBe(3);
    expect(seen[0].body.toString()).toBe("abc");
  });

  it("joins the ustar prefix and reads GNU L long names", async () => {
    const longName = `${ROOT}${"g".repeat(200)}.txt`;
    const seen = await collect(tgz([
      { name: "b.txt", prefix: `${ROOT}a`, body: "prefixed" },
      { name: "././@LongLink", type: "L", body: `${longName}\0` },
      { name: `${ROOT}short`, body: "gnu" },
    ]));
    expect(seen.map((s) => s.entry.path)).toEqual(["a/b.txt", `${"g".repeat(200)}.txt`]);
    expect(seen.map((s) => s.body.toString())).toEqual(["prefixed", "gnu"]);
  });

  it("reports a symlink as a link, never yields its body, and still reads the next file", async () => {
    const seen = await collect(tgz([
      { name: `${ROOT}evil`, type: "2", linkname: "/etc/passwd" },
      { name: `${ROOT}hard`, type: "1", linkname: `${ROOT}README.md` },
      { name: `${ROOT}next.txt`, body: "still here" },
    ]));
    expect(seen.map((s) => [s.entry.path, s.entry.kind])).toEqual([["evil", "link"], ["hard", "link"], ["next.txt", "file"]]);
    expect(seen[0].body.length).toBe(0);
    expect(seen[1].body.length).toBe(0);
    expect(seen[2].body.toString()).toBe("still here");
  });

  it("reports devices, fifos and unknown types as other, without their bodies", async () => {
    const seen = await collect(tgz([
      { name: `${ROOT}dev`, type: "3" },
      { name: `${ROOT}blk`, type: "4" },
      { name: `${ROOT}fifo`, type: "6" },
      { name: `${ROOT}odd`, type: "Z", body: "ignored body" },
      { name: `${ROOT}ok.txt`, body: "ok" },
    ]));
    expect(seen.map((s) => [s.entry.path, s.entry.kind, s.body.length])).toEqual([
      ["dev", "other", 0], ["blk", "other", 0], ["fifo", "other", 0], ["odd", "other", 0], ["ok.txt", "file", 2],
    ]);
  });

  it("treats types 7 and NUL as files", async () => {
    const seen = await collect(tgz([
      { name: `${ROOT}contig`, type: "7", body: "seven" },
      { name: `${ROOT}old`, type: "\0", body: "nul" },
    ]));
    expect(seen.map((s) => [s.entry.kind, s.body.toString()])).toEqual([["file", "seven"], ["file", "nul"]]);
  });

  it("keeps hostile paths visible for the caller to refuse instead of hiding them", async () => {
    const seen = await collect(tgz([
      { name: "../escape.txt", body: "x" },
      { name: `${ROOT}../../up.txt`, body: "x" },
      { name: "/etc/cron.d/evil", body: "x" },
      { name: "PaxHeaders/x", type: "x", body: paxRecord("path", "/abs/pax") },
      { name: `${ROOT}placeholder`, body: "x" },
    ]));
    expect(seen.map((s) => s.entry.path)).toEqual(["../escape.txt", "../../up.txt", "/etc/cron.d/evil", "/abs/pax"]);
  });

  it("drops the archive's top folder entry itself", async () => {
    const seen = await collect(tgz([dir(ROOT), { name: `${ROOT}a`, body: "a" }]));
    expect(seen.map((s) => s.entry.path)).toEqual(["a"]);
  });

  it("rejects a corrupted checksum with TarInvalidError", async () => {
    const archive = tgz([{ name: `${ROOT}a.txt`, body: "a", mutate: (h) => { h[0] ^= 1; } }]);
    await expect(collect(archive)).rejects.toBeInstanceOf(TarInvalidError);
  });

  it("rejects a non-octal size with TarInvalidError", async () => {
    const archive = tgz([{
      name: `${ROOT}a.txt`, body: "a",
      mutate: (h) => { h.write("0000000009x\0", 124, "latin1"); setChecksum(h); },
    }]);
    await expect(collect(archive)).rejects.toBeInstanceOf(TarInvalidError);
  });

  it("rejects a stream over maxCompressedBytes with TarLimitError", async () => {
    const noise = randomBytes(8192);
    const archive = tgz([{ name: `${ROOT}big.bin`, body: noise }]);
    expect(archive.length).toBeGreaterThan(1024);
    const err = await collect(archive, { maxCompressedBytes: 1024, maxEntries: 100 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TarLimitError);
    expect((err as TarLimitError).limit).toBe("compressed");
  });

  it("rejects more than maxEntries entries with TarLimitError", async () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({ name: `${ROOT}f${i}`, body: "x" }));
    const err = await collect(tgz(entries), { ...OPTS, maxEntries: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TarLimitError);
    expect((err as TarLimitError).limit).toBe("entries");
  });

  it("reads a 5 MB file as a stream of bounded chunks", async () => {
    const size = 5 * 1024 * 1024;
    const big = Buffer.alloc(size);
    for (let i = 0; i < size; i += 4096) big[i] = i % 256;
    const archive = tgz([{ name: `${ROOT}big.bin`, body: big }, { name: `${ROOT}tail`, body: "t" }]);
    let chunks = 0;
    let largest = 0;
    let total = 0;
    let check = 0;
    const paths: string[] = [];
    await readTarGz(Readable.from([archive]), async (entry, body) => {
      paths.push(entry.path);
      for await (const c of body) {
        const buf = c as Buffer;
        chunks += 1;
        largest = Math.max(largest, buf.length);
        if (entry.path === "big.bin") {
          for (let i = 0; i < buf.length; i += 1) check = (check + buf[i] * ((total + i) % 13 + 1)) % 1_000_000_007;
          total += buf.length;
        }
      }
    }, OPTS);
    let expected = 0;
    for (let i = 0; i < size; i += 1) expected = (expected + big[i] * (i % 13 + 1)) % 1_000_000_007;
    expect(paths).toEqual(["big.bin", "tail"]);
    expect(total).toBe(size);
    expect(check).toBe(expected);
    expect(chunks).toBeGreaterThan(10);
    expect(largest).toBeLessThanOrEqual(256 * 1024);
  });

  describe("hostile and broken archives", () => {
    it("rejects input that is not gzip", async () => {
      await expect(collect(Buffer.from("this is not a gzip stream at all"))).rejects.toBeInstanceOf(TarInvalidError);
    });

    it("rejects gzip that holds garbage instead of tar", async () => {
      const garbage = Buffer.alloc(2048);
      for (let i = 0; i < garbage.length; i += 1) garbage[i] = (i * 31 + 7) % 256;
      await expect(collect(gzipSync(garbage))).rejects.toBeInstanceOf(TarInvalidError);
    });

    it("rejects a gzip stream cut short", async () => {
      const archive = tgz([{ name: `${ROOT}a.txt`, body: "a".repeat(5000) }]);
      await expect(collect(archive.subarray(0, archive.length - 20))).rejects.toBeInstanceOf(TarInvalidError);
    });

    it("rejects a tar cut off in the middle of a body", async () => {
      const raw = tar([{ name: `${ROOT}a.txt`, body: "a".repeat(5000) }], { end: false });
      await expect(collect(gzipSync(raw.subarray(0, 512 + 1000)))).rejects.toBeInstanceOf(TarInvalidError);
    });

    it("rejects a tar cut off in the middle of a header", async () => {
      const raw = tar([{ name: `${ROOT}a.txt`, body: "a" }, { name: `${ROOT}b.txt`, body: "b" }], { end: false });
      await expect(collect(gzipSync(raw.subarray(0, 1024 + 100)))).rejects.toBeInstanceOf(TarInvalidError);
    });

    it("rejects a tar without its end marker", async () => {
      await expect(collect(tgz([{ name: `${ROOT}a.txt`, body: "a" }], { end: false }))).rejects.toBeInstanceOf(TarInvalidError);
    });

    it("rejects an empty stream", async () => {
      await expect(collect(Readable.from([]))).rejects.toBeInstanceOf(TarInvalidError);
    });

    it("refuses a file whose declared size is over the per-file limit before reading it", async () => {
      let called = 0;
      const archive = tgz([{ name: `${ROOT}a.txt`, body: "a".repeat(100) }]);
      const err = await readTarGz(Readable.from([archive]), async (_e, body) => { called += 1; body.resume(); },
        { ...OPTS, maxEntryBytes: 99 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TarLimitError);
      expect((err as TarLimitError).limit).toBe("file_bytes");
      expect(called).toBe(0);
    });

    it("refuses a huge size written in base-256 without decompressing it", async () => {
      const archive = tgz([{
        name: `${ROOT}bomb`, type: "Z",
        mutate: (h) => { h.fill(0, 124, 136); h[124] = 0x80; h[131] = 0x7f; setChecksum(h); },
      }]);
      const err = await collect(archive).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TarLimitError);
      expect((err as TarLimitError).limit).toBe("file_bytes");
    });

    it("refuses archives over the total byte limit", async () => {
      const entries = Array.from({ length: 4 }, (_, i) => ({ name: `${ROOT}f${i}`, body: "x".repeat(400) }));
      const err = await collect(tgz(entries), { ...OPTS, maxTotalBytes: 1000 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TarLimitError);
      expect((err as TarLimitError).limit).toBe("bytes");
    });

    it("refuses an oversized pax header", async () => {
      const archive = tgz([
        { name: "PaxHeaders/x", type: "x", body: paxRecord("comment", "c".repeat(70 * 1024)) },
        { name: `${ROOT}a`, body: "a" },
      ]);
      const err = await collect(archive).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TarLimitError);
      expect((err as TarLimitError).limit).toBe("header");
    });

    it("refuses a path longer than the path limit", async () => {
      const archive = tgz([
        { name: "././@LongLink", type: "L", body: `${ROOT}${"p".repeat(5000)}\0` },
        { name: `${ROOT}a`, body: "a" },
      ]);
      const err = await collect(archive).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TarLimitError);
      expect((err as TarLimitError).limit).toBe("path");
    });

    it("rejects malformed pax records", async () => {
      for (const body of ["5 path=abc\n", "zz path=a\n", "12 pathabc\n\n", "12 path=a\0b\n"]) {
        const archive = tgz([{ name: "PaxHeaders/x", type: "x", body }, { name: `${ROOT}a`, body: "a" }]);
        await expect(collect(archive), body).rejects.toBeInstanceOf(TarInvalidError);
      }
    });

    it("rejects a pax size that is not a plain number", async () => {
      const archive = tgz([{ name: "PaxHeaders/x", type: "x", body: paxRecord("size", "-1") }, { name: `${ROOT}a`, body: "a" }]);
      await expect(collect(archive)).rejects.toBeInstanceOf(TarInvalidError);
    });

    it("rejects an endless run of metadata headers", async () => {
      const metas = Array.from({ length: 20 }, () => ({ name: "PaxHeaders/x", type: "x", body: paxRecord("comment", "c") }));
      await expect(collect(tgz([...metas, { name: `${ROOT}a`, body: "a" }]))).rejects.toBeInstanceOf(TarInvalidError);
    });

    it("applies a pax path to the next entry only", async () => {
      const seen = await collect(tgz([
        { name: "PaxHeaders/x", type: "x", body: paxRecord("path", `${ROOT}renamed`) },
        { name: `${ROOT}first`, body: "1" },
        { name: `${ROOT}second`, body: "2" },
      ]));
      expect(seen.map((s) => s.entry.path)).toEqual(["renamed", "second"]);
    });

    it("rejects a long trailer of data after the end marker", async () => {
      const archive = gzipSync(Buffer.concat([tar([{ name: `${ROOT}a`, body: "a" }]), Buffer.alloc(2 * 1024 * 1024, 1)]));
      await expect(collect(archive)).rejects.toBeInstanceOf(TarInvalidError);
    });

    it("accepts the usual zero padding after the end marker", async () => {
      const archive = gzipSync(Buffer.concat([tar([{ name: `${ROOT}a`, body: "a" }]), Buffer.alloc(9216)]));
      expect((await collect(archive)).map((s) => s.entry.path)).toEqual(["a"]);
    });
  });

  describe("the entry callback", () => {
    it("passes on the callback's error and destroys the input", async () => {
      const input = Readable.from([tgz([{ name: `${ROOT}a`, body: "a" }, { name: `${ROOT}b`, body: "b" }])]);
      const boom = new Error("refused by staging");
      await expect(readTarGz(input, async (_e, body) => { body.destroy(); throw boom; }, OPTS)).rejects.toBe(boom);
      expect(input.destroyed).toBe(true);
    });

    it("passes on an error thrown before the body is touched, even for a large body", async () => {
      const big = Buffer.alloc(3 * 1024 * 1024, 7);
      const boom = new Error("early");
      await expect(readTarGz(Readable.from([tgz([{ name: `${ROOT}a`, body: big }])]), async () => { throw boom; }, OPTS))
        .rejects.toBe(boom);
    });

    it("moves on when the callback leaves a large body unread", async () => {
      const big = Buffer.alloc(3 * 1024 * 1024, 7);
      const paths: string[] = [];
      await readTarGz(Readable.from([tgz([{ name: `${ROOT}a`, body: big }, { name: `${ROOT}b`, body: "b" }])]),
        async (e) => { paths.push(e.path); }, OPTS);
      expect(paths).toEqual(["a", "b"]);
    });

    it("moves on when the callback destroys the body part-way", async () => {
      const big = Buffer.alloc(3 * 1024 * 1024, 7);
      const seen: string[] = [];
      await readTarGz(Readable.from([tgz([{ name: `${ROOT}a`, body: big }, { name: `${ROOT}b`, body: "b" }])]),
        async (e, body) => {
          if (e.path === "a") {
            await new Promise<void>((resolve) => body.once("data", () => { body.destroy(); resolve(); }));
          } else {
            seen.push((await readAll(body)).toString());
          }
        }, OPTS);
      expect(seen).toEqual(["b"]);
    });

    it("waits for each callback before reading the next entry", async () => {
      const order: string[] = [];
      await readTarGz(Readable.from([tgz([{ name: `${ROOT}a`, body: "a" }, { name: `${ROOT}b`, body: "b" }])]),
        async (e, body) => {
          order.push(`start ${e.path}`);
          await readAll(body);
          await new Promise((r) => setTimeout(r, 5));
          order.push(`end ${e.path}`);
        }, OPTS);
      expect(order).toEqual(["start a", "end a", "start b", "end b"]);
    });
  });
});
