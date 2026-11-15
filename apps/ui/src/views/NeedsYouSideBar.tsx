import { DecisionCard } from "../components/DecisionCard";
import { IntakeNotices, intakeNotices } from "../components/IntakeNotices";
import { useShell } from "../shell/model";

export function NeedsYouSideBar() {
  const { model } = useShell();
  const notices = intakeNotices(model);
  if (model.pending.length === 0 && notices.length === 0) return <p className="empty">Nothing needs you right now.</p>;
  return (
    <>
      <IntakeNotices notices={notices} />
      <ul className="needs-you-list">
        {model.pending.map((a) => (
          <li key={a.id}>
            <DecisionCard action={a} projectName={a.projectName} {...(a.machineName !== undefined && { machineName: a.machineName })} onDecide={model.onDecide} />
          </li>
        ))}
      </ul>
    </>
  );
}
