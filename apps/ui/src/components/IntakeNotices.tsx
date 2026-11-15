import { plural, visibleControls } from "@theterminal/shared";
import { useShell } from "../shell/model";
import type { WorkbenchModel } from "../shell/model";

export type IntakeNotice = { projectId: string; decisions: number; text: string };

/**
 * Plans waiting on the Owner: the selected project's from its loaded intake, every other project's from the
 * server's status. Each says how many decisions are open.
 */
export function intakeNotices(model: Pick<WorkbenchModel, "selectedId" | "intake" | "status">): IntakeNotice[] {
  const out: IntakeNotice[] = [];
  const intake = model.intake;
  if (model.selectedId !== null && intake?.step === "decide") {
    const n = intake.decisions.filter((d) => d.chosen === null).length;
    if (n > 0) out.push({ projectId: model.selectedId, decisions: n, text: `Your plan needs ${plural(n, "decision")}` });
  }
  for (const p of model.status?.intakeProjects ?? []) {
    if (p.projectId === model.selectedId || p.decisions <= 0) continue;
    out.push({ projectId: p.projectId, decisions: p.decisions, text: `The plan for ${visibleControls(p.name)} needs ${plural(p.decisions, "decision")}` });
  }
  return out;
}

/** One notice per plan waiting on the Owner, each opening that project's Plan intake tab. */
export function IntakeNotices({ notices }: { notices: IntakeNotice[] }) {
  const { model, dock } = useShell();
  const open = (projectId: string) => {
    if (projectId !== model.selectedId) model.onSelectProject(projectId);
    dock()?.focus("intake");
  };
  return (
    <>
      {notices.map((n) => (
        <div key={n.projectId} className="needs-you-item">
          <span>{n.text}</span>
          <button type="button" onClick={() => open(n.projectId)}>
            Open intake
          </button>
        </div>
      ))}
    </>
  );
}
