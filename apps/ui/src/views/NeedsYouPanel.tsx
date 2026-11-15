import { useEffect, useState } from "react";
import type { PendingAgentAction, RunChanges } from "@theterminal/shared";
import { LIVE_RUN_CHANGES, errorMessage } from "../api";
import { DecisionCard } from "../components/DecisionCard";
import { DecisionContext } from "../components/DecisionContext";
import { GateCards } from "../components/GateCard";
import { IntakeNotices, intakeNotices } from "../components/IntakeNotices";
import { runIsLive, useShell } from "../shell/model";

/** A run's changes as the panel knows them: read, or a sentence said in their place (a live run's are not read). */
type Known = { changes: RunChanges } | { note: string };

/**
 * What the runs of `actions` have changed, read again whenever the set of actions changes (the model remembers
 * reads for 10 s). A run the runs list says is live is not asked about: the server refuses to read a live run's
 * working copy, and a pending decision's run is live until it stops, so its changes show once it has stopped or
 * finished. Any other refusal becomes its sentence.
 */
function useRunChanges(actions: PendingAgentAction[]): Record<string, Known> {
  const { model } = useShell();
  const { runChanges, runs } = model;
  const [known, setKnown] = useState<Record<string, Known>>({});
  const live = (runId: string) => runIsLive(runs, runId);
  const asked = [...new Set(actions.map((a) => a.runId))].filter((r) => !live(r));
  const key = asked.join("|");
  useEffect(() => {
    let cancelled = false;
    for (const runId of key === "" ? [] : key.split("|")) {
      runChanges(runId).then(
        (changes) => !cancelled && setKnown((k) => ({ ...k, [runId]: { changes } })),
        (e: unknown) => !cancelled && setKnown((k) => ({ ...k, [runId]: { note: errorMessage(e, "changes") } })),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [key, runChanges]);
  const out: Record<string, Known> = {};
  for (const a of actions) {
    if (live(a.runId)) out[a.runId] = { note: LIVE_RUN_CHANGES };
    else if (known[a.runId]) out[a.runId] = known[a.runId]!;
  }
  return out;
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
