import { useId } from "react";
import { atLeast, visibleControls } from "@theterminal/shared";
import type { DirEntry, ProjectFiles } from "@theterminal/shared";
import { useShell, useViewerRole } from "../shell/model";

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

/** Project files: the top-level entries of the project's latest commit, read-only, and where they came from. */
export function FilesBlock() {
  const { model } = useShell();
  const role = useViewerRole();
  const headingId = useId();
  const { data, error } = model.projectFiles;
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
        </>
      )}
    </section>
  );
}
