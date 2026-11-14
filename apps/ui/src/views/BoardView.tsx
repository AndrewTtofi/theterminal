import { Board } from "../components/Board";
import { useShell } from "../shell/model";

/** The main area's home tab: the selected project's lifecycle board. */
export function BoardView() {
  const { model } = useShell();
  const { board, selectedId } = model;
  if (!board || !selectedId) return <p className="empty">Select or create a project.</p>;
  return (
    <div className="board-view">
      <h1>{board.project.name}</h1>
      <Board board={board} onAddCard={model.onAddCard} onMoveCard={model.onMoveCard} />
    </div>
  );
}
