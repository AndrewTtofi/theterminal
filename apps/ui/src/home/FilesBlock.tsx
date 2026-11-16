import { useEffect, useId, useRef, useState } from "react";
import { atLeast, visibleControls } from "@theterminal/shared";
import type { DirEntry, ProjectFiles } from "@theterminal/shared";
import { DropArea, FilePickers, UploadStatus, useUpload } from "../components/AddFiles";
import { WritebackDialog } from "../components/WritebackDialog";
import { useShell, useViewerRole } from "../shell/model";
import { onLocalListener } from "../upload";
import type { PickedFile } from "../upload";

/** How many top-level entries Home lists before "+ N more". */
const SHOWN = 24;

/** Where the project's files came from, in plain words. */
export function sourceLine(data: ProjectFiles): string {
  if (data.source?.kind === "github") return `from GitHub: ${visibleControls(data.source.repo)}`;
  if (data.source?.kind === "folder") return "from a folder";
  if (data.added) return "added files";
  return "No files yet";
}

const sorted = (entries: DirEntry[]) =>
  [...entries].sort((a, b) => (a.kind === "dir") === (b.kind === "dir") ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1);

/**
 * Project files: the top-level entries of the project's latest commit, read-only, and where they came from. Maintainers
 * and above can drop or choose more files; the Owner can send accepted work back to the folder or to GitHub.
 */
export function FilesBlock() {
  const { model } = useShell();
  const role = useViewerRole();
  const headingId = useId();
  const { data, error } = model.projectFiles;
  const refresh = model.projectFiles.refresh;
  const upload = useUpload(() => refresh());
  const [writeback, setWriteback] = useState<"folder" | "github" | null>(null);
  const projectId = model.selectedId;
  const send = (files: PickedFile[], includeSecrets = false) => {
    if (projectId !== null) void upload.start(projectId, files, includeSecrets);
  };
  const sending = upload.state.phase === "sending";
  const clearUpload = upload.clear;
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  // Another project's result or refusal is not this one's; an upload in flight keeps going into its own project.
  useEffect(() => {
    if (!sendingRef.current) clearUpload();
  }, [projectId, clearUpload]);
  const owner = role === "owner";
  const canApply = owner && data?.source?.kind === "folder" && onLocalListener(model.me?.listener);
  const canPublish = owner && data?.source?.kind === "github";
  const entries = data ? sorted(data.entries) : [];
  const more = entries.length - SHOWN;
  return (
    <section className="home-block home-files" aria-labelledby={headingId}>
      <h2 id={headingId}>Project files</h2>
      {!atLeast(role, "reviewer") ? (
        <p className="home-empty">Files are shown to reviewers and above.</p>
      ) : model.selectedId === null ? (
        <p className="home-empty">Choose a project to see its files.</p>
      ) : error !== null ? (
        <p className="home-note" role="status">{error}</p>
      ) : data === null ? (
        <p className="home-empty">Loading files…</p>
      ) : (
        <>
          <p className="files-source">{sourceLine(data)}</p>
          {entries.length > 0 && (
            <ul className="home-file-list">
              {entries.slice(0, SHOWN).map((e) => (
                <li key={e.name} className={`file-chip ${e.kind}`}>
                  <span aria-hidden="true" className="file-icon">{e.kind === "dir" ? "▸" : "·"}</span>
                  <span className="visually-hidden">{e.kind === "dir" ? "Folder " : "File "}</span>
                  {visibleControls(e.name)}
                </li>
              ))}
              {(more > 0 || data.truncated) && (
                <li className="file-chip more">{more > 0 ? `+ ${more} more` : "and more"}</li>
              )}
            </ul>
          )}
          {(canApply || canPublish) && (
            <div className="files-writeback">
              {canApply && (
                <button type="button" className="quiet" onClick={() => setWriteback("folder")}>
                  Apply to my folder…
                </button>
              )}
              {canPublish && (
                <button type="button" className="quiet" onClick={() => setWriteback("github")}>
                  Publish to GitHub…
                </button>
              )}
            </div>
          )}
          {atLeast(role, "maintainer") && (
            <DropArea onDropped={(f) => send(f)} disabled={sending} hint="Drop files or a folder here to add them to this project">
              {!sending && <FilePickers onPicked={(f) => send(f)} />}
              <UploadStatus upload={upload} onRetry={send} />
            </DropArea>
          )}
        </>
      )}
      {writeback !== null && projectId !== null && (
        <WritebackDialog projectId={projectId} kind={writeback} onClose={() => setWriteback(null)} />
      )}
    </section>
  );
}
