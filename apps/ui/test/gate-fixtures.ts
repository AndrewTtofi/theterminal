import { GATES } from "@theterminal/shared";
import type { GateEvaluation, GateId } from "@theterminal/shared";

/** A gate evaluation built from the catalog: `unmet` lists the condition labels left unmet. */
export function evaluation(id: GateId, conditions: { label: string; met: boolean; detail?: string }[]): GateEvaluation {
  const def = GATES.find((g) => g.id === id)!;
  const met = conditions.every((c) => c.met);
  return {
    id: def.id,
    title: def.title,
    explanation: def.explanation,
    risks: def.risks,
    learn: def.learn,
    acknowledgement: def.acknowledgement,
    signOff: def.signOff,
    conditions: conditions.map((c, i) => ({
      id: (["intake_completed", "no_pending_actions", "no_running_runs_on_card"] as const)[i % 3]!,
      label: c.label,
      met: c.met,
      detail: c.detail ?? null,
    })),
    met,
    outcome: !met ? "blocked" : def.signOff ? "needs_sign_off" : "pass",
  };
}

export const planBlocked = () => evaluation("plan_approved", [{ label: "The plan has been approved", met: false }]);
export const planPassed = () => evaluation("plan_approved", [{ label: "The plan has been approved", met: true }]);
export const shipMet = () =>
  evaluation("ready_to_ship", [
    { label: "The plan has been approved", met: true },
    { label: "No agent is waiting for a decision in this project", met: true },
    { label: "No agent is still working on this card", met: true },
  ]);
export const shipBlocked = () =>
  evaluation("ready_to_ship", [
    { label: "The plan has been approved", met: false },
    { label: "No agent is waiting for a decision in this project", met: true, detail: "0 waiting" },
    { label: "No agent is still working on this card", met: true },
  ]);
