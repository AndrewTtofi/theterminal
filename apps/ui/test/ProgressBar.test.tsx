import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProgressBar, StepChecklist } from "../src/components/ProgressBar";

describe("ProgressBar", () => {
  it("shows the number, the caption and the progressbar values", () => {
    render(<ProgressBar percent={33} label="Fix login" />);
    const bar = screen.getByRole("progressbar", { name: "Fix login" });
    expect(bar.getAttribute("aria-valuenow")).toBe("33");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(screen.getByText("33%")).toBeTruthy();
    expect(screen.getByText("as the agent reports it")).toBeTruthy();
  });
  it("draws the bar alone when compact, and nothing without a number", () => {
    const { container, rerender } = render(<ProgressBar percent={72} label="Fix login" compact />);
    expect(screen.getByRole("progressbar", { name: "Fix login" }).getAttribute("aria-valuenow")).toBe("72");
    expect(screen.queryByText("72%")).toBeNull();
    expect(screen.queryByText("as the agent reports it")).toBeNull();
    rerender(<ProgressBar percent={null} label="Fix login" compact />);
    expect(container.innerHTML).toBe("");
  });
  it("takes another caption for a fixed plan that is not the agent's", () => {
    render(<ProgressBar percent={40} label="Getting it running" caption="stage 3 of 5" />);
    expect(screen.getByText("40%")).toBeTruthy();
    expect(screen.getByText("stage 3 of 5")).toBeTruthy();
    expect(screen.queryByText("as the agent reports it")).toBeNull();
  });
  it("never moves back for the same key, and starts again for a new one", () => {
    const { rerender } = render(<ProgressBar key="run-1" percent={67} label="Fix login" />);
    rerender(<ProgressBar key="run-1" percent={33} label="Fix login" />);
    expect(screen.getByText("67%")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Fix login" }).getAttribute("aria-valuenow")).toBe("67");
    rerender(<ProgressBar key="run-2" percent={33} label="Fix login" />);
    expect(screen.getByText("33%")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Fix login" }).getAttribute("aria-valuenow")).toBe("33");
  });
  it("sets the percent as a number", () => {
    render(<ProgressBar percent={40} label="Fix login" />);
    expect(screen.getByText("40%").classList.contains("num")).toBe(true);
  });
  it("shows Working… and no number without a plan", () => {
    const { container } = render(<ProgressBar percent={null} label="Fix login" />);
    expect(screen.getByText("Working…")).toBeTruthy();
    expect(container.querySelector("[aria-valuenow]")).toBeNull();
    expect(container.textContent).not.toMatch(/\d%/);
  });
});

describe("StepChecklist", () => {
  it("marks done, current and to-do steps", () => {
    render(<StepChecklist progress={{ steps: ["a", "b", "c"], done: [1], current: 2 }} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]!.querySelector('[aria-label="done"]')?.textContent).toBe("✓");
    expect(items[1]!.getAttribute("aria-current")).toBe("step");
    expect(items[2]!.getAttribute("aria-current")).toBeNull();
    expect(items[2]!.querySelector('[aria-label="done"]')).toBeNull();
  });
});
