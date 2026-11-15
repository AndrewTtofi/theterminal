import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { INTAKE_IDEA_MAX, STAGES, visibleControls } from "@theterminal/shared";
import type { IntakeAnswer, IntakeQuestionView, IntakeView, ProposedCard } from "@theterminal/shared";
import { IntakeDecisionCard, shortDate } from "../components/IntakeDecisionCard";
import { useShell } from "../shell/model";
import type { WorkbenchModel } from "../shell/model";

export const PERMANENCE_NOTICE =
  "What you write here is recorded permanently in this project's ledger. Do not paste passwords, keys or other people's personal details.";

const stageLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Save = (answer: IntakeAnswer) => Promise<boolean>;

/**
 * The "Plan intake" dock tab: describe the idea, answer the questions, make the decisions, approve the plan.
 * When the step changes, focus moves to the tab's heading, unless the Owner is in an answer field: then the
 * answers stay open and the field keeps focus.
 */
export function IntakePanel(_props: { id: string }) {
  const { model } = useShell();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const answersRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const step = model.selectedId === null || model.intake === undefined ? undefined : (model.intake?.step ?? "describe");
  const last = useRef({ project: model.selectedId, step });
  useLayoutEffect(() => {
    const prev = last.current;
    last.current = { project: model.selectedId, step };
    if (prev.project !== model.selectedId) {
      setExpanded(false);
      return;
    }
    // A first load is not a step change; nor is a change the Owner did not make here.
    if (prev.step === undefined || step === undefined || prev.step === step) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && answersRef.current?.contains(active)) {
      setExpanded(true);
      return;
    }
    headingRef.current?.focus();
  });
  return (
    <section className="intake-panel" aria-label="Plan intake">
      <h2 ref={headingRef} tabIndex={-1}>Plan intake</h2>
      <IntakeBody model={model} answersRef={answersRef} expanded={expanded} onExpand={setExpanded} />
    </section>
  );
}

type BodyProps = {
  model: WorkbenchModel;
  answersRef: RefObject<HTMLDivElement>;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
};

function IntakeBody({ model, answersRef, expanded, onExpand }: BodyProps) {
  const intake = model.intake;
  if (model.selectedId === null) return <p className="empty">Choose a project to plan it.</p>;
  if (intake === undefined) return <p className="empty">Loading…</p>;
  if (intake === null) return <Describe onStart={model.onStartIntake} />;
  if (intake.step === "completed") return <Completed view={intake} onReopen={model.onReopenIntake} />;

  const step = intake.step;
  const decisions = intake.decisions.map((d) => <IntakeDecisionCard key={d.id} decision={d} onDecide={model.onDecideIntake} />);
  const shown = step === "answer" || expanded;
  // The answers keep one place in the tree at every step, so a field the Owner is in survives a step change.
  return (
    <>
      <p className="notice">{PERMANENCE_NOTICE}</p>
      <p className="idea">Your idea: {visibleControls(intake.intake.idea)}</p>
      {step === "decide" && (
        <>
          <h3>Decisions to make</h3>
          {decisions}
        </>
      )}
      {step === "approve" && <Approve view={intake} onComplete={model.onCompleteIntake} />}
      <div className="intake-change" ref={answersRef}>
        {step !== "answer" && (
          <button type="button" className="link" aria-expanded={expanded} onClick={() => onExpand(!expanded)}>
            Change your answers
          </button>
        )}
        <div hidden={!shown}>
          <Questions view={intake} model={model} />
          {step === "approve" && decisions}
        </div>
      </div>
      {step === "answer" && decisions.length > 0 && (
        <>
          <h3>Decisions to make</h3>
          {decisions}
        </>
      )}
    </>
  );
}

function Describe({ onStart }: { onStart: (idea: string) => Promise<boolean> }) {
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useId();
  const begin = async () => {
    const text = idea.trim();
    if (busy || !text) return;
    setBusy(true);
    try {
      if (await onStart(text)) setIdea("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="notice">{PERMANENCE_NOTICE}</p>
      <label htmlFor={id}>Describe your idea</label>
      <textarea id={id} value={idea} maxLength={INTAKE_IDEA_MAX} onChange={(e) => setIdea(e.target.value)} />
      <button type="button" disabled={busy || !idea.trim()} onClick={() => void begin()}>
        Begin
      </button>
    </>
  );
}

function Questions({ view, model }: { view: IntakeView; model: WorkbenchModel }) {
  const answered = view.questions.filter((q) => q.answer !== null).length;
  return (
    <div className="intake-questions">
      <p className="progress">{`${answered} of ${view.questions.length} answered`}</p>
      {view.questions.map((q) => (
        // Keyed by question only: a field is never remounted under the Owner, it takes up the recorded answer instead.
        <QuestionField key={q.id} q={q} onSave={(a) => model.onAnswerIntake(q.id, a)} />
      ))}
    </div>
  );
}

function QuestionField({ q, onSave }: { q: IntakeQuestionView; onSave: Save }) {
  const id = useId();
  const helpId = `${id}-help`;
  if (q.kind === "choice" || q.kind === "multi") {
    return (
      <fieldset className="intake-question" aria-describedby={helpId}>
        <legend>{q.label}</legend>
        <p className="help" id={helpId}>{q.help}</p>
        <Options q={q} onSave={onSave} />
      </fieldset>
    );
  }
  return (
    <div className="intake-question">
      <label htmlFor={id}>{q.label}</label>
      <p className="help" id={helpId}>{q.help}</p>
      {q.kind === "number" ? (
        <NumberInput id={id} helpId={helpId} q={q} onSave={onSave} />
      ) : (
        <TextInput id={id} helpId={helpId} q={q} onSave={onSave} />
      )}
    </div>
  );
}

type InputProps = { id: string; helpId: string; q: IntakeQuestionView; onSave: Save };

function TextInput({ id, helpId, q, onSave }: InputProps) {
  const recorded = typeof q.answer === "string" ? q.answer : "";
  const [draft, setDraft] = useState(recorded);
  const ref = useRef<HTMLTextAreaElement>(null);
  useTakeUp(recorded, ref, setDraft);
  const save = () => {
    const text = draft.trim();
    if (text === recorded.trim() || (q.required && text === "")) return;
    void onSave(text);
  };
  return (
    <>
      <textarea ref={ref} id={id} aria-describedby={helpId} value={draft} maxLength={q.max} onChange={(e) => setDraft(e.target.value)} onBlur={save} />
      <button type="button" onClick={save}>Save answer</button>
    </>
  );
}

function NumberInput({ id, helpId, q, onSave }: InputProps) {
  const recorded = typeof q.answer === "number" ? q.answer : null;
  const shownRecorded = recorded === null ? "" : String(recorded);
  const [draft, setDraft] = useState(shownRecorded);
  const ref = useRef<HTMLInputElement>(null);
  useTakeUp(shownRecorded, ref, setDraft);
  const save = () => {
    if (draft.trim() === "") return;
    const n = Number(draft);
    if (!Number.isFinite(n) || n === recorded) return;
    void onSave(n);
  };
  return (
    <>
      <input
        ref={ref} id={id} type="number" min="0" step="0.01" aria-describedby={helpId}
        value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={save}
      />
      <button type="button" onClick={save}>Save answer</button>
    </>
  );
}

/** Takes up a newly recorded answer, unless the Owner is typing in the field. */
function useTakeUp(recorded: string, ref: RefObject<HTMLElement>, setDraft: (v: string) => void): void {
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(recorded);
  }, [recorded]);
}

/** Radios for a choice, checkboxes for a list; each change is saved at once, and undone if the server refuses it. */
function Options({ q, onSave }: { q: IntakeQuestionView; onSave: Save }) {
  const [value, setValue] = useState<IntakeAnswer | null>(q.answer);
  const recorded = JSON.stringify(q.answer);
  useEffect(() => setValue(JSON.parse(recorded) as IntakeAnswer | null), [recorded]);
  const options = q.options ?? [];
  const save = async (next: IntakeAnswer) => {
    const before = value;
    setValue(next);
    if (!(await onSave(next))) setValue(before);
  };
  if (q.kind === "choice") {
    return (
      <ul className="intake-options">
        {options.map((o) => (
          <li key={o.id}>
            <label>
              <input type="radio" name={`intake-${q.id}`} checked={value === o.id} onChange={() => void save(o.id)} />
              {o.label}
            </label>
          </li>
        ))}
      </ul>
    );
  }
  const list = Array.isArray(value) ? value : [];
  const toggle = (id: string) => {
    const next = options.map((o) => o.id).filter((x) => (x === id ? !list.includes(x) : list.includes(x)));
    // A required list cannot be emptied: the server would refuse it.
    if (q.required && next.length === 0) return;
    void save(next);
  };
  return (
    <ul className="intake-options">
      {options.map((o) => (
        <li key={o.id}>
          <label>
            <input type="checkbox" checked={list.includes(o.id)} onChange={() => toggle(o.id)} />
            {o.label}
          </label>
        </li>
      ))}
    </ul>
  );
}

function PlanCards({ cards }: { cards: ProposedCard[] }) {
  const id = useId();
  return (
    <>
      <h4 id={id}>Cards this adds to the board</h4>
      <ul className="plan-cards" aria-labelledby={id}>
        {STAGES.filter((s) => cards.some((c) => c.stage === s)).map((s) => (
          <li key={s}>
            <span className="stage">{stageLabel(s)}</span>
            <ul>
              {cards.filter((c) => c.stage === s).map((c) => (
                <li key={c.title}>{visibleControls(c.title)}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </>
  );
}

function Approve({ view, onComplete }: { view: IntakeView; onComplete: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const plan = view.plan;
  if (!plan) return null;
  const approve = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onComplete();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="intake-plan">
      <h3>Your plan</h3>
      <p className="summary">{visibleControls(plan.summary)}</p>
      <PlanCards cards={plan.cards} />
      {plan.problem !== null && <p className="problem attention" role="alert">{visibleControls(plan.problem)}</p>}
      <button type="button" disabled={busy || plan.problem !== null} onClick={() => void approve()}>
        Approve plan
      </button>
      <p className="note">Approving records this plan in the ledger and adds the cards. You can reopen it later.</p>
    </div>
  );
}

function Completed({ view, onReopen }: { view: IntakeView; onReopen: (reason: string) => Promise<boolean> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useId();
  const reopen = async () => {
    const why = reason.trim();
    if (busy || !why) return;
    setBusy(true);
    try {
      if (await onReopen(why)) setReason("");
    } finally {
      setBusy(false);
    }
  };
  const summary = view.plan?.summary ?? view.intake.summary ?? "";
  return (
    <div className="intake-plan">
      <h3>Your plan</h3>
      <p className="summary">{visibleControls(summary)}</p>
      {view.intake.completedAt !== null && <p className="approved">{`Approved ${shortDate(view.intake.completedAt)}`}</p>}
      <p className="notice">{PERMANENCE_NOTICE}</p>
      <label htmlFor={id}>Why are you reopening?</label>
      <input id={id} value={reason} required maxLength={500} onChange={(e) => setReason(e.target.value)} />
      <button type="button" disabled={busy || !reason.trim()} onClick={() => void reopen()}>
        Reopen plan
      </button>
    </div>
  );
}
