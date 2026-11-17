import { useId } from "react";
import type { PreviewPlan } from "@theterminal/shared";
import { visibleControls } from "@theterminal/shared";
import { Modal } from "../components/Modal";

type Props = {
  plan: PreviewPlan;
  /** Why the dialog is shown again (the agent changed what will run), or null. */
  notice: string | null;
  busy: boolean;
  onStart: () => void;
  onCancel: () => void;
};

const HEADINGS: Record<PreviewPlan["kind"], string> = {
  web: "Start the website preview",
  ios: "Run the app in the iPhone simulator",
  android: "Run the app in the Android emulator",
};

/** The person's own confirmation: the exact commands that will run, before anything runs. */
export function ConfirmPreviewDialog({ plan, notice, busy, onStart, onCancel }: Props) {
  const titleId = useId();
  return (
    <Modal labelledBy={titleId} onClose={onCancel} locked={busy} className="preview-confirm">
      <header className="modal-head">
        <h2 id={titleId}>{HEADINGS[plan.kind]}</h2>
      </header>
      <div className="modal-body">
        {notice && (
          <p className="modal-notice" role="alert">
            {notice}
          </p>
        )}
        <ul className="preview-commands" aria-label="Commands">
          {plan.display.map((line, i) => (
            <li key={i}>
              <pre>
                <code>{visibleControls(line)}</code>
              </pre>
            </li>
          ))}
        </ul>
        <p className="modal-note">This runs the project's own code on this computer.</p>
        <div className="modal-actions">
          <button type="button" className="quiet" onClick={onCancel} disabled={busy} data-autofocus>
            Cancel
          </button>
          <button type="button" onClick={onStart} disabled={busy}>
            Start
          </button>
        </div>
      </div>
    </Modal>
  );
}
