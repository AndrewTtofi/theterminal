import { useCallback, useEffect, useId, useState } from "react";
import { visibleControls } from "@theterminal/shared";
import type { ApplyResult, PublishResult, WritebackPreview } from "@theterminal/shared";
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

type Done = { kind: "folder"; result: ApplyResult } | ({ kind: "github" } & PublishResult);

/**
 * Files Apply left out for one reason, said plainly: write-back moves on past them, so they are never offered again
 * and the person copies them by hand if they want them.
 */
function SkippedGroup({ paths, why, label }: { paths: string[]; why: (one: boolean) => string; label: string }) {
  if (paths.length === 0) return null;
  const one = paths.length === 1;
  const these = one ? "This 1 file" : `These ${paths.length} files`;
  const them = one ? "it" : "them";
  return (
    <div className="writeback-skipped">
      <p>{`${these} ${why(one)}; ${one ? "it" : "they"} won't be offered again — copy ${them} by hand if you want ${them}.`}</p>
      <ul className="writeback-files" aria-label={label}>
        {paths.map((p) => (
          <li key={p}>
            <span className="wb-path">{clip(visibleControls(p), 200)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
              <SkippedGroup
                paths={done.result.skipped.filter((s) => s.reason === "changed").map((s) => s.path)}
                label="Skipped files"
                why={(one) => (one ? "was skipped because it changed in your folder" : "were skipped because they changed in your folder")}
              />
              <SkippedGroup
                paths={done.result.skipped.filter((s) => s.reason !== "changed").map((s) => s.path)}
                label="Files not written"
                why={() => "could not be written safely to your folder (a link, or a name this computer cannot store)"}
              />
            </div>
          ) : (
            <div role="status" className="writeback-done">
              <p className="import-done">
                <span className="import-tick" aria-hidden="true">✓</span>
                The pull request is open on GitHub, on the branch <code>{visibleControls(done.branch)}</code>.
              </p>
              {done.skipped.length > 0 && (
                <p className="writeback-skipped">
                  {`${done.skipped.length === 1 ? "This 1 file was" : `These ${done.skipped.length} files were`} left out because this computer cannot store ${done.skipped.length === 1 ? "its name" : "their names"}: ${done.skipped.map((s) => clip(visibleControls(s.path), 160)).join(", ")}`}
                </p>
              )}
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
                  ? "Only these files are written. A file you changed in your folder since it was copied in is left alone and won't be offered again."
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
