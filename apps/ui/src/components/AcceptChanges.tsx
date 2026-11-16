import { useEffect, useId, useRef, useState } from "react";
import { atLeast, plural, visibleControls } from "@theterminal/shared";
import type { AgentRun, RunChanges } from "@theterminal/shared";
import { useShell, useViewerRole } from "../shell/model";
import { clip } from "./text";
import "./sources.css";

/** How many changed files the confirmation lists. */
const LISTED = 20;

/**
 * "Accept these changes" for a finished run, for maintainers and above: it first lists what the run changed, then
 * merges it into the project on Accept. An accepted run says so instead. `changes` is the run's list when the caller
 * already has it; otherwise it is read when the confirmation opens.
 */
export function AcceptChanges({ run, changes }: { run: AgentRun; changes?: RunChanges | null }) {
  const { model } = useShell();
  const role = useViewerRole();
  const groupId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState<RunChanges | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);
  const given = changes && changes.runId === run.id ? changes : null;
  const list = given ?? loaded;

  useEffect(() => {
    if (!open || given || loaded || !model.runChanges) return;
    let live = true;
    model.runChanges(run.id).then(
      (c) => live && setLoaded(c),
      () => live && setLoadFailed(true),
    );
    return () => {
      live = false;
    };
  }, [open, given, loaded, model, run.id]);

  if (run.status === "running") return null;
  if (accepted || (run.acceptedCommit ?? null) !== null) {
    return (
      <span className="accepted-badge">
        <span aria-hidden="true">✓ </span>Accepted
      </span>
    );
  }
  if (!atLeast(role, "maintainer")) return null;

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await model.onAcceptRun(run.id).catch(() => false);
    setBusy(false);
    if (ok) setAccepted(true);
    else setFailed(true);
  };

  if (!open) {
    return (
      <button type="button" className="quiet accept-button" onClick={() => setOpen(true)}>
        Accept these changes
      </button>
    );
  }
  const files = list?.files ?? [];
  return (
    <div className="accept-confirm" role="group" aria-labelledby={groupId}>
      <span id={groupId} className="visually-hidden">Accept these changes</span>
      {list === null ? (
        <p className="accept-question">{loadFailed ? "Merge this run's changes into the project? The list of files could not be read." : "Reading what changed…"}</p>
      ) : list.tooMany ? (
        <p className="accept-question">Merge this run's changes into the project? There are too many files to list here.</p>
      ) : (
        <>
          <p className="accept-question">{`Merge ${plural(files.length, "changed file")} into the project?`}</p>
          {files.length > 0 && (
            <ul className="accept-files">
              {files.slice(0, LISTED).map((f) => (
                <li key={f.path}>{f.cleaned ? "(name hidden)" : clip(visibleControls(f.path), 160)}</li>
              ))}
              {(files.length > LISTED || list.truncated) && <li className="more">and more</li>}
            </ul>
          )}
        </>
      )}
      <div className="accept-actions">
        <button type="button" disabled={busy || (list === null && !loadFailed)} onClick={() => void accept()}>
          {busy ? "Accepting…" : "Accept"}
        </button>
        <button ref={cancelRef} type="button" className="quiet" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
        {failed && <span className="accept-failed" role="status">Not accepted.</span>}
      </div>
    </div>
  );
}
