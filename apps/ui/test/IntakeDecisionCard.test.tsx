import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntakeDecisionCard } from "../src/components/IntakeDecisionCard";
import { ALL_ANSWERS, APPROVED_AT, intakeView } from "./intake-fixtures";

const firstVersion = (decided = false) =>
  intakeView(ALL_ANSWERS, decided ? { first_version: "smallest" } : {}).decisions.find((d) => d.id === "first_version")!;

describe("IntakeDecisionCard", () => {
  it("shows the question, the answers behind it, the options with trade-offs, what it means and the risk", () => {
    render(<IntakeDecisionCard decision={firstVersion()} onDecide={vi.fn()} />);
    const card = screen.getByRole("article", { name: "Plan decision: How much should the first version include?" });
    expect(within(card).getByRole("heading", { name: "How much should the first version include?" })).toBeTruthy();
    expect(within(card).getByText("Because you answered:")).toBeTruthy();
    expect(card.textContent).toContain("What should it do for them?");
    expect(card.textContent).toContain("keep a shared reading list");
    expect(within(card).getByText(/Cheaper and faster to try/)).toBeTruthy();
    expect(within(card).getByText(/Nothing is left for later/)).toBeTruthy();
    expect(within(card).getByText("What this means")).toBeTruthy();
    expect(within(card).getByText(/A first version is the earliest thing people can try/)).toBeTruthy();
    expect(within(card).getByText("Risk")).toBeTruthy();
    expect(within(card).getByText(/Building everything at once costs more/)).toBeTruthy();
    const recommended = within(card).getByText("Recommended").closest("li")!;
    expect(within(recommended).getByRole("radio", { name: "The smallest version that proves the idea" })).toBeTruthy();
    expect(screen.getAllByText("Recommended")).toHaveLength(1);
  });

  it("keeps Decide disabled until an option is chosen, then sends the choice and the trimmed reason", async () => {
    const onDecide = vi.fn().mockResolvedValue(true);
    render(<IntakeDecisionCard decision={firstVersion()} onDecide={onDecide} />);
    const decide = screen.getByRole("button", { name: "Decide" }) as HTMLButtonElement;
    expect(decide.disabled).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: "Everything described" }));
    await userEvent.type(screen.getByLabelText("Why (optional)"), "  we need it all  ");
    await userEvent.click(decide);
    expect(onDecide).toHaveBeenCalledWith("first_version", "full", "we need it all");
  });

  it("shows who decided, when, and what", () => {
    render(<IntakeDecisionCard decision={firstVersion(true)} onDecide={vi.fn()} />);
    expect(
      screen.getByText(`Decided by Owner on ${new Date(APPROVED_AT).toLocaleDateString()}: The smallest version that proves the idea`),
    ).toBeTruthy();
    expect((screen.getByRole("radio", { name: "The smallest version that proves the idea" }) as HTMLInputElement).checked).toBe(true);
  });

  it("shows hidden characters in a recorded answer and rationale as escapes", () => {
    const d = { ...firstVersion(true), because: [{ label: "Who is this for?", answer: "a‮b" }], rationale: "x​y" };
    render(<IntakeDecisionCard decision={d} onDecide={vi.fn()} />);
    const card = screen.getByRole("article");
    expect(card.textContent).toContain("a\\u202eb");
    expect(card.textContent).toContain("x\\u200by");
  });

  it("shows hidden characters in its accessible name as escapes", () => {
    render(<IntakeDecisionCard decision={{ ...firstVersion(), question: "Ship\u202eit?" }} onDecide={vi.fn()} />);
    expect(screen.getByRole("article").getAttribute("aria-label")).toBe("Plan decision: Ship\\u202eit?");
  });
});
