import { visibleControls } from "@theterminal/shared";
import { Board } from "../components/Board";
import { spendLine } from "../components/cost";
import { useShell } from "../shell/model";

export { spendLine };

/**
 * The main area's home tab: the selected project's lifecycle board, with what its agents have cost in the header.
 * A card's title opens its story tab.
 */
export function BoardView() {
  const { model, dock } = useShell();
  const { board, selectedId } = model;
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
  const openStory = (cardId: string) => {
    const card = Object.values(board.columns).flat().find((c) => c.id === cardId);
    dock()?.open(`story:${cardId}`, card ? visibleControls(card.title) : "Story", "main");
  };
  return (
    <div className="board-view">
      <header className="board-head">
        <h1>{board.project.name}</h1>
        <p className="spend">{spendLine(model.runs)}</p>
      </header>
      <Board board={board} onAddCard={model.onAddCard} onMoveCard={model.onMoveCard} onOpenStory={openStory} />
    </div>
  );
}
