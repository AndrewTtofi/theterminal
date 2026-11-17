import { describe, expect, it } from "vitest";
import { createPreviewHost } from "../../src/server/preview-host.js";
import { createFolderPicker } from "../../src/server/folder-picker.js";
import type { PreviewDeviceView } from "../../src/host.js";

function fakeIo() {
  const sent: unknown[] = [];
  const listeners: ((m: unknown) => void)[] = [];
  return {
    sent,
    io: {
      send: (m: unknown) => void sent.push(m),
      on: (l: (m: unknown) => void) => void listeners.push(l),
    },
    answer: (m: unknown) => listeners.forEach((l) => l(m)),
  };
}

const ids = (prefix = "h") => {
  let n = 0;
  return () => `${prefix}${++n}`;
};

const IPHONE: PreviewDeviceView = {
  device: "iphone16",
  x: 10,
  y: 20,
  width: 196.5,
  height: 426,
  viewport: { width: 393, height: 852 },
  scale: 3,
  mobile: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
};
const LAPTOP: PreviewDeviceView = {
  device: "laptop",
  x: 300,
  y: 20,
  width: 720,
  height: 450,
  viewport: { width: 1440, height: 900 },
  scale: 2,
  mobile: false,
  userAgent: null,
};

const SHOW = { previewId: "p1", origin: "http://127.0.0.1:5173", action: "show" as const, views: [IPHONE, LAPTOP] };

const png = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, n]);
const MAX_B64 = Math.ceil(16_777_216 / 3) * 4;

describe("createPreviewHost views", () => {
  it("sends preview_views with a fresh id and resolves true on the matching done", async () => {
    const f = fakeIo();
    const host = createPreviewHost(f.io, { newId: ids() });
    const p = host.views(SHOW);
    expect(f.sent).toEqual([{ type: "preview_views", id: "h1", ...SHOW }]);
    f.answer({ type: "preview_views_done", id: "h1", ok: true });
    await expect(p).resolves.toBe(true);
    const q = host.views({ ...SHOW, action: "hide" });
    expect((f.sent[1] as { id: string }).id).toBe("h2");
    f.answer({ type: "preview_views_done", id: "h2", ok: false });
    await expect(q).resolves.toBe(false);
  });

  it("ignores an answer with another id and resolves false after the timeout", async () => {
    const f = fakeIo();
    const host = createPreviewHost(f.io, { newId: ids(), viewsTimeoutMs: 10 });
    const p = host.views(SHOW);
    f.answer({ type: "preview_views_done", id: "other", ok: true });
    f.answer({ type: "preview_captured", id: "h1", shots: [] });
    f.answer(null);
    f.answer("preview_views_done");
    await expect(p).resolves.toBe(false);
  });

  it("treats an ok that is not exactly true as false", async () => {
    for (const ok of ["true", 1, null, undefined]) {
      const f = fakeIo();
      const host = createPreviewHost(f.io, { newId: ids() });
      const p = host.views(SHOW);
      f.answer({ type: "preview_views_done", id: "h1", ok });
      await expect(p).resolves.toBe(false);
    }
  });

  it("runs calls side by side, each settled by its own id", async () => {
    const f = fakeIo();
    const host = createPreviewHost(f.io, { newId: ids() });
    const a = host.views(SHOW);
    const b = host.views({ ...SHOW, action: "reload" });
    f.answer({ type: "preview_views_done", id: "h2", ok: true });
    f.answer({ type: "preview_views_done", id: "h1", ok: false });
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(true);
  });

  it("resolves false when sending throws", async () => {
    const host = createPreviewHost(
      {
        send: () => {
          throw new Error("channel closed");
        },
        on: () => {},
      },
      { newId: ids() },
    );
    await expect(host.views(SHOW)).resolves.toBe(false);
  });

  it("refuses to send an invalid request and resolves false", async () => {
    const bad = [
      { ...SHOW, previewId: "../p1" },
      { ...SHOW, previewId: "" },
      { ...SHOW, origin: "http://example.com" },
      { ...SHOW, origin: "http://localhost:5173" },
      { ...SHOW, origin: "http://127.0.0.1:0" },
      { ...SHOW, origin: "http://127.0.0.1:70000" },
      { ...SHOW, origin: "https://127.0.0.1:5173" },
      { ...SHOW, origin: "http://127.0.0.1:5173/" },
      { ...SHOW, action: "open" },
      { ...SHOW, views: [IPHONE, LAPTOP, IPHONE, LAPTOP, IPHONE] },
      { ...SHOW, views: [{ ...IPHONE, x: Number.NaN }] },
      { ...SHOW, views: [{ ...IPHONE, width: 20_001 }] },
      { ...SHOW, views: [{ ...IPHONE, y: -1 }] },
      { ...SHOW, views: [{ ...IPHONE, scale: 0 }] },
      { ...SHOW, views: [{ ...IPHONE, scale: 11 }] },
      { ...SHOW, views: [{ ...IPHONE, viewport: { width: Infinity, height: 852 } }] },
      { ...SHOW, views: [{ ...IPHONE, device: "iphone 16" }] },
      { ...SHOW, views: [{ ...IPHONE, mobile: "yes" }] },
      { ...SHOW, views: [{ ...IPHONE, userAgent: "a\nb" }] },
      { ...SHOW, views: [{ ...IPHONE, userAgent: "a".repeat(1025) }] },
      { ...SHOW, views: [{ ...IPHONE, extra: 1 }] },
    ];
    for (const m of bad) {
      const f = fakeIo();
      const host = createPreviewHost(f.io, { newId: ids() });
      await expect(host.views(m as never)).resolves.toBe(false);
      expect(f.sent).toEqual([]);
    }
  });

  it("accepts an IPv6 loopback origin", async () => {
    const f = fakeIo();
    const host = createPreviewHost(f.io, { newId: ids() });
    const p = host.views({ ...SHOW, origin: "http://[::1]:3000", action: "close", views: [] });
    expect(f.sent).toHaveLength(1);
    f.answer({ type: "preview_views_done", id: "h1", ok: true });
    await expect(p).resolves.toBe(true);
  });
});

describe("createPreviewHost capture", () => {
  it("sends preview_capture and resolves the decoded buffers", async () => {
    const f = fakeIo();
    const host = createPreviewHost(f.io, { newId: ids() });
    const p = host.capture("p1");
    expect(f.sent).toEqual([{ type: "preview_capture", id: "h1", previewId: "p1" }]);
    f.answer({
      type: "preview_captured",
      id: "h1",
      shots: [
        { device: "iphone16", png: png(1).toString("base64") },
        { device: "laptop", png: png(2).toString("base64") },
      ],
    });
    await expect(p).resolves.toEqual([
      { device: "iphone16", png: png(1) },
      { device: "laptop", png: png(2) },
    ]);
  });

  it("drops a fifth shot and an oversized base64 string", async () => {
    const f = fakeIo();
    const host = createPreviewHost(f.io, { newId: ids() });
    const p = host.capture("p1");
    const big = "A".repeat(MAX_B64 + 4);
    f.answer({
      type: "preview_captured",
      id: "h1",
      shots: [
        { device: "d1", png: png(1).toString("base64") },
        { device: "d2", png: big },
        { device: "d3", png: png(3).toString("base64") },
        { device: "d4", png: png(4).toString("base64") },
        { device: "d5", png: png(5).toString("base64") },
      ],
    });
    const shots = await p;
    expect(shots.map((s) => s.device)).toEqual(["d1", "d3", "d4"]);
  });

  it("drops shots that are not valid base64 or have a bad device", async () => {
    const f = fakeIo();
    const host = createPreviewHost(f.io, { newId: ids() });
    const p = host.capture("p1");
    f.answer({
      type: "preview_captured",
      id: "h1",
      shots: [
        { device: "ok", png: png(1).toString("base64") },
        { device: "bad", png: "not base64!" },
        { device: "empty", png: "" },
        { device: "../x", png: png(2).toString("base64") },
        { device: "num", png: 42 },
        null,
      ],
    });
    await expect(p).resolves.toEqual([{ device: "ok", png: png(1) }]);
  });

  it("resolves [] for an answer whose shots are not a list, on timeout, and for an invalid preview id", async () => {
    const f = fakeIo();
    const host = createPreviewHost(f.io, { newId: ids() });
    const p = host.capture("p1");
    f.answer({ type: "preview_captured", id: "h1", shots: "nope" });
    await expect(p).resolves.toEqual([]);

    const g = fakeIo();
    const slow = createPreviewHost(g.io, { newId: ids(), captureTimeoutMs: 10 });
    const q = slow.capture("p1");
    g.answer({ type: "preview_captured", id: "other", shots: [] });
    await expect(q).resolves.toEqual([]);

    const h = fakeIo();
    const strict = createPreviewHost(h.io, { newId: ids() });
    await expect(strict.capture("p 1")).resolves.toEqual([]);
    expect(h.sent).toEqual([]);
  });
});

describe("the folder picker and the preview host on one io", () => {
  it("do not consume each other's answers", async () => {
    const f = fakeIo();
    // Both use the same id on purpose: only the message type tells their answers apart.
    const pick = createFolderPicker(f.io, { newId: () => "same" });
    const host = createPreviewHost(f.io, { newId: () => "same" });
    const picked = pick();
    const viewed = host.views(SHOW);
    f.answer({ type: "preview_views_done", id: "same", ok: true });
    await expect(viewed).resolves.toBe(true);
    const captured = host.capture("p1");
    f.answer({ type: "picked_folder", id: "same", path: null });
    await expect(picked).resolves.toBeNull();
    f.answer({ type: "preview_captured", id: "same", shots: [{ device: "laptop", png: png(7).toString("base64") }] });
    await expect(captured).resolves.toEqual([{ device: "laptop", png: png(7) }]);
  });
});
