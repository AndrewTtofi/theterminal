import { useEffect, useRef, useState } from "react";
import { Board } from "../components/Board";
import { CardPanel } from "../components/CardPanel";
import { spendLine } from "../components/cost";
import { useShell } from "../shell/model";

export { spendLine };

/**
 * The main area's home tab: the selected project's board, run by agents, with what they have cost in the header.
 * Clicking a card opens its panel beside the columns; Escape closes it and puts focus back on the card (but not while
 * a note is being written, so the draft is never lost).
 */
export function BoardView() {
  const { model } = useShell();
  const { board, selectedId } = model;
  const [openId, setOpenId] = useState<string | null>(null);
  const cards = useRef(new Map<string, HTMLButtonElement>());
  const panel = useRef<HTMLElement>(null);

  // A new project starts with the panel closed.
  useEffect(() => setOpenId(null), [selectedId]);
  // Move focus into the panel when it opens on a card, so the keyboard follows the click.
  useEffect(() => {
    if (openId !== null) panel.current?.focus();
  }, [openId]);

  if (!board || !selectedId) {
    return (
      <div className="welcome">
        <p className="wordmark" role="img" aria-label="The Terminal">
          THE <span className="accent">TERMINAL</span>
        </p>
        <p className="welcome-line">Start by opening a project.</p>
      </div>
    );
  }

  const open = openId === null ? null : (Object.values(board.columns).flat().find((c) => c.id === openId) ?? null);
  const close = () => {
    const id = openId;
    setOpenId(null);
    if (id !== null) cards.current.get(id)?.focus();
  };
  const infos = model.cardInfos?.data ?? {};

  return (
    <div
      className="board-view agent-board-view"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open !== null) {
          // Escape while a note is being written keeps the panel and the draft; it closes once the box is empty.
          const target = e.target;
          if (target instanceof HTMLTextAreaElement && target.value !== "") return;
          e.stopPropagation();
          close();
        }
      }}
    >
      <header className="board-head">
        <h1>{board.project.name}</h1>
        <p className="spend">{spendLine(model.runs)}</p>
        <p className="board-note">Cards are managed by agents · click a card to leave a note</p>
      </header>
      <div className="agent-board-body">
        <Board
          board={board}
          infos={infos}
          selectedId={open?.id ?? null}
          onOpen={setOpenId}
          cardRef={(id, el) => {
            if (el) cards.current.set(id, el);
            else cards.current.delete(id);
          }}
        />
        {open !== null && <CardPanel ref={panel} card={open} info={infos[open.id] ?? null} onClose={close} />}
      </div>
    </div>
  );
}
