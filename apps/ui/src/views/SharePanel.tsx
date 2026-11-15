import { useEffect, useId, useRef, useState } from "react";
import { visibleControls } from "@theterminal/shared";
import { ApiError, errorMessage } from "../api";
import { gateFor, roleOf, useShell } from "../shell/model";

const ACK = "I have read this page and I am happy to share everything on it.";

/** A preview the server no longer accepts: it changed, expired or is gone, so it must be made again. */
const isStale = (e: unknown) => e instanceof ApiError && (e.code === "preview_stale" || e.code === "preview_not_found");

/**
 * The share preview tab: the exact page that would be saved, in a frame with every sandbox restriction (no script,
 * no forms, no navigation, its own origin), and what the page leaves out. Nothing is saved until the Owner ticks
 * the acknowledgement and confirms.
 */
export function SharePanel(_props: { id: string }) {
  const { model } = useShell();
  const mayShare = gateFor(roleOf(model), "owner");
  const { preview, onConfirm } = model.share;
  const uid = useId();
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /**
   * The preview that is done with, hidden here at once whatever the model still holds: one the server refused as
   * stale, or one already saved (a second save needs a new preview, never the same previewId twice).
   */
  const [dropped, setDropped] = useState<string | null>(null);
  const previewId = preview?.previewId ?? null;
  const shownId = useRef(previewId);
  const savedRef = useRef<HTMLParagraphElement>(null);

  // The Confirm button that had focus unmounts with the preview: focus moves to the outcome, not to body.
  useEffect(() => {
    if (saved) savedRef.current?.focus();
  }, [saved]);

  // A new preview starts unread: the acknowledgement and the last outcome go. Clearing the preview after a save
  // keeps "Saved." on screen.
  useEffect(() => {
    if (shownId.current === previewId) return;
    shownId.current = previewId;
    setAck(false);
    if (previewId === null) return;
    setSaved(false);
    setError(null);
  }, [previewId]);

  const confirm = async () => {
    if (!ack || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      if (await onConfirm()) {
        setSaved(true);
        setAck(false);
        if (previewId !== null) setDropped(previewId);
      }
    } catch (e) {
      if (isStale(e) && previewId !== null) setDropped(previewId);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const shown = preview !== null && preview.previewId !== dropped ? preview : null;

  return (
    <section className="share-panel" aria-label="Share preview">
      {error !== null && (
        <p className="share-error" role="alert">
          {error}
        </p>
      )}
      {shown === null ? (
        <p className="empty">Choose what to include in the Share view and press Preview share page.</p>
      ) : (
        <>
          <h2>This is exactly what will be shared</h2>
          <p className="share-meta">
            {`${shown.bytes} bytes · hash ${shown.contentHash.slice(0, 12)} · preview expires ${new Date(shown.expiresAt).toLocaleTimeString()}`}
          </p>
          <div className="share-body">
            <iframe className="share-frame" title="Share page preview" sandbox="" srcDoc={shown.html} />
            <aside className="share-hidden" aria-labelledby={`${uid}-hidden`}>
              <h3 id={`${uid}-hidden`}>Not included</h3>
              <ul>
                {shown.snapshot.hidden.map((line, i) => (
                  <li key={i}>{visibleControls(line)}</li>
                ))}
              </ul>
            </aside>
          </div>
          <div className="share-confirm">
            <label>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              {ACK}
            </label>
            <button type="button" disabled={!ack || busy || mayShare.disabled} title={mayShare.title} onClick={() => void confirm()}>
              Confirm and save snapshot
            </button>
          </div>
        </>
      )}
      {saved && (
        <p className="share-saved" role="status" tabIndex={-1} ref={savedRef}>
          Saved. Open, download or share it from the Share view.
        </p>
      )}
    </section>
  );
}
