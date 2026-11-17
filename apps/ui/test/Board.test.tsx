import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Board as BoardData, Card, CardInfo } from "@theterminal/shared";
import { Board } from "../src/components/Board";
import { RoleContext } from "../src/shell/model";

const card = (id: string, title: string, over: Partial<Card> = {}): Card => ({
  id, projectId: "p1", title, stage: "plan", status: "todo", createdAt: "", updatedAt: "", ...over,
});

const board: BoardData = {
  project: { id: "p1", name: "Demo", pitch: "", createdAt: "2026-01-01T00:00:00Z" },
  columns: {
    plan: [card("c0", "Add a blog section")],
    design: [],
    build: [card("c1", "Fix the contact form", { stage: "build", status: "active" }), card("c2", "Newsletter sign-up", { stage: "build" })],
    ship: [],
    operate: [card("c3", "Dark mode", { stage: "operate", status: "done" })],
  },
};

export const info = (cardId: string, over: Partial<CardInfo> = {}): CardInfo => ({
  cardId, runId: "r1", adapter: "claude", runStatus: "running", progress: null, percent: null, now: null, waiting: false,
  comments: 0, commentsWaiting: 0, screenshots: 0, moveRequest: null, ...over,
});

const infos: Record<string, CardInfo> = {
  c0: info("c0", { runId: null, adapter: null, runStatus: null, comments: 1, commentsWaiting: 1 }),
  c1: info("c1", { percent: 72, now: "Checking the fix works", comments: 2 }),
  c2: info("c2", { percent: 40, waiting: true }),
  c3: info("c3", { adapter: "gemini", runStatus: "completed", percent: 100, screenshots: 3 }),
};

const renderBoard = (role: "viewer" | "owner" = "owner", onOpen = vi.fn()) =>
  render(
    <RoleContext.Provider value={role}>
      <Board board={board} infos={infos} selectedId={null} onOpen={onOpen} />
    </RoleContext.Provider>,
  );

const cardButton = (title: string) => screen.getByRole("button", { name: `Open ${title}` });

describe("Board", () => {
  it("the bar always shows the latest run's true percent: a new run, or a longer plan, may show less", () => {
    const steps = (n: number, done: number[]) => ({ steps: Array.from({ length: n }, (_, i) => `step ${i + 1}`), done, current: null });
    const withInfo = (i: CardInfo) => (
      <RoleContext.Provider value="owner">
        <Board board={board} infos={{ ...infos, c1: i }} selectedId={null} onOpen={vi.fn()} />
      </RoleContext.Provider>
    );
    const bar = () => within(cardButton("Fix the contact form")).getByRole("progressbar").getAttribute("aria-valuenow");
    const r = render(withInfo(info("c1", { runId: "r1", progress: steps(4, [1, 2, 3]), percent: 75 })));
    expect(bar()).toBe("75");
    // The agent restates its plan longer: fewer of its steps are done.
    r.rerender(withInfo(info("c1", { runId: "r1", progress: steps(8, [1, 2, 3]), percent: 38 })));
    expect(bar()).toBe("38");
    // Another run takes the card on.
    r.rerender(withInfo(info("c1", { runId: "r2", progress: steps(8, [1]), percent: 13 })));
    expect(bar()).toBe("13");
    // A stale answer for the same run and plan cannot move it back.
    r.rerender(withInfo(info("c1", { runId: "r2", progress: steps(8, []), percent: 0 })));
    expect(bar()).toBe("13");
  });

  it("renders the five columns in order, each with its count", () => {
    renderBoard();
    const columns = screen.getAllByRole("region");
    expect(columns.map((c) => c.getAttribute("aria-label"))).toEqual(["Plan", "Design", "Build", "Ship", "Operate"]);
    const build = screen.getByRole("region", { name: "Build" });
    expect(within(build).getByRole("heading", { level: 3 }).querySelector(".num")?.textContent).toBe("2");
  });

  it("offers no way to add, edit, drag or move a card, whatever the role", () => {
    const owner = renderBoard("owner");
    const { container } = owner;
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector('[draggable="true"]')).toBeNull();
    expect(screen.queryByText("+ Add")).toBeNull();
    expect(screen.queryByPlaceholderText("+ Add")).toBeNull();
    const ownerHtml = container.innerHTML;
    owner.unmount();
    const viewer = renderBoard("viewer");
    expect(viewer.container.innerHTML).toBe(ownerHtml);
  });

  it("shows the percent, the Now line, the agent and the note count of a working card", () => {
    renderBoard();
    const c1 = cardButton("Fix the contact form");
    expect(c1.tagName).toBe("BUTTON");
    expect(c1.className).toContain("agent-card");
    expect(within(c1).getByText("72%").className).toContain("num");
    expect(within(c1).getByText("Now: Checking the fix works")).toBeTruthy();
    expect(within(c1).getByText("Claude")).toBeTruthy();
    expect(within(c1).getByText("2 notes")).toBeTruthy();
    expect(within(c1).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("72");
    expect(c1.querySelector(".dot")?.className).toContain("live");
  });

  it("says when a card waits for approval, for an agent, or has notes waiting", () => {
    renderBoard();
    const c2 = cardButton("Newsletter sign-up");
    expect(within(c2).getByText("Waiting for your approval").className).toContain("attention");
    expect(c2.querySelector(".dot")?.className).toContain("waiting");
    const c0 = cardButton("Add a blog section");
    expect(within(c0).getByText("Waiting for an agent")).toBeTruthy();
    expect(within(c0).queryByRole("progressbar")).toBeNull();
    expect(within(c0).getByText("1 note waiting").className).toContain("attention");
    expect(c0.querySelector(".dot")?.className).toContain("idle");
  });

  it("marks a done card green and counts its screenshots", () => {
    renderBoard();
    const c3 = cardButton("Dark mode");
    expect(c3.querySelector(".dot")?.className).toContain("done");
    expect(within(c3).getByText("Gemini")).toBeTruthy();
    expect(within(c3).getByText("3 screenshots")).toBeTruthy();
  });

  it("shows a plain card when its information has not loaded", () => {
    render(<Board board={board} infos={{}} selectedId={null} onOpen={vi.fn()} />);
    const c1 = cardButton("Fix the contact form");
    expect(within(c1).queryByRole("progressbar")).toBeNull();
    expect(within(c1).getByText("Fix the contact form")).toBeTruthy();
  });

  it("opens a card when clicked and marks the selected one", async () => {
    const onOpen = vi.fn();
    render(<Board board={board} infos={infos} selectedId="c1" onOpen={onOpen} />);
    expect(cardButton("Fix the contact form").getAttribute("aria-pressed")).toBe("true");
    expect(cardButton("Dark mode").getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(cardButton("Dark mode"));
    expect(onOpen).toHaveBeenCalledWith("c3");
  });

  it("escapes control characters in titles", () => {
    const odd: BoardData = { ...board, columns: { ...board.columns, plan: [card("cx", "a\u001bb")] } };
    render(<Board board={odd} infos={{}} selectedId={null} onOpen={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Open a\\u001bb" })).toBeTruthy();
  });
});

describe("board.css", () => {
  const css = readFileSync(join(__dirname, "..", "src", "components", "board.css"), "utf8");
  const values = (prop: string) => [...css.matchAll(new RegExp(`(?<![-\\w])${prop}\\s*:\\s*([^;}]+)`, "g"))].map((m) => m[1]!.trim());
  it("uses the shape tokens only", () => {
    expect(values("border-radius").filter((v) => /\d+(\.\d+)?px/.test(v))).toEqual([]);
    expect(values("font-size").filter((v) => !/^var\(--text-/.test(v))).toEqual([]);
    for (const p of ["padding", "margin", "gap"]) {
      expect(values(p).filter((v) => [...v.matchAll(/(-?\d+(?:\.\d+)?)px/g)].some((m) => Number(m[1]) % 4 !== 0)), p).toEqual([]);
    }
    expect(values("box-shadow").filter((v) => !/^(none|0 0 0 1px var\(--[\w-]+\))$/.test(v))).toEqual([]);
    expect([...values("transition"), ...values("animation")].filter((v) => /\b\d*\.?\d+m?s\b/.test(v))).toEqual([]);
  });
});
