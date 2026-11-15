import { useEffect, useState } from "react";
import { visibleControls } from "@theterminal/shared";
import type { FileDiff } from "@theterminal/shared";
import { UnifiedDiff } from "../components/UnifiedDiff";
import { parsePanelPath } from "../shell/dock-layout";
import { useShell } from "../shell/model";
import { useRunData } from "./use-run-data";

/** What a diff tab shows in place of the diff, or null when the diff itself is shown. */
function special(d: FileDiff): string | null {
  if (d.binary) return "Binary file: no text to show";
  if (d.tooLarge) {
    const counts = d.added !== null && d.deleted !== null ? ` (${d.added} added, ${d.deleted} deleted lines)` : "";
    return `This change is too large to show here${counts}. Open the file instead, or ask an agent to summarise it.`;
  }
  if (d.status === "unchanged") return "This file has not changed in this run.";
  return null;
}

/** A read-only tab with one file's diff against the run's starting point, or why it cannot be shown. */
export function DiffPanel({ id }: { id: string }) {
  const { model } = useShell();
  const target = parsePanelPath(id);
  const { data, error } = useRunData(id, target, model.diff);
  const [base, setBase] = useState<string | null>(null);
  const runChanges = model.runChanges;
  const runId = target?.runId ?? null;

  useEffect(() => {
    if (runId === null) return;
    let cancelled = false;
    runChanges(runId).then(
      (c) => !cancelled && setBase(c.base),
      () => {},
    );
    return () => {
      cancelled = true;
    };
    // runChanges is memoised per run by App; the run alone decides when to ask.
  }, [runId]);

  if (!target) return <p className="empty">This tab does not name a file.</p>;
  const path = visibleControls(target.path);
  if (!data) return <p className="empty">{error ?? "Loading the diff…"}</p>;
  const note = special(data);

  return (
    <section className="file-view" aria-label={`Diff: ${path}`}>
      <header className="file-head">
        <span className="file-path">{path}</span>
        <span>{data.status}</span>
        {data.added !== null && data.deleted !== null && (
          <span>
            <span className="added">+{data.added}</span> <span className="deleted">−{data.deleted}</span>
          </span>
        )}
        {data.status === "untracked" && <span>New file, not yet committed</span>}
        {base !== null && <span>Compared with {base.slice(0, 8)} (this run's starting point)</span>}
      </header>
      {error !== null && <p className="note">{error}</p>}
      {note !== null ? (
        <div className="empty">
          <p>{note}</p>
          {data.tooLarge && !data.binary && data.status !== "deleted" && (
            <button type="button" onClick={() => model.onOpenFile(target.runId, target.path)}>
              Open file
            </button>
          )}
        </div>
      ) : (
        <UnifiedDiff text={data.text ?? ""} />
      )}
    </section>
  );
}
