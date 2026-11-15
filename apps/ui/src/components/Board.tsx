import { useState } from "react";
import { STAGES, visibleControls } from "@theterminal/shared";
import type { Board as BoardData, Stage } from "@theterminal/shared";

type Props = {
  board: BoardData;
  onAddCard: (stage: Stage, title: string) => void;
  /** Moves through the readiness gates; a gated move waits in the Needs-you strip. */
  onMoveCard: (cardId: string, to: Stage) => Promise<void> | void;
  onOpenStory?: (cardId: string) => void;
};

/** "ship" → "Ship". */
export const stageLabel = (s: Stage) => s.charAt(0).toUpperCase() + s.slice(1);
const label = stageLabel;

function AddCard({ stage, onAdd }: { stage: Stage; onAdd: (stage: Stage, title: string) => void }) {
  const [title, setTitle] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const t = title.trim();
        if (!t) return;
        onAdd(stage, t);
        setTitle("");
      }}
    >
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="+ Add"
        aria-label={`Add card to ${label(stage)}`}
      />
    </form>
  );
}

export function Board({ board, onAddCard, onMoveCard, onOpenStory }: Props) {
  return (
    <div className="board">
      {STAGES.map((stage) => (
        <section key={stage} className="column" aria-label={label(stage)}>
          <h3>{label(stage)}</h3>
          {board.columns[stage].map((card) => (
            <div key={card.id} className="card">
              <span className={`dot ${card.status}`} title={card.status} role="img" aria-label={card.status} />
              <button
                type="button"
                className="card-title"
                aria-label={`Open the story of ${visibleControls(card.title)}`}
                onClick={() => onOpenStory?.(card.id)}
              >
                {visibleControls(card.title)}
              </button>
              <select
                aria-label={`Move ${card.title} to`}
                value=""
                onChange={(e) => {
                  if (e.target.value) void onMoveCard(card.id, e.target.value.toLowerCase() as Stage);
                }}
              >
                <option value="">Move to…</option>
                {STAGES.filter((s) => s !== stage).map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <AddCard stage={stage} onAdd={onAddCard} />
        </section>
      ))}
    </div>
  );
}
