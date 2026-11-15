import { useEffect, useState } from "react";
import { MAX_CHANGED_FILES, MAX_DIR_ENTRIES, plural, visibleControls } from "@theterminal/shared";
import type { AgentRun, ChangeStatus, ChangedFile, DirListing } from "@theterminal/shared";
import { ADAPTER_NAMES } from "../components/AgentPanel";
import { errorMessage } from "../api";
import { useShell } from "../shell/model";

const LETTER: Record<ChangeStatus, string> = {
  added: "A", modified: "M", deleted: "D", typechange: "T", untracked: "U", unchanged: "",
};
const count = (n: number) => n.toLocaleString("en-US");
const PROMPT_CLIP = 40;

function runLabel(r: AgentRun): string {
  const prompt = visibleControls(r.prompt);
  const clipped = prompt.length > PROMPT_CLIP ? `${prompt.slice(0, PROMPT_CLIP)}…` : prompt;
  return `${ADAPTER_NAMES[r.adapter]} · ${clipped} · ${r.status}`;
}

/** `+a −d` for a file with line counts, `binary` for a binary one, nothing for an untracked one. */
function counts(f: ChangedFile) {
  if (f.binary) return <span className="muted">binary</span>;
  if (f.added === null || f.deleted === null) return null;
  return (
    <span>
      <span className="added">+{f.added}</span> <span className="deleted">−{f.deleted}</span>
    </span>
  );
}

/** One directory's entries; a sub-directory loads its own listing the first time it is opened. */
function DirList({ runId, path, label }: { runId: string; path: string; label?: string }) {
  const { model } = useShell();
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dir = model.dir;

  useEffect(() => {
    let cancelled = false;
    dir(runId, path).then(
      (l) => !cancelled && setListing(l),
      (e: unknown) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
    // model.dir is rebuilt each render; the run and the path decide what to list.
  }, [runId, path]);

  if (error !== null) return <p className="note">{error}</p>;
  if (!listing) return <p className="empty">Loading…</p>;
  const child = (name: string) => (path === "" ? name : `${path}/${name}`);
  return (
    <>
      <ul className="tree" aria-label={label}>
        {listing.entries.map((e) => {
          const name = visibleControls(e.name);
          if (e.kind === "dir") return <DirNode key={e.name} runId={runId} path={child(e.name)} name={name} />;
          if (e.kind === "other") {
            return (
              <li key={e.name} className="other" title="Not followed">
                {name}
              </li>
            );
          }
          return (
            <li key={e.name}>
              <button type="button" className="row" onClick={() => model.onOpenFile(runId, child(e.name))}>
                {name}
              </button>
            </li>
          );
        })}
      </ul>
      {listing.truncated && <p className="note">Showing {count(MAX_DIR_ENTRIES)} of more entries</p>}
    </>
  );
}

function DirNode({ runId, path, name }: { runId: string; path: string; name: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <li>
      <details onToggle={(e) => e.currentTarget.open && setOpened(true)}>
        <summary>{name}</summary>
        {opened && <DirList runId={runId} path={path} />}
      </details>
    </li>
  );
}

/** The Changes view: pick a run, see the files it changed, and browse its working copy. Nothing here edits code. */
export function ChangesSideBar() {
  const { model, openLearn } = useShell();
  if (!model.selectedId) return <p className="empty">Select a project to see what its agents changed.</p>;

  const runs = [...model.runs].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  const runId = model.changesRunId;
  const c = model.changes;

  return (
    <div className="changes">
      <select
        aria-label="Run"
        value={runId ?? ""}
        disabled={runs.length === 0}
        onChange={(e) => model.onSelectChangesRun(e.target.value === "" ? null : e.target.value)}
      >
        {runs.length === 0 && <option value="">(no runs yet)</option>}
        {runs.map((r) => (
          <option key={r.id} value={r.id}>
            {runLabel(r)}
          </option>
        ))}
      </select>
      <p className="note">
        Read-only. Agents change code; you review it.{" "}
        <button type="button" className="link" onClick={() => openLearn("reading_a_diff")}>
          Learn more
        </button>
      </p>
      {runId !== null && (
        <>
          {model.changesError !== null ? (
            <p className="note">{model.changesError}</p>
          ) : c === null ? (
            <p className="empty">Loading changes…</p>
          ) : (
            <>
              <p>
                {plural(c.files.length, "file")} changed · +{c.files.reduce((a, f) => a + (f.added ?? 0), 0)} −
                {c.files.reduce((a, f) => a + (f.deleted ?? 0), 0)}
              </p>
              {c.truncated && <p className="note">Showing {MAX_CHANGED_FILES} of more files</p>}
              <ul className="changed-files" aria-label="Changed files">
                {c.files.map((f) => {
                  const n = counts(f);
                  return (
                    <li key={f.path}>
                      <button type="button" className="row" onClick={() => model.onOpenDiff(runId, f.path)}>
                        <span className={`status status-${f.status}`}>{LETTER[f.status]}</span> {visibleControls(f.path)}
                        {n !== null && <> {n}</>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <h2>Files</h2>
          <DirList key={runId} runId={runId} path="" label="Files" />
        </>
      )}
    </div>
  );
}
