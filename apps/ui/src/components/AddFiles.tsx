import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { plural, visibleControls } from "@theterminal/shared";
import type { ImportResult } from "@theterminal/shared";
import { ApiError } from "../api";
import { collectDropped, filesFromInput, formatBytes, isAbort, precheck, skipReason, sourcesMessage, uploadFiles } from "../upload";
import type { PickedFile } from "../upload";
import { clip } from "./text";
import "./sources.css";

/** How many skipped names a result lists. */
const SKIPPED_SHOWN = 50;

export type UploadState =
  | { phase: "idle" }
  /** Refused before sending (or by the server): `secrets` when ticking the box would let the files through. */
  | { phase: "refused"; files: PickedFile[]; message: string; secrets: boolean }
  | { phase: "sending"; sent: number; total: number }
  | { phase: "done"; result: ImportResult }
  | { phase: "cancelled" };

/**
 * One upload at a time into a project: checks first, then streams the files one by one with the progress counted in
 * files. Unmounting cancels an upload in flight.
 */
export function useUpload(onDone?: (r: ImportResult) => void) {
  const [state, setState] = useState<UploadState>({ phase: "idle" });
  const ctl = useRef<AbortController | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => () => ctl.current?.abort(), []);

  const start = useCallback(async (projectId: string, files: PickedFile[], includeSecrets: boolean): Promise<ImportResult | null> => {
    if (ctl.current) return null;
    const checked = precheck(files, includeSecrets);
    if (!checked.ok) {
      setState({ phase: "refused", files, message: checked.message, secrets: checked.secrets !== undefined });
      return null;
    }
    const c = new AbortController();
    ctl.current = c;
    setState({ phase: "sending", sent: 0, total: files.length });
    try {
      const result = await uploadFiles(projectId, files, includeSecrets, (sent, total) => {
        if (!c.signal.aborted) setState({ phase: "sending", sent, total });
      }, c.signal);
      setState({ phase: "done", result });
      done.current?.(result);
      return result;
    } catch (e) {
      if (isAbort(e) || c.signal.aborted) setState({ phase: "cancelled" });
      else {
        const secrets = e instanceof ApiError && e.code === "possible_secrets";
        setState({ phase: "refused", files, message: sourcesMessage(e), secrets });
      }
      return null;
    } finally {
      ctl.current = null;
    }
  }, []);

  const cancel = useCallback(() => ctl.current?.abort(), []);
  const clear = useCallback(() => setState({ phase: "idle" }), []);
  return { state, start, cancel, clear };
}

/** The tick box every import offers. */
export function SecretsTick({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="secrets-tick">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>include files that may contain secrets</span>
    </label>
  );
}

/** A determinate bar for the files sent so far. */
export function SendProgress({ sent, total, onCancel }: { sent: number; total: number; onCancel?: () => void }) {
  const percent = total === 0 ? 0 : Math.floor((100 * sent) / total);
  const label = `Sending ${sent} of ${total} files`;
  return (
    <div className="send-progress">
      <div className="send-progress-head">
        <span role="status" aria-live="polite">{sent >= total ? `Sent ${plural(total, "file")}, saving…` : label}</span>
        <span className="send-progress-pct" aria-hidden="true">{percent}%</span>
      </div>
      <div className="send-track" role="progressbar" aria-label="Files sent" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="send-fill" style={{ width: `${percent}%` }} />
      </div>
      {onCancel && (
        <button type="button" className="quiet" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}

/** What an import added and what it left out (the first 50 names, with why). */
export function ImportSummary({ result, verb }: { result: ImportResult; verb: "Added" | "Copied in" }) {
  return (
    <div className="import-summary" role="status">
      <p className="import-done">
        <span className="import-tick" aria-hidden="true">✓</span>
        {`${verb} ${plural(result.files, "file")} (${formatBytes(result.bytes)}).`}
      </p>
      {result.skippedCount > 0 && (
        <>
          <p className="import-skipped-line">{`Left out ${plural(result.skippedCount, "file")}:`}</p>
          <ul className="import-skipped">
            {result.skipped.slice(0, SKIPPED_SHOWN).map((s) => (
              <li key={s.path}>
                <code>{clip(visibleControls(s.path), 160)}</code> <span>{skipReason(s.reason)}</span>
              </li>
            ))}
            {result.skippedCount > Math.min(result.skipped.length, SKIPPED_SHOWN) && (
              <li className="more">and {result.skippedCount - Math.min(result.skipped.length, SKIPPED_SHOWN)} more</li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}

/** "Choose files…" and "Choose a folder…": real file inputs inside labels, so the keyboard reaches them as is. */
export function FilePickers({ onPicked, disabled }: { onPicked: (files: PickedFile[]) => void; disabled?: boolean }) {
  const folderProps = { webkitdirectory: "", directory: "" } as Record<string, string>;
  const take = (input: HTMLInputElement) => {
    if (input.files && input.files.length > 0) onPicked(filesFromInput(input.files));
    input.value = "";
  };
  return (
    <span className="file-pickers">
      <label className={`pick-button${disabled ? " disabled" : ""}`}>
        <input type="file" multiple className="visually-hidden" aria-label="Choose files" disabled={disabled} onChange={(e) => take(e.currentTarget)} />
        <span aria-hidden="true">Choose files…</span>
      </label>
      <label className={`pick-button${disabled ? " disabled" : ""}`}>
        <input type="file" multiple className="visually-hidden" aria-label="Choose a folder" disabled={disabled} onChange={(e) => take(e.currentTarget)} {...folderProps} />
        <span aria-hidden="true">Choose a folder…</span>
      </label>
    </span>
  );
}

/** A dashed area that takes dropped files and folders; its children are the pickers and any status. */
export function DropArea({ onDropped, disabled, hint, children }: { onDropped: (files: PickedFile[]) => void; disabled?: boolean; hint: string; children?: ReactNode }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const accepts = (e: DragEvent) => !disabled && Array.from(e.dataTransfer?.types ?? []).includes("Files");
  return (
    <div
      className={`drop-area${over ? " over" : ""}${disabled ? " disabled" : ""}`}
      onDragEnter={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        depth.current = 0;
        setOver(false);
        if (disabled) return;
        e.preventDefault();
        void collectDropped(e.dataTransfer.items).then((files) => files.length > 0 && onDropped(files));
      }}
    >
      <p className="drop-hint">{hint}</p>
      {children}
    </div>
  );
}

/** The state of an upload under a drop area or the ask box: the refusal (with the tick box), the bar, or the result. */
export function UploadStatus({ upload, onRetry, verb = "Added" }: {
  upload: ReturnType<typeof useUpload>;
  onRetry: (files: PickedFile[], includeSecrets: boolean) => void;
  verb?: "Added" | "Copied in";
}) {
  const { state } = upload;
  const [tick, setTick] = useState(false);
  useEffect(() => {
    if (state.phase !== "refused") setTick(false);
  }, [state.phase]);
  switch (state.phase) {
    case "idle":
      return null;
    case "sending":
      return <SendProgress sent={state.sent} total={state.total} onCancel={upload.cancel} />;
    case "cancelled":
      return (
        <p className="upload-note" role="status">
          Cancelled. Nothing was added.{" "}
          <button type="button" className="link" onClick={upload.clear}>
            Dismiss
          </button>
        </p>
      );
    case "done":
      return (
        <div className="upload-result">
          <ImportSummary result={state.result} verb={verb} />
          <button type="button" className="link" onClick={upload.clear}>
            Dismiss
          </button>
        </div>
      );
    case "refused":
      return (
        <div className="upload-refused">
          <p role="alert">{state.message}</p>
          <div className="upload-refused-actions">
            {state.secrets && (
              <>
                <SecretsTick checked={tick} onChange={setTick} />
                <button type="button" disabled={!tick} onClick={() => onRetry(state.files, true)}>
                  Add them
                </button>
              </>
            )}
            <button type="button" className="quiet" onClick={upload.clear}>
              {state.secrets ? "Not now" : "Dismiss"}
            </button>
          </div>
        </div>
      );
  }
}
