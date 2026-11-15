import { useEffect, useState } from "react";
import type { PendingAgentAction, RunChanges } from "@theterminal/shared";
import { errorMessage } from "../api";
import { DecisionCard } from "../components/DecisionCard";
import { DecisionContext } from "../components/DecisionContext";
import { GateCards } from "../components/GateCard";
import { IntakeNotices, intakeNotices } from "../components/IntakeNotices";
import { useShell } from "../shell/model";

/** A run's changes as the panel knows them: read, or a sentence said in their place (a live run's are not read). */
type Known = { changes: RunChanges } | { note: string };

/**
 * What the runs of `actions` have changed, read again whenever the set of actions changes (the model remembers
 * reads for 10 s). A refusal, such as 409 run_active while the run is live, becomes its sentence.
 */
function useRunChanges(actions: PendingAgentAction[]): Record<string, Known> {
  const { model } = useShell();
  const { runChanges } = model;
  const [known, setKnown] = useState<Record<string, Known>>({});
  const key = actions.map((a) => `${a.id}:${a.runId}`).join("|");
  useEffect(() => {
    let cancelled = false;
    const runIds = new Set(key === "" ? [] : key.split("|").map((k) => k.slice(k.indexOf(":") + 1)));
    for (const runId of runIds) {
      runChanges(runId).then(
        (changes) => !cancelled && setKnown((k) => ({ ...k, [runId]: { changes } })),
        (e: unknown) => !cancelled && setKnown((k) => ({ ...k, [runId]: { note: errorMessage(e, "changes") } })),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [key, runChanges]);
  return known;
}

/**
 * The Needs-you tab: everything waiting on the Owner, with room to explain it. Each pending action of every project
 * as its card with the proposed change, what the agent said before asking and what its run has changed (the last
 * two only for the selected project, whose stream is loaded); the gates of a stopped move; plans waiting on
 * decisions.
 */
export function NeedsYouPanel() {
  const { model, showView, stripShown } = useShell();
  const notices = intakeNotices(model);
  const local = (a: PendingAgentAction) => a.projectId === model.selectedId;
  const known = useRunChanges(model.pending.filter(local));
  const empty = model.pending.length === 0 && model.gate === null && notices.length === 0;

  const seeChanges = (runId: string) => {
    model.onSelectChangesRun(runId);
    showView("changes");
  };

  return (
    <section className="needs-you-panel" aria-label="Everything that needs you">
      {empty && <p className="empty">Nothing needs you right now.</p>}
      {model.pending.length > 0 && (
        <>
          <h2>Decisions</h2>
          <ul className="needs-you-list">
            {model.pending.map((a) => {
              const k = local(a) ? known[a.runId] : undefined;
              return (
                <li key={a.id}>
                  <DecisionCard action={a} projectName={a.projectName} onDecide={model.onDecide} readOnly={stripShown} />
                  <DecisionContext
                    action={a}
                    entries={local(a) ? model.projectEntries : null}
                    changes={k && "changes" in k ? k.changes : null}
                    changesNote={k && "note" in k ? k.note : null}
                    onSeeChanges={seeChanges}
                  />
                  {!local(a) && (
                    <p className="note">
                      <span>Open this project to see more context</span>{" "}
                      <button type="button" onClick={() => model.onSelectProject(a.projectId)}>
                        Open project
                      </button>
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {model.gate !== null && (
        <>
          <h2>Gates</h2>
          {/* While the strip shows the same prompt, this copy is read-only so the move is decided once; it never takes focus. */}
          <GateCards
            key={`${model.gate.cardId}:${model.gate.to}`}
            gate={model.gate}
            onResolve={model.onResolveGate}
            onCancel={model.onCancelGate}
            readOnly={stripShown}
            autoFocus={false}
          />
        </>
      )}
      {notices.length > 0 && (
        <>
          <h2>Plan</h2>
          <IntakeNotices notices={notices} />
        </>
      )}
    </section>
  );
}
