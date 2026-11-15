import { visibleControls } from "@theterminal/shared";
import { Board } from "../components/Board";
import { useShell } from "../shell/model";

/** The main area's home tab: the selected project's lifecycle board. A card's title opens its story tab. */
export function BoardView() {
  const { model, dock } = useShell();
  const { board, selectedId } = model;
  if (!board || !selectedId) return <p className="empty">Select or create a project.</p>;
  const openStory = (cardId: string) => {
    const card = Object.values(board.columns).flat().find((c) => c.id === cardId);
    dock()?.open(`story:${cardId}`, card ? visibleControls(card.title) : "Story", "main");
  };
  return (
    <div className="board-view">
      <h1>{board.project.name}</h1>
      <Board board={board} onAddCard={model.onAddCard} onMoveCard={model.onMoveCard} onOpenStory={openStory} />
    </div>
  );
}
