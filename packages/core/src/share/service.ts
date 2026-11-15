import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SHARE_SECTIONS, type Actor, type ShareOptions, type ShareSnapshot, type ShareSnapshotRecord } from "@theterminal/shared";
import { NotFoundError } from "../board/board-service.js";
import type { Db } from "../db.js";
import { commitEvent } from "../events/commit.js";
import { getShareSnapshot, listShareSnapshots } from "../events/projections.js";
import { HumanRequiredError } from "../intake/service.js";
import { LedgerReadOnlyError, type Ledger } from "../ledger/ledger.js";
import { assertClean, type ShareClean } from "./clean.js";
import {
  PreviewNotFoundError, PreviewStaleError, ShareTooLargeError, SnapshotMissingError, SnapshotTamperedError,
} from "./errors.js";
import { renderShareHtml } from "./render.js";

export { PreviewNotFoundError, PreviewStaleError, ShareTooLargeError, SnapshotMissingError, SnapshotTamperedError };

/** How long a preview can be confirmed after it was made. */
export const PREVIEW_TTL_MS = 600_000;
/** The largest share page, in UTF-8 bytes. */
export const MAX_SHARE_BYTES = 8 * 1024 * 1024;
/** The most previews held at once; the oldest goes first. */
export const MAX_PREVIEWS = 20;

export type Preview = {
  previewId: string;
  projectId: string;
  contentHash: string;
  bytes: number;
  html: string;
  snapshot: ShareSnapshot;
  expiresAt: string;
};

export type ShareServiceDeps = {
  db: Db;
  ledger: Ledger;
  dataDir: string;
  build: (projectId: string, options: ShareOptions) => Promise<ShareSnapshot>;
  render?: (s: ShareSnapshot) => string;
  clean: ShareClean;
  newId?: () => string;
  now?: () => Date;
};

/** A held preview: the exact bytes that were hashed, so a confirm writes nothing else. */
type Held = Preview & { buf: Buffer; options: ShareOptions; expiresMs: number };

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/**
 * Share pages: generated for the Owner to read (held in memory, never written), then confirmed by a human, which
 * writes exactly the previewed bytes to `<dataDir>/projects/<projectId>/share/<shareId>.html` and records their
 * sha256 in a `share.confirmed` entry. A saved page is served only while its bytes still match that hash and still
 * pass the cleaner.
 */
export class ShareService {
  private readonly previews = new Map<string, Held>();
  private readonly render: (s: ShareSnapshot) => string;
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(private readonly deps: ShareServiceDeps) {
    this.render = deps.render ?? renderShareHtml;
    this.newId = deps.newId ?? (() => randomUUID());
    this.now = deps.now ?? (() => new Date());
  }

  /** The number of previews held right now. */
  size(): number {
    this.dropExpired();
    return this.previews.size;
  }

  /**
   * Builds, renders and checks a page: refused when it is over MAX_SHARE_BYTES or when cleaning it again would change
   * it (ShareNotCleanError). Nothing is held when it is refused. Works on a read-only ledger: it records nothing.
   */
  async preview(projectId: string, options: ShareOptions): Promise<Preview> {
    this.dropExpired();
    const snapshot = await this.deps.build(projectId, options);
    // The bytes are fixed once: the hash, the size, the page shown and the file written all come from this buffer.
    const buf = Buffer.from(this.render(snapshot), "utf8");
    if (buf.length > MAX_SHARE_BYTES) throw new ShareTooLargeError();
    const html = buf.toString("utf8");
    assertClean(html, this.deps.clean);

    const previewId = this.newId();
    if (!ID.test(previewId)) throw new Error("invalid preview id");
    const expiresMs = this.now().getTime() + PREVIEW_TTL_MS;
    const held: Held = {
      previewId, projectId, contentHash: sha256(buf), bytes: buf.length, html, snapshot,
      expiresAt: new Date(expiresMs).toISOString(), buf, options: { ...snapshot.options }, expiresMs,
    };
    this.previews.set(previewId, held);
    while (this.previews.size > MAX_PREVIEWS) this.previews.delete(this.previews.keys().next().value!);
    const { buf: _buf, options: _options, expiresMs: _expires, ...preview } = held;
    return preview;
  }

  /**
   * Saves a previewed page, by a human only. The preview must be this project's and unexpired, and `contentHash`
   * must be the hash of its bytes; only then is the file written and the entry committed. A commit that fails
   * removes the file again. The preview is dropped once saved, so it cannot be saved twice.
   */
  confirm(actor: Actor, projectId: string, previewId: string, contentHash: string): ShareSnapshotRecord {
    if (actor.kind !== "human") throw new HumanRequiredError();
    const held = this.previews.get(previewId);
    if (!held || held.projectId !== projectId) throw new PreviewNotFoundError();
    if (held.expiresMs <= this.now().getTime()) {
      this.previews.delete(previewId);
      throw new PreviewStaleError();
    }
    if (contentHash !== held.contentHash) throw new PreviewStaleError();
    // Checked first, so a read-only ledger never sees a file written and then removed.
    if (this.deps.ledger.readOnly) throw new LedgerReadOnlyError();

    const path = this.pathFor(projectId, previewId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, held.buf, { mode: 0o600, flag: "wx" });
    try {
      const record = commitEvent(this.deps.db, this.deps.ledger, () => ({
        event: {
          projectId,
          actor,
          type: "share.confirmed",
          payload: {
            shareId: previewId,
            contentHash: held.contentHash,
            bytes: held.bytes,
            sections: [...SHARE_SECTIONS],
            options: held.options,
            headSeq: this.deps.ledger.headSeq(),
          },
        },
        result: () => getShareSnapshot(this.deps.db, previewId),
      }));
      if (!record) throw new Error("the share snapshot was not recorded");
      this.previews.delete(previewId);
      return record;
    } catch (err) {
      rmSync(path, { force: true });
      throw err;
    }
  }

  /** The project's saved pages, newest first. */
  list(projectId: string): ShareSnapshotRecord[] {
    return listShareSnapshots(this.deps.db, projectId);
  }

  /** Where a saved page's file lives. NotFoundError for an id with no record. */
  htmlPath(shareId: string): string {
    return this.pathFor(this.record(shareId).projectId, shareId);
  }

  /**
   * A saved page's bytes, only while they match the hash the ledger recorded (SnapshotTamperedError otherwise,
   * SnapshotMissingError when the file is gone) and still pass the cleaner, whose secrets may have grown since
   * (ShareNotCleanError).
   */
  readHtml(shareId: string): string {
    const record = this.record(shareId);
    const path = this.pathFor(record.projectId, shareId);
    let buf: Buffer;
    try {
      // A file of another size cannot match; it is refused without being read.
      if (statSync(path).size !== record.bytes) throw new SnapshotTamperedError();
      buf = readFileSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new SnapshotMissingError();
      throw err;
    }
    if (sha256(buf) !== record.contentHash) throw new SnapshotTamperedError();
    const html = buf.toString("utf8");
    assertClean(html, this.deps.clean);
    return html;
  }

  private record(shareId: string): ShareSnapshotRecord {
    const record = ID.test(shareId) ? getShareSnapshot(this.deps.db, shareId) : null;
    if (!record) throw new NotFoundError("share snapshot", "?");
    return record;
  }

  private pathFor(projectId: string, shareId: string): string {
    if (!ID.test(projectId) || !ID.test(shareId)) throw new NotFoundError("share snapshot", "?");
    return join(this.deps.dataDir, "projects", projectId, "share", `${shareId}.html`);
  }

  private dropExpired(): void {
    const now = this.now().getTime();
    for (const [id, p] of this.previews) if (p.expiresMs <= now) this.previews.delete(id);
  }
}
