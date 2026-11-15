import { MAX_RENDERED_LINES, visibleControls } from "@theterminal/shared";
import { stripAnsi } from "../components/text";
import { parsePanelPath } from "../shell/dock-layout";
import { useShell } from "../shell/model";
import { useRunData } from "./use-run-data";

const count = (n: number) => n.toLocaleString("en-US");

/** A file's lines, without the empty one after a final line break. */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** A read-only tab with one file of a run's working copy, as numbered plain text. */
export function FilePanel({ id }: { id: string }) {
  const { model } = useShell();
  const target = parsePanelPath(id);
  const { data, error } = useRunData(id, target, model.file);

  if (!target) return <p className="empty">This tab does not name a file.</p>;
  const path = visibleControls(target.path);
  if (!data) return <p className="empty">{error ?? "Loading the file…"}</p>;

  const lines = splitLines(data.text ?? "");
  const painted = lines.slice(0, MAX_RENDERED_LINES);

  return (
    <section className="file-view" aria-label={`File: ${path}`}>
      <header className="file-head">
        <span className="file-path">{path}</span>
        <span>{count(data.size)} bytes</span>
        <span>Read-only</span>
      </header>
      {error !== null && <p className="note">{error}</p>}
      {data.binary ? (
        <p className="empty">Binary file: no text to show</p>
      ) : data.tooLarge ? (
        <p className="empty">This file is larger than 1 MiB and is not shown. Ask an agent about it.</p>
      ) : (
        <>
          {lines.length > painted.length && (
            <p className="note">
              Showing the first {count(MAX_RENDERED_LINES)} lines of {count(lines.length)}
            </p>
          )}
          <pre className="file">
            {painted.map((l, i) => (
              <div key={i} className="line" title={`Line ${i + 1}`}>
                <span className="ln" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="text">{visibleControls(stripAnsi(l))}</span>
              </div>
            ))}
          </pre>
        </>
      )}
    </section>
  );
}
