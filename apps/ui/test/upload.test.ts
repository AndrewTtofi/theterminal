import { afterEach, describe, expect, it, vi } from "vitest";
import { IMPORT_LIMITS } from "@theterminal/shared";
import { ApiError, api } from "../src/api";
import { collectDropped, filesFromInput, precheck, uploadFiles } from "../src/upload";
import type { PickedFile } from "../src/upload";

afterEach(() => vi.restoreAllMocks());

const picked = (path: string, size = 3): PickedFile => ({ path, file: new File(["x".repeat(size)], path.split("/").pop()!) });
const LIMIT = "That is more than The Terminal takes at once: up to 2,000 files, 200 MB in total and 50 MB per file.";

describe("precheck", () => {
  it("names a possible secret unless it is ticked", () => {
    const r = precheck([picked("readme.md"), picked(".env")], false);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain(".env");
    expect(!r.ok && r.secrets).toEqual([".env"]);
    expect(precheck([picked("readme.md"), picked(".env")], true)).toEqual({ ok: true });
  });

  it("gives the limit sentence for more than 2,000 files", () => {
    const many = Array.from({ length: IMPORT_LIMITS.files + 1 }, (_, i) => picked(`f${i}.txt`, 1));
    expect(precheck(many, false)).toEqual({ ok: false, message: LIMIT });
  });

  it("gives the limit sentence for a file over 50 MB, by size alone", () => {
    const big = { path: "big.bin", file: { size: IMPORT_LIMITS.fileBytes + 1 } as File };
    expect(precheck([big], false)).toEqual({ ok: false, message: LIMIT });
  });

  it("refuses a path with a .. segment, naming it", () => {
    const r = precheck([picked("../x")], false);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("../x");
  });

  it("refuses two names that differ only by case", () => {
    const r = precheck([picked("A.txt"), picked("a.txt")], false);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("a.txt");
  });

  it("says when there is nothing to send", () => {
    expect(precheck([], false)).toEqual({ ok: false, message: "Choose at least one file." });
  });
});

describe("filesFromInput", () => {
  it("keeps a folder's relative paths, else the file's name", () => {
    const a = new File(["a"], "a.ts");
    Object.defineProperty(a, "webkitRelativePath", { value: "proj/src/a.ts" });
    const b = new File(["b"], "b.txt");
    const list = Object.assign([a, b], { item: (i: number) => [a, b][i] ?? null }) as unknown as FileList;
    expect(filesFromInput(list).map((p) => p.path)).toEqual(["proj/src/a.ts", "b.txt"]);
  });
});

describe("collectDropped", () => {
  it("walks dropped folders, keeping relative paths", async () => {
    const file = (name: string) => ({ isFile: true, isDirectory: false, name, file: (ok: (f: File) => void) => ok(new File([name], name)) });
    const dir = (name: string, children: unknown[]) => {
      let given = false;
      return {
        isFile: false, isDirectory: true, name,
        createReader: () => ({ readEntries: (ok: (e: unknown[]) => void) => { ok(given ? [] : children); given = true; } }),
      };
    };
    const root = dir("proj", [file("readme.md"), dir("src", [file("a.ts")])]);
    const items = [
      { kind: "file", webkitGetAsEntry: () => root, getAsFile: () => null },
      { kind: "file", webkitGetAsEntry: () => file("loose.txt"), getAsFile: () => null },
      { kind: "string", webkitGetAsEntry: () => null, getAsFile: () => null },
    ];
    const list = Object.assign(items, { length: items.length }) as unknown as DataTransferItemList;
    const got = await collectDropped(list);
    expect(got.map((p) => p.path).sort()).toEqual(["loose.txt", "proj/readme.md", "proj/src/a.ts"]);
  });

  it("falls back to the plain file when entries are not available", async () => {
    const f = new File(["x"], "x.txt");
    const list = Object.assign([{ kind: "file", getAsFile: () => f }], { length: 1 }) as unknown as DataTransferItemList;
    expect((await collectDropped(list)).map((p) => p.path)).toEqual(["x.txt"]);
  });
});

describe("uploadFiles", () => {
  const files = [picked("a.txt", 2), picked("src/b.txt", 5)];
  const result = { commit: "c".repeat(40), files: 2, bytes: 7, skipped: [], skippedCount: 0 };

  it("opens, sends each file in order, then commits", async () => {
    const calls: string[] = [];
    vi.spyOn(api, "openUpload").mockImplementation(async (id, i) => {
      calls.push(`open ${id} ${i.files} ${i.bytes} ${i.includeSecrets}`);
      return { uploadId: "u1" };
    });
    vi.spyOn(api, "putUploadFile").mockImplementation(async (u, p) => void calls.push(`put ${u} ${p}`));
    vi.spyOn(api, "commitUpload").mockImplementation(async (u) => {
      calls.push(`commit ${u}`);
      return result;
    });
    const cancel = vi.spyOn(api, "cancelUpload").mockResolvedValue(undefined);
    const progress: [number, number][] = [];
    const r = await uploadFiles("p1", files, false, (s, t) => progress.push([s, t]), new AbortController().signal);
    expect(r).toEqual(result);
    expect(calls).toEqual(["open p1 2 7 false", "put u1 a.txt", "put u1 src/b.txt", "commit u1"]);
    expect(progress).toEqual([[0, 2], [1, 2], [2, 2]]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels the upload when a file is refused, and passes the error on", async () => {
    vi.spyOn(api, "openUpload").mockResolvedValue({ uploadId: "u1" });
    vi.spyOn(api, "putUploadFile").mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ApiError(413, "limit_exceeded"));
    const commit = vi.spyOn(api, "commitUpload");
    const cancel = vi.spyOn(api, "cancelUpload").mockResolvedValue(undefined);
    await expect(uploadFiles("p1", files, false, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(cancel).toHaveBeenCalledWith("u1");
    expect(commit).not.toHaveBeenCalled();
  });

  it("stops between files when aborted, and cancels the upload", async () => {
    const ctl = new AbortController();
    vi.spyOn(api, "openUpload").mockResolvedValue({ uploadId: "u1" });
    const put = vi.spyOn(api, "putUploadFile").mockImplementation(async () => ctl.abort());
    const commit = vi.spyOn(api, "commitUpload");
    const cancel = vi.spyOn(api, "cancelUpload").mockResolvedValue(undefined);
    await expect(uploadFiles("p1", files, false, () => {}, ctl.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(put).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("u1");
  });
});
