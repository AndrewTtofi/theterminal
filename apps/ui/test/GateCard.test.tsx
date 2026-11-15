import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GATES } from "@theterminal/shared";
import type { GateEvaluation } from "@theterminal/shared";
import { GateCards } from "../src/components/GateCard";
import { ShellContext } from "../src/shell/model";
import type { GatePrompt, ShellContextValue, WorkbenchModel } from "../src/shell/model";
import { fakeDock, shellNav } from "./connections-harness";
import { planPassed, shipBlocked, shipMet } from "./gate-fixtures";

const ACK = GATES.find((g) => g.id === "ready_to_ship")!.acknowledgement;

function setup(evaluations: GateEvaluation[], over: Partial<GatePrompt> = {}) {
  const gate: GatePrompt = {
    cardId: "c1", cardTitle: "Login", to: "ship", evaluations, note: null, revision: 0, refreshing: false, ...over,
  };
  const onResolve = vi.fn().mockResolvedValue(true);
  const onCancel = vi.fn();
  const ui = (g: GatePrompt) => <GateCards gate={g} onResolve={onResolve} onCancel={onCancel} />;
  const r = render(ui(gate));
  /** Shows the prompt again with changes, as App does after a refresh. */
  const show = (more: Partial<GatePrompt>) => r.rerender(ui({ ...gate, ...more }));
  return { onResolve, onCancel, gate, show, ...r };
}

const card = (title: string) => screen.getByRole("article", { name: `Gate: ${title}` });
const moveButton = () => screen.getByRole("button", { name: 'Move "Login" to Ship' }) as HTMLButtonElement;

describe("GateCards", () => {
  it("shows a blocked gate with its checklist, risks and lesson, and waives it with a reason and the sentence", async () => {
    const { onResolve } = setup([shipBlocked()]);
    const c = card("Ready to ship");
    expect(c.textContent).toContain('Moving "Login" to Ship');
    expect(c.textContent).toContain(GATES.find((g) => g.id === "ready_to_ship")!.explanation);
    expect(within(c).getByRole("heading", { name: "Risks" })).toBeTruthy();
    expect(within(c).getAllByRole("listitem").length).toBeGreaterThan(3);
    expect(within(c).getByRole("heading", { name: "What this means" })).toBeTruthy();

    const unmet = within(c).getByRole("img", { name: "unmet" });
    expect(unmet.textContent).toBe("✗");
    expect(unmet.parentElement!.textContent).toContain("The plan has been approved");
    expect(within(c).getAllByRole("img", { name: "met" })[0]!.textContent).toBe("✓");
    expect(c.textContent).toContain("0 waiting");

    expect(within(c).queryByRole("button", { name: "Sign off" })).toBeNull();
    const waive = within(c).getByRole("button", { name: "Waive" }) as HTMLButtonElement;
    expect(waive.disabled).toBe(true);
    expect(moveButton().disabled).toBe(true);

    const reason = within(c).getByLabelText("Why are you proceeding anyway?");
    expect(within(c).getByText("At least 10 characters")).toBeTruthy();
    await userEvent.type(reason, "short");
    await userEvent.click(within(c).getByRole("checkbox", { name: ACK }));
    expect(waive.disabled).toBe(true);
    await userEvent.type(reason, " but needed now");
    expect(waive.disabled).toBe(false);
    await userEvent.click(waive);
    expect(moveButton().disabled).toBe(false);
    await userEvent.click(moveButton());
    expect(onResolve).toHaveBeenCalledWith([
      { gateId: "ready_to_ship", decision: "waive", reason: "short but needed now", acknowledgement: ACK },
    ]);
  });

  it("offers Sign off for a met gate, with no reason field, once the sentence is ticked", async () => {
    const { onResolve } = setup([shipMet()]);
    const c = card("Ready to ship");
    expect(within(c).queryByLabelText("Why are you proceeding anyway?")).toBeNull();
    expect(within(c).queryByRole("button", { name: "Waive" })).toBeNull();
    const signOff = within(c).getByRole("button", { name: "Sign off" }) as HTMLButtonElement;
    expect(signOff.disabled).toBe(true);
    await userEvent.click(within(c).getByRole("checkbox", { name: ACK }));
    await userEvent.click(signOff);
    await userEvent.click(moveButton());
    expect(onResolve).toHaveBeenCalledWith([{ gateId: "ready_to_ship", decision: "sign_off", acknowledgement: ACK }]);
  });

  it("lists a passed gate in one line, and waits for every gate card before the move", async () => {
    setup([planPassed(), shipMet(), shipBlocked()].map((g, i) => (i === 2 ? { ...g, id: "payments" as const, title: "Taking payments" } : g)));
    expect(screen.getByText("Passed: Plan approved")).toBeTruthy();
    expect(screen.queryByRole("article", { name: "Gate: Plan approved" })).toBeNull();
    await userEvent.click(within(card("Ready to ship")).getByRole("checkbox"));
    await userEvent.click(within(card("Ready to ship")).getByRole("button", { name: "Sign off" }));
    expect(moveButton().disabled).toBe(true);
  });

  it("drops a decision when its sentence is unticked", async () => {
    setup([shipMet()]);
    const c = card("Ready to ship");
    await userEvent.click(within(c).getByRole("checkbox"));
    await userEvent.click(within(c).getByRole("button", { name: "Sign off" }));
    expect(moveButton().disabled).toBe(false);
    await userEvent.click(within(c).getByRole("checkbox"));
    expect(moveButton().disabled).toBe(true);
  });

  it("cancels the move", async () => {
    const { onCancel } = setup([shipMet()]);
    await userEvent.click(within(card("Ready to ship")).getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows the refresh note and renders hostile card titles as visible text", () => {
    const { container } = setup([shipMet()], {
      cardTitle: "Lo\u202Egin<img src=x>",
      note: "Something changed: a condition is no longer met. The checklist was refreshed.",
    });
    expect(screen.getByRole("status").textContent).toBe("Something changed: a condition is no longer met. The checklist was refreshed.");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('Moving "Lo\\u202egin<img src=x>" to Ship');
  });

  it("keeps an always-present status region for the note", () => {
    const { show } = setup([shipMet()]);
    expect(screen.getByRole("status").textContent).toBe("");
    show({ note: "Something changed: a condition is no longer met. The checklist was refreshed." });
    expect(screen.getByRole("status").textContent).toContain("Something changed");
  });

  it("focuses the first gate when it appears, and again when a refresh changes the checklist", async () => {
    const { show } = setup([shipMet()]);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Ready to ship" }));
    (document.activeElement as HTMLElement).blur();
    show({ evaluations: [shipMet()] });
    expect(document.activeElement).toBe(document.body);
    show({ evaluations: [shipBlocked()], revision: 1 });
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Ready to ship" }));
  });

  it("starts a gate over when its checklist changes, even with the same outcome", async () => {
    const { show } = setup([shipBlocked()]);
    const c = card("Ready to ship");
    await userEvent.click(within(c).getByRole("checkbox"));
    await userEvent.type(within(c).getByLabelText("Why are you proceeding anyway?"), "needed for the demo");
    await userEvent.click(within(c).getByRole("button", { name: "Waive" }));
    expect(moveButton().disabled).toBe(false);
    const changed = shipBlocked();
    changed.conditions[1] = { ...changed.conditions[1]!, met: false };
    show({ evaluations: [changed] });
    const fresh = card("Ready to ship");
    expect((within(fresh).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect((within(fresh).getByLabelText("Why are you proceeding anyway?") as HTMLTextAreaElement).value).toBe("");
    expect(moveButton().disabled).toBe(true);
  });

  it("drops the decisions on a refused move and keeps Move disabled while refreshing and after an outcome change", async () => {
    const { show } = setup([shipMet()]);
    await userEvent.click(within(card("Ready to ship")).getByRole("checkbox"));
    await userEvent.click(within(card("Ready to ship")).getByRole("button", { name: "Sign off" }));
    expect(moveButton().disabled).toBe(false);
    show({ refreshing: true, revision: 1 });
    expect(moveButton().disabled).toBe(true);
    show({ refreshing: false, revision: 1, evaluations: [shipMet()] });
    expect(moveButton().disabled).toBe(true);
    expect((within(card("Ready to ship")).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    show({ refreshing: false, revision: 1, evaluations: [shipBlocked()] });
    expect(moveButton().disabled).toBe(true);
    expect(within(card("Ready to ship")).getByRole("button", { name: "Waive" })).toBeTruthy();
  });

  it("caps a waiver reason at 500 characters", async () => {
    const { onResolve } = setup([shipBlocked()]);
    const c = card("Ready to ship");
    const reason = within(c).getByLabelText("Why are you proceeding anyway?") as HTMLTextAreaElement;
    expect(reason.maxLength).toBe(500);
    await userEvent.click(reason);
    await userEvent.paste("x".repeat(520));
    expect(reason.value.length).toBeLessThanOrEqual(500);
    await userEvent.click(within(c).getByRole("checkbox"));
    await userEvent.click(within(c).getByRole("button", { name: "Waive" }));
    await userEvent.click(moveButton());
    const sent = onResolve.mock.calls[0]![0][0].reason as string;
    expect(sent.length).toBe(500);
  });

  it("links each gate to its Learn topic", async () => {
    const nav = shellNav();
    const gate: GatePrompt = {
      cardId: "c1", cardTitle: "Login", to: "ship", evaluations: [shipBlocked()], note: null, revision: 0, refreshing: false,
    };
    render(
      <ShellContext.Provider value={{ model: {} as WorkbenchModel, dock: () => fakeDock(), ...nav } satisfies ShellContextValue}>
        <GateCards gate={gate} onResolve={vi.fn()} onCancel={vi.fn()} />
      </ShellContext.Provider>,
    );
    const learn = within(card("Ready to ship")).getByRole("button", { name: "Learn more" });
    expect(document.getElementById(learn.getAttribute("aria-describedby")!)!.textContent).toBe("Ready to ship");
    await userEvent.click(learn);
    expect(nav.openLearn).toHaveBeenCalledWith("readiness_gates");
  });

  it("can leave focus where it is, for a second copy of the prompt", () => {
    const gate: GatePrompt = {
      cardId: "c1", cardTitle: "Login", to: "ship", evaluations: [shipBlocked()], note: null, revision: 0, refreshing: false,
    };
    render(<GateCards gate={gate} onResolve={vi.fn()} onCancel={vi.fn()} autoFocus={false} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("shows a read-only copy with its checklist and sentence, pointing to the strip", () => {
    const gate: GatePrompt = {
      cardId: "c1", cardTitle: "Login", to: "ship", evaluations: [shipBlocked()], note: null, revision: 0, refreshing: false,
    };
    render(<GateCards gate={gate} onResolve={vi.fn()} onCancel={vi.fn()} readOnly />);
    const c = card("Ready to ship");
    expect(within(c).getByRole("list", { name: "Checklist" })).toBeTruthy();
    expect(c.textContent).toContain(ACK);
    expect(within(c).queryByRole("checkbox")).toBeNull();
    expect(within(c).queryByRole("textbox")).toBeNull();
    expect(within(c).queryByRole("button", { name: "Waive" })).toBeNull();
    expect(within(c).queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByRole("button", { name: 'Move "Login" to Ship' })).toBeNull();
    expect(screen.getByText("Decide in the strip above")).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });
});
