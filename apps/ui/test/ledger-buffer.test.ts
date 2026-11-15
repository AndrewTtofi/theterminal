import { afterEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntry } from "@theterminal/shared";
import { LIVE_CAP, appendEntries, batcher, prependEntries } from "../src/ledger-buffer";

const e = (seq: number): LedgerEntry => ({
  seq, id: `e${seq}`, ts: "", projectId: "p1", actor: { kind: "human", id: "owner" }, type: "project.created", payload: {}, prevHash: "", hash: "",
});
const seqs = (list: LedgerEntry[]) => list.map((x) => x.seq);

afterEach(() => vi.useRealTimers());

describe("appendEntries", () => {
  it("appends new entries in seq order and drops ones it already has", () => {
    const r = appendEntries([e(1), e(2)], [e(4), e(2), e(3)], null);
    expect(seqs(r.entries)).toEqual([1, 2, 3, 4]);
    expect(r.trimmed).toBe(false);
  });

  it("keeps only the newest entries over the cap, and says it dropped some", () => {
    expect(LIVE_CAP).toBe(5000);
    const r = appendEntries([e(1), e(2), e(3)], [e(4), e(5)], 3);
    expect(seqs(r.entries)).toEqual([3, 4, 5]);
    expect(r.trimmed).toBe(true);
  });

  it("keeps everything when there is no cap (while paging older entries in)", () => {
    expect(seqs(appendEntries([e(1), e(2), e(3)], [e(4)], null).entries)).toEqual([1, 2, 3, 4]);
  });
});

describe("prependEntries", () => {
  it("puts an older page in front and keeps every live entry", () => {
    expect(seqs(prependEntries([e(1), e(2), e(3)], [e(3), e(4), e(9)]))).toEqual([1, 2, 3, 4, 9]);
  });
});

describe("batcher", () => {
  it("hands over everything pushed within 50 ms in one call", () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const b = batcher<number>(apply);
    b.push(1);
    b.push(2);
    vi.advanceTimersByTime(49);
    expect(apply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(apply).toHaveBeenCalledExactlyOnceWith([1, 2]);
    b.push(3);
    vi.advanceTimersByTime(50);
    expect(apply).toHaveBeenLastCalledWith([3]);
  });

  it("drops what is pending when cancelled", () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const b = batcher<number>(apply);
    b.push(1);
    b.cancel();
    vi.advanceTimersByTime(100);
    expect(apply).not.toHaveBeenCalled();
  });
});
