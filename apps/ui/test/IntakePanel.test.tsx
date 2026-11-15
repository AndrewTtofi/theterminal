import { describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { INTAKE_IDEA_MAX } from "@theterminal/shared";
import type { IntakeView } from "@theterminal/shared";
import { IntakePanel } from "../src/views/IntakePanel";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { ALL_ANSWERS, APPROVED_AT, intakeView } from "./intake-fixtures";

const NOTICE =
  "What you write here is recorded permanently in this project's ledger. Do not paste passwords, keys or other people's personal details.";

function setup(intake: IntakeView | null | undefined, over: Partial<WorkbenchModel> = {}) {
  const model = {
    selectedId: "p1",
    intake,
    onStartIntake: vi.fn().mockResolvedValue(true),
    onAnswerIntake: vi.fn().mockResolvedValue(true),
    onDecideIntake: vi.fn().mockResolvedValue(true),
    onCompleteIntake: vi.fn().mockResolvedValue(true),
    onReopenIntake: vi.fn().mockResolvedValue(true),
    ...over,
  } as unknown as WorkbenchModel;
  const ui = (m: WorkbenchModel) => (
    <ShellContext.Provider value={{ model: m, dock: () => null, selectView: vi.fn() }}>
      <IntakePanel id="intake" />
    </ShellContext.Provider>
  );
  const r = render(ui(model));
  /** Shows a new intake view, as App does when the server answers. */
  const show = (next: IntakeView | null | undefined, more: Partial<WorkbenchModel> = {}) =>
    act(() => r.rerender(ui({ ...model, intake: next, ...more })));
  return { model, show, panel: screen.getByRole("region", { name: "Plan intake" }) };
}

const heading = () => screen.getByRole("heading", { name: "Plan intake", level: 2 });

describe("IntakePanel", () => {
  it("says the project no longer exists instead of loading forever", () => {
    const { panel } = setup(undefined, { intakeError: "This project no longer exists" });
    expect(within(panel).getByRole("status").textContent).toBe("This project no longer exists");
    expect(within(panel).queryByText("Loading…")).toBeNull();
  });

  it("asks for a project while none is selected", () => {
    setup(undefined, { selectedId: null });
    expect(screen.getByText("Choose a project to plan it.")).toBeTruthy();
  });

  it("shows loading while the intake loads", () => {
    setup(undefined);
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("with no intake shows the permanence notice and Begin posts the idea", async () => {
    const { model, panel } = setup(null);
    expect(within(panel).getByText(NOTICE)).toBeTruthy();
    const begin = within(panel).getByRole("button", { name: "Begin" });
    expect((begin as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(within(panel).getByLabelText("Describe your idea"), "a reading list for a book club");
    await userEvent.click(begin);
    expect(model.onStartIntake).toHaveBeenCalledWith("a reading list for a book club");
  });

  it("renders the nine questions in catalog order with their help, and saves a radio change", async () => {
    const { model, panel } = setup(intakeView({ audience: "members of a book club" }));
    expect(within(panel).getByText(NOTICE)).toBeTruthy();
    expect(within(panel).getByText("1 of 9 answered")).toBeTruthy();
    for (const label of ["Who is this for?", "What should it do for them?", "How will you know it worked?"]) {
      expect(within(panel).getByRole("textbox", { name: label })).toBeTruthy();
    }
    expect(within(panel).getByRole("group", { name: "Where will people use it?" })).toBeTruthy();
    expect(within(panel).getByRole("checkbox", { name: "In a web browser" })).toBeTruthy();
    for (const label of ["Will it take payments?", "What personal data will it hold?", "Who can reach it?"]) {
      expect(within(panel).getByRole("group", { name: label })).toBeTruthy();
    }
    const budget = within(panel).getByRole("spinbutton", { name: "How much are you willing to spend on agents for this project? (USD)" });
    expect(budget.getAttribute("min")).toBe("0");
    expect(budget.getAttribute("step")).toBe("0.01");
    expect(within(panel).getByRole("textbox", { name: "Is there anything that already exists (code, designs, accounts)?" })).toBeTruthy();
    expect(within(panel).getByText(/Taking money brings legal and security duties/)).toBeTruthy();
    expect((within(panel).getByRole("textbox", { name: "Who is this for?" }) as HTMLTextAreaElement).value).toBe("members of a book club");

    const payments = within(panel).getByRole("group", { name: "Will it take payments?" });
    await userEvent.click(within(payments).getByRole("radio", { name: "Yes" }));
    expect(model.onAnswerIntake).toHaveBeenCalledWith("payments", "yes");
  });

  it("saves a text answer on blur and on Save answer, a checkbox list, and a number", async () => {
    const { model, panel } = setup(intakeView({}));
    const outcome = within(panel).getByRole("textbox", { name: "What should it do for them?" });
    await userEvent.type(outcome, "keep a shared reading list");
    await userEvent.tab();
    expect(model.onAnswerIntake).toHaveBeenCalledWith("outcome", "keep a shared reading list");

    await userEvent.type(within(panel).getByRole("textbox", { name: "Who is this for?" }), "book club members");
    await userEvent.click(within(panel).getAllByRole("button", { name: "Save answer" })[0]!);
    expect(model.onAnswerIntake).toHaveBeenCalledWith("audience", "book club members");

    await userEvent.click(within(panel).getByRole("checkbox", { name: "On a phone (an app)" }));
    expect(model.onAnswerIntake).toHaveBeenCalledWith("platform", ["mobile"]);

    const budget = within(panel).getByRole("spinbutton", { name: /How much are you willing to spend/ });
    await userEvent.type(budget, "25");
    await userEvent.tab();
    expect(model.onAnswerIntake).toHaveBeenCalledWith("budget_usd", 25);
  });

  it("does not save an unchanged or empty required text answer", async () => {
    const { model, panel } = setup(intakeView({ audience: "members of a book club" }));
    await userEvent.click(within(panel).getByRole("textbox", { name: "Who is this for?" }));
    await userEvent.tab();
    await userEvent.click(within(panel).getByRole("textbox", { name: "What should it do for them?" }));
    await userEvent.tab();
    expect(model.onAnswerIntake).not.toHaveBeenCalled();
  });

  it("in the decide step renders a card per decision, and deciding calls decideIntake", async () => {
    const { model, panel } = setup(intakeView(ALL_ANSWERS));
    const first = within(panel).getByRole("article", { name: "Plan decision: How much should the first version include?" });
    expect(within(panel).getByRole("article", { name: "Plan decision: Where should it run?" })).toBeTruthy();
    const smallest = within(first).getByRole("radio", { name: "The smallest version that proves the idea" }).closest("li")!;
    expect(within(smallest).getByText("Recommended")).toBeTruthy();
    await userEvent.click(within(first).getByRole("radio", { name: "Everything described" }));
    await userEvent.click(within(first).getByRole("button", { name: "Decide" }));
    expect(model.onDecideIntake).toHaveBeenCalledWith("first_version", "full", "");
  });

  it("in the answer step shows a decision that already applies below the questions", () => {
    const { budget_usd: _b, ...answers } = ALL_ANSWERS;
    const { panel } = setup(intakeView(answers));
    expect(within(panel).getByText("7 of 9 answered")).toBeTruthy();
    expect(within(panel).getByRole("article", { name: "Plan decision: How much should the first version include?" })).toBeTruthy();
  });

  it("in the decide step keeps the answers available to change", async () => {
    const { model, panel } = setup(intakeView(ALL_ANSWERS));
    await userEvent.click(within(panel).getByText("Change your answers"));
    const payments = within(panel).getByRole("group", { name: "Will it take payments?" });
    expect((within(payments).getByRole("radio", { name: "No" }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(within(payments).getByRole("radio", { name: "Yes" }));
    expect(model.onAnswerIntake).toHaveBeenCalledWith("payments", "yes");
  });

  it("in the approve step shows the plan, its cards by stage, and Approve plan completes the intake", async () => {
    const view = intakeView(ALL_ANSWERS, { first_version: "smallest", hosting: "local" });
    const { model, panel } = setup(view);
    expect(within(panel).getByRole("heading", { name: "Your plan" })).toBeTruthy();
    expect(within(panel).getByText(view.plan!.summary)).toBeTruthy();
    const cards = within(panel).getByRole("list", { name: "Cards this adds to the board" });
    for (const title of ['Define what "done" means', "Run it on this computer", "Monitoring and health checks"]) {
      expect(within(cards).getByText(title)).toBeTruthy();
    }
    expect(within(cards).getByText("Ship")).toBeTruthy();
    expect(within(panel).getByText("Approving records this plan in the ledger and adds the cards. You can reopen it later.")).toBeTruthy();
    await userEvent.click(within(panel).getByRole("button", { name: "Approve plan" }));
    expect(model.onCompleteIntake).toHaveBeenCalledTimes(1);
  });

  it("shows the plan's problem above Approve plan, which it disables", () => {
    const problem = "The project name looks like it contains a secret. Rename the project to continue.";
    const { panel } = setup(intakeView(ALL_ANSWERS, { first_version: "smallest", hosting: "local" }, { problem }));
    const shown = within(panel).getByText(problem);
    const approve = within(panel).getByRole("button", { name: "Approve plan" });
    expect(shown.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((approve as HTMLButtonElement).disabled).toBe(true);
  });

  it("when completed shows the summary and date, and Reopen plan stays disabled until a reason is typed", async () => {
    const view = intakeView(ALL_ANSWERS, { first_version: "smallest", hosting: "local" }, { completed: true });
    const { model, panel } = setup(view);
    expect(within(panel).getByText(view.plan!.summary)).toBeTruthy();
    expect(within(panel).getByText(`Approved ${new Date(APPROVED_AT).toLocaleDateString()}`)).toBeTruthy();
    const reopen = within(panel).getByRole("button", { name: "Reopen plan" }) as HTMLButtonElement;
    expect(reopen.disabled).toBe(true);
    await userEvent.type(within(panel).getByLabelText("Why are you reopening?"), "   ");
    expect(reopen.disabled).toBe(true);
    await userEvent.type(within(panel).getByLabelText("Why are you reopening?"), "We will take payments");
    expect(reopen.disabled).toBe(false);
    await userEvent.click(reopen);
    expect(model.onReopenIntake).toHaveBeenCalledWith("We will take payments");
  });

  it("shows hidden characters in recorded text as escapes", () => {
    const view = intakeView(ALL_ANSWERS, { first_version: "smallest", hosting: "local" }, { name: "Book\u202EClub" });
    const { panel } = setup(view);
    expect(panel.textContent).toContain("Book\\u202eClub is for");
    expect(panel.textContent).not.toContain("\u202E");
  });

  it("caps the idea at the server's limit", () => {
    const { panel } = setup(null);
    expect(within(panel).getByLabelText("Describe your idea").getAttribute("maxlength")).toBe(String(INTAKE_IDEA_MAX));
  });

  describe("focus", () => {
    it("moves to the panel heading when the step changes", () => {
      const { show } = setup(null);
      expect(document.activeElement).not.toBe(heading());
      show(intakeView({}));
      expect(document.activeElement).toBe(heading());
      (document.activeElement as HTMLElement).blur();
      show(intakeView(ALL_ANSWERS));
      expect(document.activeElement).toBe(heading());
      expect(heading().getAttribute("tabindex")).toBe("-1");
    });

    it("stays put when the intake first loads, when another project's loads, and when the step is unchanged", () => {
      const { show } = setup(undefined);
      show(intakeView({}));
      expect(document.activeElement).not.toBe(heading());
      show(undefined, { selectedId: "p2" });
      show(intakeView(ALL_ANSWERS), { selectedId: "p2" });
      expect(document.activeElement).not.toBe(heading());
      show(intakeView(ALL_ANSWERS, { first_version: "smallest" }), { selectedId: "p2" });
      expect(document.activeElement).not.toBe(heading());
    });

    it("keeps focus on the field the person moved to when the answer saved on blur comes back", async () => {
      const { model, show, panel } = setup(intakeView({}));
      await userEvent.type(within(panel).getByRole("textbox", { name: "Who is this for?" }), "book club members");
      const outcome = within(panel).getByRole("textbox", { name: "What should it do for them?" });
      await userEvent.click(outcome);
      expect(document.activeElement).toBe(outcome);
      expect(model.onAnswerIntake).toHaveBeenCalledWith("audience", "book club members");
      show(intakeView({ audience: "book club members" }));
      expect(document.activeElement).toBe(outcome);
      expect((within(panel).getByRole("textbox", { name: "Who is this for?" }) as HTMLTextAreaElement).value).toBe("book club members");
    });

    it("keeps focus on Save answer when the saved answer comes back", async () => {
      const { show, panel } = setup(intakeView({}));
      await userEvent.type(within(panel).getByRole("textbox", { name: "Who is this for?" }), "book club members");
      const save = within(panel).getAllByRole("button", { name: "Save answer" })[0]!;
      await userEvent.click(save);
      show(intakeView({ audience: "book club members" }));
      expect(document.activeElement).toBe(save);
    });

    it("keeps focus on the field the person moved to when the last required answer moves the plan to decisions", async () => {
      const { audience: _a, ...rest } = ALL_ANSWERS;
      const { show, panel } = setup(intakeView(rest));
      await userEvent.type(within(panel).getByRole("textbox", { name: "Who is this for?" }), "members of a book club");
      await userEvent.click(within(panel).getByRole("textbox", { name: /Is there anything that already exists/ }));
      const existing = document.activeElement;
      show(intakeView(ALL_ANSWERS));
      expect(within(panel).getByRole("article", { name: "Plan decision: How much should the first version include?" })).toBeTruthy();
      expect(document.activeElement).toBe(existing);
      expect(within(panel).getByRole("textbox", { name: /Is there anything that already exists/ })).toBe(existing);
    });

    it("folds the answers away once the plan is approved, so a reopened plan opens on its plan", async () => {
      const decided = { first_version: "smallest", hosting: "local" } as const;
      const { show, panel } = setup(intakeView(ALL_ANSWERS, decided));
      await userEvent.click(within(panel).getByRole("button", { name: "Change your answers" }));
      expect(within(panel).getByRole("button", { name: "Change your answers" }).getAttribute("aria-expanded")).toBe("true");
      show(intakeView(ALL_ANSWERS, decided, { completed: true }));
      expect(document.activeElement).toBe(heading());
      show(intakeView(ALL_ANSWERS, decided));
      expect(within(panel).getByRole("button", { name: "Change your answers" }).getAttribute("aria-expanded")).toBe("false");
    });
  });
});
