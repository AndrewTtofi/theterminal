import { forwardRef, useCallback, useEffect, useId, useRef, useState } from "react";
import { COMMENT_LIMITS, atLeast, commentStateLabel, innerEntry, visibleControls } from "@theterminal/shared";
import type { Card, CardComment, CardInfo, LedgerEntry } from "@theterminal/shared";
import { api, errorMessage } from "../api";
import { useShell, useViewerRole } from "../shell/model";
import { ProgressBar, StepChecklist } from "./ProgressBar";
import "./board.css";

type Props = { card: Card; info: CardInfo | null; onClose: () => void };

/** "10:42" today, else "16 Nov, 10:42". */
function when(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

/** True for an entry about this card's notes: one left, given to a run, or read by it. */
function aboutNotes(e: LedgerEntry, cardId: string): boolean {
  const inner = innerEntry(e);
  if (!inner.type.startsWith("card.comment")) return false;
  return (inner.payload as { cardId?: unknown } | undefined)?.cardId === cardId;
}

/**
 * A card's side panel inside the Board tab: its latest run's bar and checklist, the full story, the run's preview when
 * it offered one, and the notes left for the agent, with the box to leave another (maintainers and above).
 */
export const CardPanel = forwardRef<HTMLElement, Props>(function CardPanel({ card, info, onClose }, ref) {
  const { model, dock } = useShell();
  const role = useViewerRole();
  const mayNote = atLeast(role, "maintainer");
  const title = visibleControls(card.title);
  const notesId = useId();
  const boxId = useId();

  const [notes, setNotes] = useState<CardComment[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const gen = useRef(0);
  const load = useCallback(async () => {
    const mine = ++gen.current;
    try {
      const { comments } = await api.cardComments(card.id);
      if (mine !== gen.current) return;
      setNotes(comments);
      setLoadError(false);
    } catch {
      if (mine === gen.current) setLoadError(true);
    }
  }, [card.id]);

  useEffect(() => {
    setNotes([]);
    setLoadError(false);
    setText("");
    setSendError(null);
    void load();
    const off = model.subscribeEntries?.((e) => {
      if (aboutNotes(e, card.id)) void load();
    });
    return () => {
      gen.current++;
      off?.();
    };
  }, [card.id, load, model.subscribeEntries]);

  const runs = [...(model.home?.data?.working ?? []), ...(model.home?.data?.finishedToday ?? [])];
  const offered = info?.runId != null && (runs.find((h) => h.run.id === info.runId)?.offers?.length ?? 0) > 0;

  const send = async () => {
    const t = text.trim();
    if (t === "" || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setSendError(null);
    try {
      const added = await api.addCardComment(card.id, t);
      setNotes((list) => (list.some((n) => n.id === added.id) ? list : [...list, added]));
      setText("");
      model.cardInfos?.refresh();
    } catch (e) {
      setSendError(errorMessage(e));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  return (
    <aside className="card-panel" aria-label="Card" tabIndex={-1} ref={ref}>
      <header className="card-panel-head">
        <span>Card</span>
        <button type="button" className="card-panel-close" aria-label="Close the card" onClick={onClose}>
          ×
        </button>
      </header>
      <section className="card-panel-sec">
        <p className="card-panel-title">{title}</p>
        <ProgressBar compact percent={info?.percent ?? null} label={`${title} progress`} />
        {info?.progress && <StepChecklist progress={info.progress} />}
        <div className="card-panel-actions">
          <button type="button" className="card-panel-link" onClick={() => dock()?.open(`story:${card.id}`, title, "main")}>
            Open the full story
          </button>
          {offered && info?.runId != null && (
            <button type="button" className="ghost" onClick={() => model.openPreview(info.runId!)}>
              Preview
            </button>
          )}
        </div>
      </section>
      <section className="card-panel-sec card-panel-notes">
        <h4 id={notesId}>Notes</h4>
        {loadError && <p className="card-panel-hint">The notes could not be loaded.</p>}
        {!loadError && notes.length === 0 && <p className="card-panel-hint">No notes yet.</p>}
        {notes.length > 0 && (
          <ul aria-labelledby={notesId}>
            {notes.map((n) => {
              const who = model.me?.name !== undefined && n.authorName === model.me.name ? "You" : visibleControls(n.authorName);
              return (
                <li key={n.id}>
                  <p>{visibleControls(n.text)}</p>
                  <small>
                    {who} · <span className="num">{when(n.at)}</span> ·{" "}
                    <span className={n.state === "read" ? "ok" : n.state === "waiting" ? "attention" : ""}>{commentStateLabel(n)}</span>
                  </small>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="card-panel-sec">
        {mayNote ? (
          <form
            className="card-panel-compose"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label className="visually-hidden" htmlFor={boxId}>
              Say something about this
            </label>
            <textarea
              id={boxId}
              placeholder="Say something about this…"
              maxLength={COMMENT_LIMITS.textChars}
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="card-panel-send">
              <span className="num">
                {text.length}/{COMMENT_LIMITS.textChars}
              </span>
              <button type="submit" disabled={sending || text.trim() === ""}>
                Send
              </button>
            </div>
            {sendError !== null && (
              <p className="card-panel-error" role="alert">
                {sendError}
              </p>
            )}
          </form>
        ) : (
          <p className="card-panel-hint">Notes are for maintainers and above.</p>
        )}
      </section>
    </aside>
  );
});
