import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createFolderPicker, PickerBusyError } from "../../src/server/folder-picker.js";

const ABS = resolve("picked-folder");

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

const ids = () => {
  let n = 0;
  return () => `p${++n}`;
};

describe("createFolderPicker", () => {
  it("sends pick_folder and resolves with the host's answer", async () => {
    const f = fakeIo();
    const pick = createFolderPicker(f.io, { newId: ids() });
    const p = pick();
    expect(f.sent).toEqual([{ type: "pick_folder", id: "p1" }]);
    f.answer({ type: "picked_folder", id: "p1", path: ABS });
    await expect(p).resolves.toBe(ABS);
  });

  it("resolves null when the person cancels", async () => {
    const f = fakeIo();
    const pick = createFolderPicker(f.io, { newId: ids() });
    const p = pick();
    f.answer({ type: "picked_folder", id: "p1", path: null });
    await expect(p).resolves.toBeNull();
  });

  it("ignores an answer with another id", async () => {
    const f = fakeIo();
    const pick = createFolderPicker(f.io, { newId: ids(), timeoutMs: 50 });
    const p = pick();
    f.answer({ type: "picked_folder", id: "other", path: ABS });
    f.answer({ type: "shutdown" });
    f.answer(null);
    f.answer("picked_folder");
    await expect(p).resolves.toBeNull();
  });

  it("resolves null for a relative, empty, overlong or non-string path", async () => {
    for (const path of ["relative", "", `${ABS}${"a".repeat(4096)}`, 42, undefined]) {
      const f = fakeIo();
      const pick = createFolderPicker(f.io, { newId: ids() });
      const p = pick();
      f.answer({ type: "picked_folder", id: "p1", path });
      await expect(p).resolves.toBeNull();
    }
  });

  it("rejects a second concurrent pick with PickerBusyError, and allows one after the first ends", async () => {
    const f = fakeIo();
    const pick = createFolderPicker(f.io, { newId: ids() });
    const first = pick();
    await expect(pick()).rejects.toBeInstanceOf(PickerBusyError);
    expect(f.sent).toHaveLength(1);
    f.answer({ type: "picked_folder", id: "p1", path: ABS });
    await first;
    const second = pick();
    expect(f.sent).toEqual([
      { type: "pick_folder", id: "p1" },
      { type: "pick_folder", id: "p2" },
    ]);
    f.answer({ type: "picked_folder", id: "p2", path: null });
    await expect(second).resolves.toBeNull();
  });

  it("resolves null on timeout and ignores a late answer", async () => {
    const f = fakeIo();
    const pick = createFolderPicker(f.io, { newId: ids(), timeoutMs: 10 });
    await expect(pick()).resolves.toBeNull();
    f.answer({ type: "picked_folder", id: "p1", path: ABS });
    const next = pick();
    f.answer({ type: "picked_folder", id: "p2", path: ABS });
    await expect(next).resolves.toBe(ABS);
  });

  it("resolves null when sending to the host throws", async () => {
    const pick = createFolderPicker(
      {
        send: () => {
          throw new Error("channel closed");
        },
        on: () => {},
      },
      { newId: ids() },
    );
    await expect(pick()).resolves.toBeNull();
    await expect(pick()).resolves.toBeNull();
  });
});
