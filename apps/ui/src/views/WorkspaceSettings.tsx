import { useId } from "react";
import { useWorkspace } from "../shell/workspace-store";

/** Settings → Workspace: per-device choices about the shell. */
export function WorkspaceSettings() {
  const { showBoard, setShowBoard } = useWorkspace();
  const hintId = useId();
  return (
    <section className="appearance" aria-labelledby={`${hintId}-h`}>
      <h2 id={`${hintId}-h`}>Workspace</h2>
      <div className="field-row">
        <span id={`${hintId}-label`}>Show the Board</span>
        <button
          type="button"
          role="switch"
          aria-checked={showBoard}
          aria-labelledby={`${hintId}-label`}
          aria-describedby={hintId}
          className="switch"
          onClick={() => setShowBoard(!showBoard)}
        />
      </div>
      <p id={hintId} className="muted">Adds the Board to the activity bar. It stays off until you want it.</p>
    </section>
  );
}
