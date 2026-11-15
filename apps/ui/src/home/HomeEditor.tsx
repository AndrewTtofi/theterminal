import { useEffect, useId, useRef, useState } from "react";
import { HOME_BLOCK_LABELS, moveBlock, toggleBlock } from "./home-store";
import type { HomeBlockId, HomeLayout } from "./home-store";

/** `id` moved to `index`, one step at a time through `moveBlock`. */
export function moveBlockTo(l: HomeLayout, id: HomeBlockId, index: number): HomeLayout {
  let out = l;
  for (let guard = 0; guard < l.order.length; guard++) {
    const at = out.order.indexOf(id);
    if (at < 0 || at === index) break;
    out = moveBlock(out, id, at < index ? 1 : -1);
  }
  return out;
}

type Props = {
  draft: HomeLayout;
  onChange(l: HomeLayout): void;
  onDone(): void;
  onReset(): void;
};

/**
 * Edit Home, in place: turn blocks on or off (Needs your approval always shows), reorder them by dragging or with
 * Move up and Move down, and pick one or two columns for Working now. Done saves; Reset returns to the default.
 */
export function HomeEditor({ draft, onChange, onDone, onReset }: Props) {
  const [dragging, setDragging] = useState<HomeBlockId | null>(null);
  const [over, setOver] = useState<HomeBlockId | null>(null);
  const listId = useId();
  /** After a move, focus follows the button pressed to its block's new row. */
  const refocus = useRef<{ id: HomeBlockId; dir: "up" | "down" } | null>(null);
  const rowRefs = useRef(new Map<HomeBlockId, HTMLLIElement>());
  useEffect(() => {
    const r = refocus.current;
    if (!r) return;
    refocus.current = null;
    const row = rowRefs.current.get(r.id);
    const btn = row?.querySelector<HTMLButtonElement>(`button[data-move='${r.dir}']`);
    const other = row?.querySelector<HTMLButtonElement>(`button[data-move='${r.dir === "up" ? "down" : "up"}']`);
    (btn && !btn.disabled ? btn : other)?.focus();
  }, [draft]);

  const move = (id: HomeBlockId, dir: "up" | "down") => {
    refocus.current = { id, dir };
    onChange(moveBlock(draft, id, dir === "up" ? -1 : 1));
  };

  return (
    <div className="home-editor" role="group" aria-label="Edit Home">
      <p className="home-note">Turn blocks on or off and put them in the order you like. Drag a row, or use Move up and Move down.</p>
      <ul className="home-editor-list" id={listId} aria-label="Home blocks">
        {draft.order.map((id, i) => {
          const label = HOME_BLOCK_LABELS[id];
          const labelId = `${listId}-${id}`;
          const always = id === "approvals";
          return (
            <li
              key={id}
              ref={(el) => {
                if (el) rowRefs.current.set(id, el);
                else rowRefs.current.delete(id);
              }}
              aria-labelledby={labelId}
              className={`editor-row${dragging === id ? " dragging" : ""}${over === id && dragging !== id ? " drop-target" : ""}`}
              draggable
              onDragStart={(e) => {
                setDragging(id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", id);
              }}
              onDragOver={(e) => {
                if (dragging === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOver(id);
              }}
              onDragLeave={() => setOver((o) => (o === id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging !== null && dragging !== id) onChange(moveBlockTo(draft, dragging, draft.order.indexOf(id)));
                setDragging(null);
                setOver(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
            >
              <span className="drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>
              <label className="editor-label">
                <input
                  type="checkbox"
                  checked={always || !draft.hidden.includes(id)}
                  disabled={always}
                  title={always ? "Always shown" : undefined}
                  onChange={() => onChange(toggleBlock(draft, id))}
                />
                <span id={labelId}>{label}</span>
              </label>
              {always && <span className="editor-hint">Always shown</span>}
              <span className="editor-moves">
                <button type="button" className="quiet" data-move="up" aria-describedby={labelId} disabled={i === 0} onClick={() => move(id, "up")}>
                  Move up
                </button>
                <button
                  type="button"
                  className="quiet"
                  data-move="down"
                  aria-describedby={labelId}
                  disabled={i === draft.order.length - 1}
                  onClick={() => move(id, "down")}
                >
                  Move down
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <fieldset className="editor-columns">
        <legend>Working now columns</legend>
        {([1, 2] as const).map((n) => (
          <label key={n}>
            <input type="radio" name={`${listId}-columns`} checked={draft.workingColumns === n} onChange={() => onChange({ ...draft, workingColumns: n })} />
            {n}
          </label>
        ))}
      </fieldset>
      <div className="editor-actions">
        <button type="button" onClick={onDone}>
          Done
        </button>
        <button type="button" className="quiet" onClick={onReset}>
          Reset
        </button>
      </div>
    </div>
  );
}
