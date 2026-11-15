import { useCallback, useEffect, useId, useState } from "react";
import { visibleControls } from "@theterminal/shared";
import type { ApplyResult, WritebackPreview } from "@theterminal/shared";
import { ApiError, api } from "../api";
import { sourcesMessage } from "../upload";
import { Modal } from "./Modal";
import { clip } from "./text";

type Kind = "folder" | "github";

const TITLE: Record<Kind, string> = { folder: "Apply to my folder", github: "Publish to GitHub" };
const CHANGE: Record<WritebackPreview["files"][number]["change"], string> = { add: "added", modify: "changed", delete: "deleted" };
const NOTHING = "Nothing to write back yet. Accept an agent's changes first.";

function question(kind: Kind, n: number): string {
  const these = n === 1 ? "this 1 file" : `these ${n} files`;
  return kind === "folder" ? `Write ${these} to your folder?` : `Open a pull request with ${these}?`;
}

type Done = { kind: "folder"; result: ApplyResult } | { kind: "github"; branch: string; pullUrl: string };

/**
 * Sends accepted work back where the project came from, after showing every file it will touch. Confirm sends the
 * previewed `head`; if the project moved since, the server refuses (`preview_stale`) and the list is read again.
 */
export function WritebackDialog({ projectId, kind, onClose }: { projectId: string; kind: Kind; onClose: () => void }) {
  const titleId = useId();
  const [preview, setPreview] = useState<WritebackPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setPreview(await api.writebackPreview(projectId));
    } catch (e) {
      setPreview(null);
      setLoadError(e instanceof ApiError && e.code === "nothing_to_write" ? NOTHING : sourcesMessage(e));
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  const confirm = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      if (kind === "folder") setDone({ kind, result: await api.applyToFolder(projectId, preview.head) });
      else setDone({ kind, ...(await api.publishToGitHub(projectId, preview.head)) });
    } catch (e) {
      setNotice(sourcesMessage(e));
      if (e instanceof ApiError && e.code === "preview_stale") {
        setPreview(null);
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const files = preview?.files ?? [];
  return (
    <Modal labelledBy={titleId} onClose={onClose} locked={busy} className="writeback-dialog">
      <header className="modal-head">
        <h2 id={titleId}>{TITLE[kind]}</h2>
      </header>
      {done !== null ? (
        <div className="modal-body">
          {done.kind === "folder" ? (
            <div role="status" className="writeback-done">
              <p className="import-done">
                <span className="import-tick" aria-hidden="true">✓</span>
                {`Wrote ${done.result.written} ${done.result.written === 1 ? "file" : "files"} to your folder${done.result.deleted > 0 ? ` and removed ${done.result.deleted}` : ""}.`}
              </p>
              {done.result.skipped.length > 0 && (
                <p className="writeback-skipped">
                  {`Skipped because they changed in your folder: ${done.result.skipped.map((p) => clip(visibleControls(p), 160)).join(", ")}`}
                </p>
              )}
            </div>
          ) : (
            <div role="status" className="writeback-done">
              <p className="import-done">
                <span className="import-tick" aria-hidden="true">✓</span>
                The pull request is open on GitHub, on the branch <code>{visibleControls(done.branch)}</code>.
              </p>
              <p>
                <a href={done.pullUrl} target="_blank" rel="noreferrer noopener">
                  Open the pull request
                </a>
              </p>
            </div>
          )}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <div className="modal-body">
          {notice !== null && (
            <p className="modal-notice" role="alert">
              {notice}
            </p>
          )}
          {loadError !== null ? (
            <p className="modal-note">{loadError}</p>
          ) : preview === null ? (
            <p className="modal-note" role="status">Reading what changed…</p>
          ) : files.length === 0 ? (
            <p className="modal-note">{NOTHING}</p>
          ) : (
            <>
              <p className="writeback-question">{question(kind, files.length)}</p>
              <p className="modal-note">
                {kind === "folder"
                  ? "Only these files are written. A file you changed in your folder since it was copied in is left alone."
                  : "One commit with these changes goes on a new branch, and a pull request asks to merge it. Nothing is merged for you."}
              </p>
              <ul className="writeback-files" aria-label="Files to write">
                {files.map((f) => (
                  <li key={f.path}>
                    <span className={`wb-change wb-${f.change}`}>{CHANGE[f.change]}</span>
                    <span className="wb-path">{clip(visibleControls(f.path), 200)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="modal-actions">
            <button type="button" className="quiet" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            {preview !== null && files.length > 0 && (
              <button type="button" onClick={() => void confirm()} disabled={busy}>
                {busy ? (kind === "folder" ? "Writing…" : "Publishing…") : TITLE[kind]}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
