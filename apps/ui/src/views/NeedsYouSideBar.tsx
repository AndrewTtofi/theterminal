import { DecisionCard } from "../components/DecisionCard";
import { useShell } from "../shell/model";

export function NeedsYouSideBar() {
  const { model } = useShell();
  if (model.pending.length === 0) return <p className="empty">Nothing needs you right now.</p>;
  return (
    <ul className="needs-you-list">
      {model.pending.map((a) => (
        <li key={a.id}>
          <DecisionCard action={a} projectName={a.projectName} onDecide={model.onDecide} />
        </li>
      ))}
    </ul>
  );
}
