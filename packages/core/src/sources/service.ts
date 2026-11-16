import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  IMPORT_LIMITS, MAX_DIR_ENTRIES, OWNER_ID, checkImportPath, foldKey, secretLikePath, visibleControls,
  type Actor, type DirEntry, type ImportResult, type ImportedProject, type NewLedgerEntry, type Principal, type Project,
  type ProjectFiles, type ProjectSourceView,
} from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import type { WorktreeManager } from "../agents/worktrees.js";
import { NotFoundError, type BoardService } from "../board/board-service.js";
import type { GitHubRepos } from "../github/repos.js";
import { commitEvents } from "../events/commit.js";
import { countImportedFiles, getProjectSource } from "../events/projections.js";
import { RecordedText } from "../intake/recorded-text.js";
import { FolderRefusedError, listFolder, stageFolder } from "./folder.js";
import { ImportLimitError, ImportStaging, PathRefusedError, type StagedImport } from "./staging.js";
import { TarInvalidError, TarLimitError, readTarGz } from "./tar.js";

/** More than 4 uploads are open on the server, or the upload is already busy with another request. */
export class UploadBusyError extends Error {
  constructor() {
    super("too many uploads are open, or this upload is busy");
    this.name = "UploadBusyError";
  }
}

/** No such upload for this person: unknown, someone else's, committed, cancelled or expired. */
export class UploadNotFoundError extends Error {
  constructor() {
    super("upload not found");
    this.name = "UploadNotFoundError";
  }
}

/** What the service needs of the GitHub client. */
export type SourceGitHub = Pick<GitHubRepos, "head" | "tarball">;

export type SourceServiceDeps = {
  db: Db;
  ledger: Ledger;
  worktrees: WorktreeManager;
  board: BoardService;
  github: SourceGitHub;
  dataDir: string;
  redact: (s: string) => string;
  newId?: () => string;
  now?: () => Date;
  /** Makes a folder's base name fit for the project name; defaults to one scrubbing the data folder. */
  recorded?: RecordedText;
};

/** Open uploads one person may have at once. */
const MAX_OPEN_UPLOADS_PER_PERSON = 4;
/** Open uploads on the whole server at once. */
const MAX_OPEN_UPLOADS = 16;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
/** Files, links and anything else in an archive; staging still holds the files to IMPORT_LIMITS.files. */
const TAR_MAX_ENTRIES = IMPORT_LIMITS.files * 2;
const NAME_MAX = 120;
const FOLDER_NAME_FALLBACK = "Imported folder";
const PATH_MAX = 4096;
const LS_TREE_MAX_BUFFER = 16 * 1024 * 1024;
const STAGING = "staging";

type Upload = {
  id: string;
  owner: string;
  projectId: string;
  includeSecrets: boolean;
  staging: ImportStaging;
  createdAt: number;
  busy: boolean;
  /** Folded paths already put, so a second one differing only by case is refused at its PUT. */
  seen: Set<string>;
};

type SourceSet =
  | { kind: "github"; repo: string; branch: string; remoteCommit: string }
  | { kind: "folder"; path: string };

/** A tar reader limit as the import limit (or refusal) the person is told about. */
function fromTarError(e: unknown): unknown {
  if (!(e instanceof TarLimitError)) return e;
  switch (e.limit) {
    case "entries":
      return new ImportLimitError("files");
    case "file_bytes":
      return new ImportLimitError("file_bytes");
    case "bytes":
    case "compressed":
      return new ImportLimitError("bytes");
    case "path":
      return new PathRefusedError("too_long");
    default:
      return new TarInvalidError("metadata header too large");
  }
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Projects from files, a GitHub repository or a folder on this computer. Every import goes through one ImportStaging
 * (the limits, the path rules, possible secrets), and only once the whole import has been staged and accepted is
 * anything created: the project, one commit into its repo, then `project.source_set` and `project.files_imported`
 * in one ledger commit. Any failure disposes the staging folder; a failure after the project was created leaves the
 * project empty, and nothing is lost.
 */
export class SourceService {
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly recorded: RecordedText;
  private readonly uploads = new Map<string, Upload>();
  /** Staging folders in use (uploads and imports under way), which the sweep never removes. */
  private readonly active = new Set<string>();

  constructor(private readonly deps: SourceServiceDeps) {
    this.newId = deps.newId ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
    this.recorded = deps.recorded ?? new RecordedText({ dataDir: deps.dataDir });
  }

  async createFromGitHub(actor: Actor, i: { repo: string; name?: string; includeSecrets?: boolean }): Promise<ImportedProject> {
    const { branch, commit } = await this.deps.github.head(i.repo);
    const includeSecrets = i.includeSecrets === true;
    return this.withStaging(join(this.deps.dataDir, STAGING, this.newId()), includeSecrets, async (staging) => {
      const ctl = new AbortController();
      try {
        const archive = await this.deps.github.tarball(i.repo, commit, ctl.signal);
        await readTarGz(archive, async (entry, body) => {
          if (entry.kind === "file") {
            await staging.add(entry.path, body);
            return;
          }
          body.resume();
          if (entry.kind === "link" || entry.kind === "other") staging.skip(entry.path, entry.kind);
        }, { maxCompressedBytes: IMPORT_LIMITS.bytes, maxEntries: TAR_MAX_ENTRIES });
      } catch (e) {
        ctl.abort();
        throw fromTarError(e);
      }
      const staged = staging.finish();
      const name = i.name ?? i.repo.slice(i.repo.indexOf("/") + 1);
      return this.land(actor, name, staging, staged, `Imported from GitHub: ${i.repo}`, "github", includeSecrets, {
        kind: "github", repo: i.repo, branch, remoteCommit: commit,
      });
    });
  }

  async createFromFolder(actor: Actor, i: { path: string; name?: string; includeSecrets?: boolean }): Promise<ImportedProject> {
    if (typeof i.path !== "string" || i.path.length > PATH_MAX || !isAbsolute(i.path)) throw new FolderRefusedError();
    const folder = resolve(i.path);
    const listed = await listFolder(this.deps.worktrees, this.deps.dataDir, folder);
    const includeSecrets = i.includeSecrets === true;
    return this.withStaging(join(this.deps.dataDir, STAGING, this.newId()), includeSecrets, async (staging) => {
      for (const n of listed.nested) staging.skip(n, "nested");
      await stageFolder(staging, folder, listed.files);
      const staged = staging.finish();
      const name = i.name ?? this.folderName(folder);
      return this.land(actor, name, staging, staged, "Imported from a folder", "folder", includeSecrets, { kind: "folder", path: folder });
    });
  }

  openUpload(actor: Actor, projectId: string, i: { files: number; bytes: number; includeSecrets: boolean }): { uploadId: string } {
    if (!Number.isSafeInteger(i.files) || i.files < 0 || !Number.isSafeInteger(i.bytes) || i.bytes < 0) {
      throw new RangeError("invalid upload totals");
    }
    if (i.files > IMPORT_LIMITS.files) throw new ImportLimitError("files");
    if (i.bytes > IMPORT_LIMITS.bytes) throw new ImportLimitError("bytes");
    this.requireProject(projectId);
    this.expire(this.now());
    if (this.uploads.size >= MAX_OPEN_UPLOADS) throw new UploadBusyError();
    let own = 0;
    for (const u of this.uploads.values()) if (u.owner === actor.id) own += 1;
    if (own >= MAX_OPEN_UPLOADS_PER_PERSON) throw new UploadBusyError();
    const id = this.newId();
    const dir = join(this.deps.dataDir, "projects", projectId, STAGING, id);
    this.active.add(dir);
    let staging: ImportStaging;
    try {
      staging = new ImportStaging(dir, { includeSecrets: i.includeSecrets === true, redact: this.deps.redact, refuse: true });
    } catch (e) {
      this.active.delete(dir);
      throw e;
    }
    this.uploads.set(id, {
      id, owner: actor.id, projectId, includeSecrets: i.includeSecrets === true, staging,
      createdAt: this.now().getTime(), busy: false, seen: new Set(),
    });
    return { uploadId: id };
  }

  /**
   * Streams one file into the upload. A refused path (or one differing from an earlier put only by case) is refused
   * before the body is read; one clashing with an earlier file (a file where a folder is needed) is refused with its
   * body destroyed, never drained. Any failure while streaming (a broken limit, a dropped connection) ends the whole upload:
   * its staging folder is removed and nothing of it can be committed.
   */
  async putUploadFile(actor: Actor, uploadId: string, path: string, body: Readable): Promise<void> {
    const u = this.ownUpload(actor, uploadId);
    const checked = checkImportPath(path);
    if (!checked.ok) throw new PathRefusedError(checked.reason);
    const key = foldKey(checked.path);
    if (u.seen.has(key)) throw new PathRefusedError("duplicate");
    if (u.busy) throw new UploadBusyError();
    u.busy = true;
    try {
      await u.staging.add(checked.path, body);
      u.seen.add(key);
    } catch (e) {
      // A refused path (one clashing with an earlier file) leaves nothing staged: the upload carries on.
      if (!(e instanceof PathRefusedError)) this.drop(u);
      throw e;
    } finally {
      u.busy = false;
    }
  }

  async commitUpload(actor: Actor, uploadId: string): Promise<ImportResult> {
    const u = this.ownUpload(actor, uploadId);
    if (u.busy) throw new UploadBusyError();
    this.uploads.delete(u.id);
    try {
      const staged = u.staging.finish();
      const n = staged.files.length;
      const message = `Added ${n} ${n === 1 ? "file" : "files"}`;
      const commit = await this.deps.worktrees.commitFiles(u.projectId, u.staging.dir, staged.files, message);
      const result = this.resultOf(commit, staged);
      if (n > 0) this.record(actor, u.projectId, null, "files", u.includeSecrets, commit, staged);
      return result;
    } finally {
      this.drop(u);
    }
  }

  cancelUpload(actor: Actor, uploadId: string): void {
    this.drop(this.ownUpload(actor, uploadId));
  }

  /**
   * Removes uploads opened more than an hour before `now`, and every staging folder on disk that no upload or import
   * under way is using (left behind by an earlier server, say).
   */
  sweep(now: Date): void {
    this.expire(now);
    const roots = [join(this.deps.dataDir, STAGING)];
    const projects = join(this.deps.dataDir, "projects");
    for (const p of this.list(projects)) roots.push(join(projects, p, STAGING));
    for (const root of roots) {
      for (const d of this.list(root)) {
        const dir = join(root, d);
        if (this.active.has(dir)) continue;
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
          // The next sweep tries again.
        }
      }
    }
  }

  /**
   * The top level of the project's HEAD: directories first, then files, each by name, at most MAX_DIR_ENTRIES. The
   * folder path of a folder source is included only when `viewer` is the Owner.
   */
  async projectFiles(projectId: string, viewer: Pick<Principal, "personId"> | null): Promise<ProjectFiles> {
    this.requireProject(projectId);
    const repo = await this.deps.worktrees.ensureProjectRepo(projectId);
    const head = (await this.deps.worktrees.runGit(repo, ["rev-parse", "--verify", "HEAD"])).trim();
    const out = await this.deps.worktrees.runGit(repo, ["ls-tree", "-l", "-z", head], { maxBuffer: LS_TREE_MAX_BUFFER });
    const rank = { dir: 0, file: 1, other: 2 } as const;
    const all: { name: string; kind: DirEntry["kind"]; size: number | null }[] = [];
    for (const line of out.split("\0")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const [mode, type, , size] = line.slice(0, tab).split(/ +/);
      const name = line.slice(tab + 1);
      if (type === "tree") all.push({ name, kind: "dir", size: null });
      else if (type === "blob" && (mode === "100644" || mode === "100755")) all.push({ name, kind: "file", size: Number(size) });
      else all.push({ name, kind: "other", size: null });
    }
    all.sort((a, b) => rank[a.kind] - rank[b.kind] || byName(a.name, b.name));
    const entries: DirEntry[] = all.slice(0, MAX_DIR_ENTRIES).map((e) => {
      const shown = visibleControls(this.deps.redact(e.name));
      return { ...e, name: shown, ...(shown !== e.name && { cleaned: true as const }) };
    });
    return {
      source: this.sourceView(projectId, viewer?.personId === OWNER_ID),
      added: countImportedFiles(this.deps.db, projectId) > 0,
      head,
      entries,
      truncated: all.length > MAX_DIR_ENTRIES,
    };
  }

  private sourceView(projectId: string, owner: boolean): ProjectSourceView {
    const s = getProjectSource(this.deps.db, projectId);
    if (s === null) return null;
    if (s.kind === "github") return { kind: "github", repo: s.repo ?? "", branch: s.branch ?? "" };
    return owner && s.path !== null ? { kind: "folder", path: s.path } : { kind: "folder" };
  }

  /** Runs `fn` with a new staging folder, always disposed afterwards; the sweep leaves it alone meanwhile. */
  private async withStaging<T>(dir: string, includeSecrets: boolean, fn: (s: ImportStaging) => Promise<T>): Promise<T> {
    this.active.add(dir);
    try {
      const staging = new ImportStaging(dir, { includeSecrets, redact: this.deps.redact });
      try {
        return await fn(staging);
      } finally {
        staging.dispose();
      }
    } finally {
      this.active.delete(dir);
    }
  }

  /** After a whole import was staged and accepted: the project, its commit, and the two ledger entries. */
  private async land(
    actor: Actor, name: string, staging: ImportStaging, staged: StagedImport, message: string,
    from: "github" | "folder", includeSecrets: boolean, source: SourceSet,
  ): Promise<ImportedProject> {
    const project = this.deps.board.createProject(actor, { name });
    const commit = await this.deps.worktrees.commitFiles(project.id, staging.dir, staged.files, message);
    this.record(actor, project.id, source, from, includeSecrets, commit, staged);
    return { project, result: this.resultOf(commit, staged) };
  }

  private record(
    actor: Actor, projectId: string, source: SourceSet | null, from: "files" | "github" | "folder",
    includeSecrets: boolean, commit: string, staged: StagedImport,
  ): void {
    const secretsIncluded = includeSecrets && staged.files.some((f) => secretLikePath(f, this.deps.redact));
    const events: NewLedgerEntry[] = [];
    if (source !== null) {
      events.push({ projectId, actor, type: "project.source_set", payload: { projectId, ...source, syncedCommit: commit } });
    }
    events.push({
      projectId, actor, type: "project.files_imported",
      payload: { projectId, from, commit, files: staged.files.length, bytes: staged.bytes, skipped: staged.skippedCount, secretsIncluded },
    });
    commitEvents(this.deps.db, this.deps.ledger, () => ({ events, result: () => undefined }));
  }

  private resultOf(commit: string, staged: StagedImport): ImportResult {
    return { commit, files: staged.files.length, bytes: staged.bytes, skipped: staged.skipped, skippedCount: staged.skippedCount };
  }

  /** The folder's base name, when it is fit to record as a project name; a fixed name otherwise. */
  private folderName(folder: string): string {
    const name = basename(folder).trim().slice(0, NAME_MAX).trim();
    if (name === "" || !this.recorded.passes(name)) return FOLDER_NAME_FALLBACK;
    return name;
  }

  private requireProject(projectId: string): Project {
    const r = this.deps.db.prepare("SELECT id, name, pitch, created_at FROM projects WHERE id = ?").get(projectId) as
      | { id: string; name: string; pitch: string; created_at: string }
      | undefined;
    if (!r) throw new NotFoundError("project", projectId);
    return { id: r.id, name: r.name, pitch: r.pitch, createdAt: r.created_at };
  }

  /** The person's own open upload; anything else is UploadNotFoundError. An expired one is removed first. */
  private ownUpload(actor: Actor, uploadId: string): Upload {
    this.expire(this.now());
    const u = this.uploads.get(uploadId);
    if (!u || u.owner !== actor.id) throw new UploadNotFoundError();
    return u;
  }

  private expire(now: Date): void {
    for (const u of [...this.uploads.values()]) {
      if (now.getTime() - u.createdAt > UPLOAD_TTL_MS) this.drop(u);
    }
  }

  private drop(u: Upload): void {
    if (this.uploads.get(u.id) === u) this.uploads.delete(u.id);
    u.staging.dispose();
    this.active.delete(u.staging.dir);
  }

  private list(dir: string): string[] {
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }
}
