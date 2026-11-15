import { IMPORT_LIMITS, checkImportPath, foldKey, secretLikePath, visibleControls } from "@theterminal/shared";
import type { ImportResult } from "@theterminal/shared";
import { ApiError, api, errorMessage } from "./api";
import { clip } from "./components/text";

/** A file to add, with its path relative to what the person picked or dropped (folders keep their structure). */
export type PickedFile = { path: string; file: File };

/** The first names a refusal lists; the rest are counted. */
const NAMED = 20;

/** Every file under a dropped entry, depth first; `readEntries` answers in batches until it returns none. */
async function walk(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
  const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
  if (entry.isFile) {
    const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
    out.push({ path, file });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (batch.length === 0) return;
    for (const child of batch) await walk(child, path, out);
  }
}

/** The files of a drop, folders walked through `webkitGetAsEntry`, keeping their relative paths. */
export async function collectDropped(items: DataTransferItemList): Promise<PickedFile[]> {
  // Entries must be taken synchronously, before the drop event's data goes away.
  const roots: (FileSystemEntry | File)[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind !== "file") continue;
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry) roots.push(entry);
    else {
      const f = item.getAsFile();
      if (f) roots.push(f);
    }
  }
  const out: PickedFile[] = [];
  for (const r of roots) {
    if (r instanceof File) out.push({ path: r.name, file: r });
    else await walk(r, "", out);
  }
  return out;
}

/** A file input's files: a picked folder's relative paths, else each file's name. */
export function filesFromInput(list: FileList): PickedFile[] {
  return Array.from(list, (file) => ({ path: file.webkitRelativePath || file.name, file }));
}

const names = (paths: string[]) => {
  const shown = paths.slice(0, NAMED).map((p) => clip(visibleControls(p), 120));
  return paths.length > NAMED ? `${shown.join(", ")} and ${paths.length - NAMED} more` : shown.join(", ");
};

export type Precheck = { ok: true } | { ok: false; message: string; secrets?: string[] };

/**
 * The limits, the path rules and the possible secrets, checked before anything is sent; the server checks them all
 * again. `secrets` lists the names a tick of "include files that may contain secrets" would let through.
 */
export function precheck(files: PickedFile[], includeSecrets: boolean): Precheck {
  if (files.length === 0) return { ok: false, message: "Choose at least one file." };
  const total = files.reduce((n, f) => n + f.file.size, 0);
  if (files.length > IMPORT_LIMITS.files || total > IMPORT_LIMITS.bytes || files.some((f) => f.file.size > IMPORT_LIMITS.fileBytes)) {
    return { ok: false, message: errorMessage(new ApiError(413, "limit_exceeded")) };
  }
  const refused: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const checked = checkImportPath(f.path);
    const key = foldKey(checked.ok ? checked.path : f.path);
    if (!checked.ok || seen.has(key)) refused.push(f.path);
    seen.add(key);
  }
  if (refused.length > 0) {
    return { ok: false, message: `These names can't be added to a project: ${names(refused)}. Rename or leave them out and try again.` };
  }
  if (!includeSecrets) {
    const secrets = files.map((f) => f.path).filter((p) => secretLikePath(p));
    if (secrets.length > 0) {
      return { ok: false, secrets, message: errorMessage(new ApiError(409, "possible_secrets", { names: secrets.slice(0, NAMED) })) };
    }
  }
  return { ok: true };
}

const aborted = () => new DOMException("The upload was cancelled", "AbortError");

/**
 * Adds files to a project: opens an upload, sends one file per request (each streamed as its own body, one at a
 * time), then commits. On a failure or a cancel the upload is dropped on the server, so nothing is committed.
 * `onProgress(sent, total)` counts files.
 */
export async function uploadFiles(
  projectId: string,
  files: PickedFile[],
  includeSecrets: boolean,
  onProgress: (sent: number, total: number) => void,
  signal: AbortSignal,
): Promise<ImportResult> {
  if (signal.aborted) throw aborted();
  const bytes = files.reduce((n, f) => n + f.file.size, 0);
  const { uploadId } = await api.openUpload(projectId, { files: files.length, bytes, includeSecrets });
  try {
    onProgress(0, files.length);
    for (let i = 0; i < files.length; i++) {
      if (signal.aborted) throw aborted();
      await api.putUploadFile(uploadId, files[i]!.path, files[i]!.file);
      onProgress(i + 1, files.length);
    }
    if (signal.aborted) throw aborted();
    return await api.commitUpload(uploadId);
  } catch (e) {
    await api.cancelUpload(uploadId).catch(() => {});
    throw e;
  }
}

export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === "AbortError";

/** Bytes in the units the limits use (MB means MiB). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const SKIP_WORDS: Record<string, string> = {
  absolute: "an absolute path",
  dot_dot: "points outside the project",
  git: "git's own files",
  unstorable: "a name some computers can't store",
  empty: "an empty name",
  too_long: "the name is too long",
  duplicate: "the same name in another case",
  conflict: "clashes with a folder of the same name",
  link: "a link, not a file",
  other: "not a regular file",
  nested: "a separate git repository",
  missing: "it disappeared while copying",
};

/** Why a file was left out, in plain words. */
export const skipReason = (reason: string): string => SKIP_WORDS[reason] ?? "not added";

/** The words for a refusal while adding files, starting a project from a source, or writing back. */
export function sourcesMessage(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "path_refused":
        return "One of the names can't be added to a project. Rename it or leave it out.";
      case "upload_busy":
        return "Too many uploads are in progress right now. Try again in a moment.";
      case "upload_not_found":
        return "The upload expired before it finished. Nothing was added; try again.";
      case "nothing_to_write":
        return "Nothing to write back yet. Accept an agent's changes first.";
      case "already_accepted":
        return "These changes were accepted already.";
      case "no_source":
        return "This project didn't come from a folder or GitHub, so there is nowhere to send changes back.";
      case "folder_refused":
        return "That folder can't be used. Choose a folder outside The Terminal's own data folder.";
      case "github_not_connected":
        return "Connect GitHub in Connections first.";
      case "github_rejected":
        return "GitHub rejected the token. Check the GitHub connection in Connections.";
      case "github_unavailable":
        return "Could not reach GitHub. Try again in a moment.";
      case "repo_not_found":
        return "Repository not found, or the token has no access to it.";
    }
  }
  return errorMessage(e, "sources");
}

const LOCAL_HOSTS = new Set(["theterminal.localhost", "localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * True when this page is served by the listener on this computer: the desktop app's host or a loopback address, and
 * not the remote listener as far as the server said. Choosing and writing to a folder work only there.
 */
export function onLocalListener(listener?: "local" | "remote" | null): boolean {
  if (listener === "remote") return false;
  return typeof location !== "undefined" && LOCAL_HOSTS.has(location.hostname.toLowerCase());
}
