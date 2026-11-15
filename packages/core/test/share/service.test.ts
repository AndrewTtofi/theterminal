import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SHARE_OPTIONS, SHARE_SECTIONS, type ShareOptions } from "@theterminal/shared";
import { NotFoundError } from "../../src/board/board-service.js";
import { HumanRequiredError } from "../../src/intake/service.js";
import { LedgerReadOnlyError } from "../../src/ledger/ledger.js";
import { ShareNotCleanError, shareCleaner, type ShareClean } from "../../src/share/clean.js";
import { buildSnapshot } from "../../src/share/snapshot.js";
import {
  MAX_PREVIEWS, MAX_SHARE_BYTES, PREVIEW_TTL_MS, PreviewNotFoundError, PreviewStaleError, ShareService, ShareTooLargeError,
  SnapshotMissingError, SnapshotTamperedError, type ShareServiceDeps,
} from "../../src/share/service.js";
import { NOON, emit, human, startRun, world, type World } from "./setup.js";

const SECRET = "zq-TESTKEY-service-opaque-0000000000";
const SLIPPED = "sk-ant-TESTKEY-0000000000";
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

let w: World;
let projectId: string;
let dataDir: string;
let clock: Date;
let clean: ShareClean;

beforeEach(() => {
  w = world();
  dataDir = mkdtempSync(join(tmpdir(), "tt-share-service-"));
  clock = NOON;
  clean = shareCleaner({ dataDir, secrets: () => [SECRET], username: "clubuser", home: join(dataDir, "no-home") });
  projectId = w.board.createProject(human, { name: "Book Club", pitch: "Reading lists for a club" }).id;
  const card = w.board.addCard(human, projectId, { title: "Login", stage: "build" }).id;
  // A finished fake run whose prompt and output hold the stored secret.
  startRun(w, projectId, "r1", "fake", card, `use ${SECRET} to log in`);
  emit(w, projectId, "agent.action.requested", { runId: "r1", actionId: "a1", kind: "shell", tool: "Bash", summary: "env", input: { command: "env" } });
  emit(w, projectId, "agent.action.decided", { runId: "r1", actionId: "a1", decision: "allow", by: "human", reason: "" }, human);
  emit(w, projectId, "agent.action.completed", { runId: "r1", actionId: "a1", ok: true, output: SECRET });
  emit(w, projectId, "agent.finished", { runId: "r1", status: "completed", costUsd: 0.1, error: null });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function service(over: Partial<ShareServiceDeps> = {}, buildClean: ShareClean = clean): ShareService {
  let n = 0;
  return new ShareService({
    db: w.db,
    ledger: w.ledger,
    dataDir,
    clean,
    build: (id, o) =>
      buildSnapshot(
        {
          db: w.db, ledger: w.ledger, integrity: () => w.ledger.verify(), gates: w.gates, connections: () => w.connections.list(),
          ci: async () => null, hardware: () => null, clean: buildClean, now: () => clock,
        },
        id,
        o,
      ),
    newId: () => `share${++n}`,
    now: () => clock,
    ...over,
  });
}

const shareDir = () => join(dataDir, "projects", projectId, "share");
const withPrompts: ShareOptions = { ...DEFAULT_SHARE_OPTIONS, includePrompts: true };

describe("ShareService.preview", () => {
  it("renders a cleaned page, hashed and sized, that never holds the stored secret", async () => {
    const s = service();
    const p = await s.preview(projectId, withPrompts);
    expect(p.bytes).toBeGreaterThan(0);
    expect(p.bytes).toBe(Buffer.byteLength(p.html, "utf8"));
    expect(p.contentHash).toBe(sha256(p.html));
    expect(p.html).not.toContain(SECRET);
    expect(JSON.stringify(p.snapshot)).not.toContain(SECRET);
    expect(p.projectId).toBe(projectId);
    expect(p.snapshot.options).toEqual(withPrompts);
    expect(p.expiresAt).toBe(new Date(NOON.getTime() + PREVIEW_TTL_MS).toISOString());
    const again = await s.preview(projectId, withPrompts);
    expect(again.previewId).not.toBe(p.previewId);
  });

  it("refuses a page that is not clean and holds nothing", async () => {
    w.db.prepare("UPDATE projects SET pitch = ? WHERE id = ?").run(`key ${SLIPPED}`, projectId);
    const s = service({}, (x) => x); // the build does not clean; the service's own last check must catch it
    await expect(s.preview(projectId, DEFAULT_SHARE_OPTIONS)).rejects.toBeInstanceOf(ShareNotCleanError);
    expect(s.size()).toBe(0);
  });

  it("refuses a page over the size limit and holds nothing", async () => {
    const s = service({ render: () => "x".repeat(9 * 1024 * 1024) });
    expect(9 * 1024 * 1024).toBeGreaterThan(MAX_SHARE_BYTES);
    await expect(s.preview(projectId, DEFAULT_SHARE_OPTIONS)).rejects.toBeInstanceOf(ShareTooLargeError);
    expect(s.size()).toBe(0);
  });

  it("keeps at most MAX_PREVIEWS, evicting the oldest", async () => {
    const s = service();
    const first = await s.preview(projectId, DEFAULT_SHARE_OPTIONS);
    for (let i = 0; i < MAX_PREVIEWS; i++) await s.preview(projectId, DEFAULT_SHARE_OPTIONS);
    expect(s.size()).toBe(MAX_PREVIEWS);
    expect(() => s.confirm(human, projectId, first.previewId, first.contentHash)).toThrow(PreviewNotFoundError);
  });

  it("drops expired previews on every call", async () => {
    const s = service();
    await s.preview(projectId, DEFAULT_SHARE_OPTIONS);
    clock = new Date(NOON.getTime() + PREVIEW_TTL_MS + 1);
    await s.preview(projectId, DEFAULT_SHARE_OPTIONS);
    expect(s.size()).toBe(1);
  });

  it("works on a read-only ledger", async () => {
    w.ledger.readOnly = true;
    const p = await service().preview(projectId, DEFAULT_SHARE_OPTIONS);
    expect(p.bytes).toBeGreaterThan(0);
  });

  it("an unknown project is not found", async () => {
    await expect(service().preview("nope", DEFAULT_SHARE_OPTIONS)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("ShareService.confirm", () => {
  it("writes the exact previewed bytes, owner-only, and records one share.confirmed with their hash", async () => {
    const s = service();
    const p = await s.preview(projectId, withPrompts);
    const head = w.ledger.headSeq();
    const record = s.confirm(human, projectId, p.previewId, p.contentHash);

    const file = join(shareDir(), `${p.previewId}.html`);
    expect(s.htmlPath(p.previewId)).toBe(file);
    const bytes = readFileSync(file);
    expect(bytes.toString("utf8")).toBe(p.html);
    expect(sha256(bytes)).toBe(p.contentHash);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    expect(w.ledger.headSeq()).toBe(head + 1);
    const [entry] = w.ledger.list({ afterSeq: head });
    expect(entry!.type).toBe("share.confirmed");
    expect(entry!.projectId).toBe(projectId);
    expect(entry!.actor).toEqual(human);
    expect(entry!.payload).toEqual({
      shareId: p.previewId, contentHash: p.contentHash, bytes: p.bytes, sections: [...SHARE_SECTIONS], options: withPrompts, headSeq: head,
    });
    expect(record).toMatchObject({ id: p.previewId, projectId, contentHash: p.contentHash, bytes: p.bytes, options: withPrompts, headSeq: head });
    expect(s.list(projectId)).toEqual([record]);
    // The preview is gone: the same id cannot be saved twice.
    expect(() => s.confirm(human, projectId, p.previewId, p.contentHash)).toThrow(PreviewNotFoundError);
  });

  it("refuses an unknown id, a wrong hash, an expired preview, another project and a non-human, writing and recording nothing", async () => {
    const s = service();
    const p = await s.preview(projectId, DEFAULT_SHARE_OPTIONS);
    const head = w.ledger.headSeq();
    const other = w.board.createProject(human, { name: "Garden" }).id;
    const head2 = w.ledger.headSeq();
    expect(head2).toBe(head + 1);
    const nothing = () => {
      expect(w.ledger.headSeq()).toBe(head2);
      expect(existsSync(shareDir())).toBe(false);
    };

    expect(() => s.confirm(human, projectId, "nope", p.contentHash)).toThrow(PreviewNotFoundError);
    nothing();
    expect(() => s.confirm(human, projectId, p.previewId, "0".repeat(64))).toThrow(PreviewStaleError);
    nothing();
    expect(() => s.confirm(human, other, p.previewId, p.contentHash)).toThrow(PreviewNotFoundError);
    nothing();
    expect(() => s.confirm({ kind: "system", id: "runner" }, projectId, p.previewId, p.contentHash)).toThrow(HumanRequiredError);
    nothing();
    expect(() => s.confirm({ kind: "agent", id: "r1" }, projectId, p.previewId, p.contentHash)).toThrow(HumanRequiredError);
    nothing();
    clock = new Date(NOON.getTime() + 11 * 60_000);
    expect(() => s.confirm(human, projectId, p.previewId, p.contentHash)).toThrow(PreviewStaleError);
    nothing();
  });

  it("on a read-only ledger, refuses before writing anything", async () => {
    const s = service();
    const p = await s.preview(projectId, DEFAULT_SHARE_OPTIONS);
    w.ledger.readOnly = true;
    expect(() => s.confirm(human, projectId, p.previewId, p.contentHash)).toThrow(LedgerReadOnlyError);
    expect(existsSync(shareDir())).toBe(false);
  });

  it("removes the file when the commit fails", async () => {
    const s = service();
    const p = await s.preview(projectId, DEFAULT_SHARE_OPTIONS);
    w.db.exec("CREATE TRIGGER no_share BEFORE INSERT ON share_snapshots BEGIN SELECT RAISE(ABORT, 'refused'); END;");
    const head = w.ledger.headSeq();
    expect(() => s.confirm(human, projectId, p.previewId, p.contentHash)).toThrow(/refused/);
    expect(w.ledger.headSeq()).toBe(head);
    expect(existsSync(join(shareDir(), `${p.previewId}.html`))).toBe(false);
  });
});

describe("ShareService.readHtml", () => {
  async function saved(s: ShareService) {
    const p = await s.preview(projectId, DEFAULT_SHARE_OPTIONS);
    s.confirm(human, projectId, p.previewId, p.contentHash);
    return p;
  }

  it("returns the saved bytes", async () => {
    const s = service();
    const p = await saved(s);
    expect(s.readHtml(p.previewId)).toBe(p.html);
  });

  it("refuses a file that no longer matches the ledger", async () => {
    const s = service();
    const p = await saved(s);
    appendFileSync(s.htmlPath(p.previewId), " ");
    expect(() => s.readHtml(p.previewId)).toThrow(SnapshotTamperedError);
  });

  it("reports a missing file", async () => {
    const s = service();
    const p = await saved(s);
    rmSync(s.htmlPath(p.previewId));
    expect(() => s.readHtml(p.previewId)).toThrow(SnapshotMissingError);
  });

  it("refuses to serve a page that a secret stored since would now redact", async () => {
    const secrets: string[] = [SECRET];
    const live = shareCleaner({ dataDir, secrets: () => secrets, username: "clubuser", home: join(dataDir, "no-home") });
    const s = service({ clean: live });
    const p = await saved(s);
    secrets.push("Reading lists for a club"); // the pitch, now a stored secret
    expect(() => s.readHtml(p.previewId)).toThrow(ShareNotCleanError);
  });

  it("an unknown or malformed id is not found", () => {
    const s = service();
    expect(() => s.readHtml("nope")).toThrow(NotFoundError);
    expect(() => s.readHtml("../../token")).toThrow(NotFoundError);
    expect(() => s.htmlPath("nope")).toThrow(NotFoundError);
  });
});
