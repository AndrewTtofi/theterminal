import { plural } from "@theterminal/shared";
import type { IntakeView } from "@theterminal/shared";
import { shortDate } from "../components/IntakeDecisionCard";
import { ProjectList } from "../components/ProjectList";
import { useShell } from "../shell/model";

/** The selected project's plan in one line; null while its intake loads. */
export function planStateLine(intake: IntakeView | null | undefined): string | null {
  if (intake === undefined) return null;
  if (intake === null) return "Plan: not started";
  switch (intake.step) {
    case "answer":
      return `Plan: ${intake.questions.filter((q) => q.answer !== null).length} of ${intake.questions.length} questions answered`;
    case "decide":
      return `Plan: ${plural(intake.decisions.filter((d) => d.chosen === null).length, "decision")} to make`;
    case "approve":
      return "Plan: ready to approve";
    case "completed":
      return `Plan: approved${intake.intake.completedAt === null ? "" : ` ${shortDate(intake.intake.completedAt)}`}`;
  }
}

export function ProjectsSideBar() {
  const { model, dock } = useShell();
  const line = planStateLine(model.intake);
  return (
    <>
      <ProjectList
        projects={model.projects}
        selectedId={model.selectedId}
        onSelect={model.onSelectProject}
        onCreate={model.onCreateProject}
        onCreated={model.onProjectCreated}
      />
      {model.selectedId !== null && (
        <div className="plan-state">
          {line !== null && <p>{line}</p>}
          <button type="button" onClick={() => dock()?.focus("intake")}>
            Plan intake
          </button>
        </div>
      )}
    </>
  );
}
