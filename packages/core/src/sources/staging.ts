import { mkdirSync, rmSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { IMPORT_LIMITS, checkImportPath, foldKey, secretLikePath, visibleControls, type PathRefusal } from "@theterminal/shared";

export type ImportLimit = "files" | "bytes" | "file_bytes";
export type ImportLimits = { files: number; bytes: number; fileBytes: number };

/** An import broke one of the limits; nothing of it is committed. */
export class ImportLimitError extends Error {
  constructor(readonly limit: ImportLimit) {
    super("import limit exceeded");
    this.name = "ImportLimitError";
  }
}

/** The import holds names that may be secrets and the person did not choose to include them. */
export class PossibleSecretsError extends Error {
  constructor(readonly names: string[]) {
    super("the import holds files that may contain secrets");
    this.name = "PossibleSecretsError";
  }
}

/** A path was refused outright (an upload's single file, where there is nothing to skip it from). */
export class PathRefusedError extends Error {
  constructor(readonly reason: PathRefusal | string) {
    super("path refused");
    this.name = "PathRefusedError";
  }
}

/** A folder that may not be imported: a relative path, the data folder, or one inside it or containing it. */
export class FolderRefusedError extends Error {
  constructor() {
    super("this folder cannot be used");
    this.name = "FolderRefusedError";
  }
}

/** The folder is missing or is not a directory. */
export class FolderUnavailableError extends Error {
  constructor() {
    super("the folder is not available");
    this.name = "FolderUnavailableError";
  }
}

const MAX_SECRET_NAMES = 20;
const MAX_SKIPPED_LISTED = 50;

export type StagedImport = { files: string[]; bytes: number; skipped: { path: string; reason: string }[]; skippedCount: number };

/**
 * One import's files on their way into the project repo, under `dir` (`<data>/projects/<id>/staging/<uuid>`, or
 * `<data>/staging/<uuid>` before the project exists). Every path passes `checkImportPath` and a case-collision check
 * before anything is read; each body is streamed to disk with its bytes counted as they arrive, so the per-file and
 * total limits hold on what was actually sent, never on a declared size. A secret-like name is counted but never
 * written unless the import includes secrets, and `finish` then refuses the whole import.
 */
export class ImportStaging {
  private readonly limits: ImportLimits;
  private readonly files: string[] = [];
  private readonly seen = new Set<string>();
  private readonly secrets: string[] = [];
  private readonly skipped: { path: string; reason: string }[] = [];
  private skippedCount = 0;
  private bytes = 0;

  constructor(
    readonly dir: string,
    private readonly o: {
      includeSecrets: boolean;
      redact: (s: string) => string;
      limits?: ImportLimits;
      /**
       * A refused path throws PathRefusedError and destroys its body instead of skipping it: for an HTTP body, which
       * is never read to its end for nothing (the connection is closed instead).
       */
      refuse?: boolean;
    },
  ) {
    this.limits = o.limits ?? IMPORT_LIMITS;
    mkdirSync(dir, { recursive: true });
  }

  /** Text safe to show: redacted, hidden characters made visible. */
  private clean(s: string): string {
    return visibleControls(this.o.redact(s));
  }

  /** Records a path that is not imported; at most 50 are listed, every one is counted. */
  skip(path: string, reason: string): void {
    this.skippedCount++;
    if (this.skipped.length < MAX_SKIPPED_LISTED) this.skipped.push({ path: this.clean(path), reason });
  }

  /**
   * Stages one file. A refused path or a case collision is skipped (its body drained) without counting, or with
   * `refuse` throws PathRefusedError; the file
   * count is checked before the body is read; then the body is streamed to its file, and passing `fileBytes` or the
   * running total destroys the body, removes the partial file and throws ImportLimitError. A body that fails
   * mid-stream also leaves no file behind.
   */
  async add(path: string, body: Readable): Promise<"added" | "skipped"> {
    const checked = checkImportPath(path);
    if (!checked.ok) return this.drainSkipped(path, checked.reason, body);
    const key = foldKey(checked.path);
    if (this.seen.has(key)) return this.drainSkipped(path, "duplicate", body);
    if (this.files.length + this.secrets.length >= this.limits.files) {
      body.destroy();
      throw new ImportLimitError("files");
    }
    this.seen.add(key);

    const secret = secretLikePath(checked.path, this.o.redact);
    if (secret && !this.o.includeSecrets) {
      const n = await this.pump(body, null);
      this.secrets.push(checked.path);
      this.bytes += n;
      return "skipped";
    }

    const target = join(this.dir, ...checked.path.split("/"));
    let handle;
    try {
      mkdirSync(dirname(target), { recursive: true });
      // Exclusive create: never opens an existing file or follows a link at the target.
      handle = await open(target, "wx");
    } catch {
      this.seen.delete(key);
      return this.drainSkipped(path, "conflict", body);
    }
    let n: number;
    try {
      n = await this.pump(body, (chunk) => handle.write(chunk).then(() => undefined));
    } catch (e) {
      await handle.close().catch(() => undefined);
      await rm(target, { force: true }).catch(() => undefined);
      this.seen.delete(key);
      throw e;
    }
    await handle.close();
    this.files.push(checked.path);
    if (secret) this.secrets.push(checked.path);
    this.bytes += n;
    return "added";
  }

  /**
   * Skips a path and drains its body so a stream reader (an archive) can move on to the next entry; with `refuse`,
   * destroys the body and throws PathRefusedError instead.
   */
  private async drainSkipped(path: string, reason: string, body: Readable): Promise<"skipped"> {
    if (this.o.refuse === true) {
      body.destroy();
      throw new PathRefusedError(reason);
    }
    this.skip(path, reason);
    body.resume();
    return "skipped";
  }

  /** Streams `body` into `sink` (or nowhere), counting bytes and enforcing both byte limits before each write. */
  private async pump(body: Readable, sink: ((chunk: Buffer) => Promise<void>) | null): Promise<number> {
    let n = 0;
    try {
      for await (const chunk of body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        n += buf.length;
        if (n > this.limits.fileBytes) throw new ImportLimitError("file_bytes");
        if (this.bytes + n > this.limits.bytes) throw new ImportLimitError("bytes");
        if (sink !== null) await sink(buf);
      }
    } finally {
      if (!body.readableEnded) body.destroy();
    }
    return n;
  }

  /**
   * What was staged. Throws PossibleSecretsError, naming the first 20 secret-like paths (redacted, hidden characters
   * made visible), when any were seen and the import does not include secrets.
   */
  finish(): StagedImport {
    if (this.secrets.length > 0 && !this.o.includeSecrets) {
      throw new PossibleSecretsError(this.secrets.slice(0, MAX_SECRET_NAMES).map((s) => this.clean(s)));
    }
    return { files: [...this.files], bytes: this.bytes, skipped: [...this.skipped], skippedCount: this.skippedCount };
  }

  /** Removes the staging directory; never throws. */
  dispose(): void {
    try {
      rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Best effort: a later sweep removes what is left.
    }
  }
}
