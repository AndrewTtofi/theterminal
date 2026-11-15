import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { LEARN_TOPICS } from "@theterminal/shared";
import { LEARN_READ_KEY } from "../src/learn-store";
import { LearnSideBar } from "../src/views/LearnSideBar";
import { ShellContext } from "../src/shell/model";
import type { ShellContextValue, WorkbenchModel } from "../src/shell/model";
import { shellNav } from "./connections-harness";

const title = (id: string) => LEARN_TOPICS.find((t) => t.id === id)!.title;

function setup(nav: Partial<ShellContextValue> = {}) {
  const shell = { model: {} as WorkbenchModel, dock: () => null, ...shellNav(), ...nav } as ShellContextValue;
  return render(
    <ShellContext.Provider value={shell}>
      <LearnSideBar />
    </ShellContext.Provider>,
  );
}
const summaries = () => screen.getAllByRole("group").map((d) => d.querySelector("summary")!.textContent ?? "");

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("LearnSideBar", () => {
  it("ranks the topics for the current view first under their own heading", () => {
    setup({ contextView: "changes" });
    expect(screen.getByRole("heading", { name: "For what you are looking at" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Everything else" })).toBeTruthy();
    expect(summaries()[0]).toContain(title("reading_a_diff"));
    expect(summaries()).toHaveLength(LEARN_TOPICS.length);
    expect(screen.getByText(/Short explanations so you can decide and audit well\. They are written into The Terminal, not generated\./)).toBeTruthy();
  });

  it("searches title and body, case-insensitively, as plain text", () => {
    setup();
    const box = screen.getByRole("searchbox", { name: "Search topics" });
    fireEvent.change(box, { target: { value: "KEYCHAIN" } });
    const found = summaries();
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThan(LEARN_TOPICS.length);
    expect(found.some((s) => s.includes(title("api_keys_and_keychain")))).toBe(true);
    fireEvent.change(box, { target: { value: "(.*+[" } });
    expect(screen.queryAllByRole("group")).toHaveLength(0);
    expect(screen.getByText("No topic matches.")).toBeTruthy();
  });

  it("marks a topic read when it is opened, and remembers it", () => {
    const { unmount } = setup();
    const d = screen.getByText(title("estimates")).closest("details")!;
    expect(d.className).not.toContain("read");
    d.open = true;
    fireEvent(d, new Event("toggle"));
    expect(d.className).toContain("read");
    expect(within(d).getByText("✓")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(LEARN_READ_KEY)!)).toContain("estimates");
    unmount();
    setup();
    expect(screen.getByText(title("estimates")).closest("details")!.className).toContain("read");
  });

  it("shows the topic named by learnTopic open and first", () => {
    setup({ learnTopic: "estimates", contextView: "board" });
    const first = screen.getAllByRole("group")[0] as HTMLDetailsElement;
    expect(first.querySelector("summary")!.textContent).toContain(title("estimates"));
    expect(first.open).toBe(true);
  });
});
