import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentRun } from "@theterminal/shared";
import { ADAPTER_NAMES } from "../src/components/AgentPanel";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { AgentFeedPanel, FEED_LIMIT } from "../src/views/AgentFeedPanel";
import { fakeDock, shellNav } from "./connections-harness";

const shared = vi.hoisted(() => ({ narrate: undefined as unknown as ReturnType<typeof vi.fn> }));
vi.mock("@theterminal/shared", async (importOriginal) => {
  const real = await importOriginal<typeof import("@theterminal/shared")>();
  shared.narrate = vi.fn(real.narrate);
  return { ...real, narrate: shared.narrate };
});

afterEach(() => vi.useRealTimers());
import { completed, ev, feedRun, message, overrideCommand, requested } from "./feed-fixtures";

const runs: AgentRun[] = [
  feedRun("run1", { status: "running" }),
  feedRun("run2", { adapter: "claude", prompt: "Fix the login page so that it remembers the user next time" }),
];
const narration = {
  adapterName: (id: string) => {
    const r = runs.find((x) => x.id === id);
    return r ? ADAPTER_NAMES[r.adapter] : undefined;
  },
};

function model(over: Partial<WorkbenchModel> = {}): WorkbenchModel {
  return { runs, projectEntries: [], feedRunId: null, onFollowRun: vi.fn(), narration, ...over } as unknown as WorkbenchModel;
}

function renderFeed(over: Partial<WorkbenchModel> = {}) {
  const dock = fakeDock();
  const wrap = (m: WorkbenchModel) => (
    <ShellContext.Provider value={{ model: m, dock: () => dock, ...shellNav() }}>
      <AgentFeedPanel />
    </ShellContext.Provider>
  );
  const m = model(over);
  const r = render(wrap(m));
  return { model: m, rerender: (o: Partial<WorkbenchModel>) => r.rerender(wrap(model({ ...over, ...o }))) };
}

const feed = () => screen.getByRole("region", { name: "Agent feed" });
const items = () => within(feed()).queryAllByRole("listitem");

describe("AgentFeedPanel", () => {
  it("narrates the project's agent entries from the ledger, newest last, with the raw record underneath", () => {
    renderFeed({ projectEntries: [requested(2, "run1", "a1", "nvidia-smi"), message(1, "run1", "Looking for a GPU")] });
    const [first, second] = items();
    expect(first!.querySelector(".headline")?.textContent).toBe('The Fake agent said: "Looking for a GPU"');
    expect(second!.querySelector(".headline")?.textContent).toBe('The Fake agent wants to run the command "nvidia-smi"');
    expect(second!.querySelector("time")).not.toBeNull();
    const raw = second!.querySelector("details");
    expect(raw?.querySelector("summary")?.textContent).toBe("Raw");
    expect(raw?.textContent).toContain('"command": "nvidia-smi"');
  });

  it("leaves out entries that are not about agents or overrides", () => {
    renderFeed({ projectEntries: [ev(1, "card.created", { cardId: "c1", title: "Login", stage: "plan" }), message(2, "run1", "hi")] });
    expect(items()).toHaveLength(1);
  });

  it("follows one run when chosen, and lists every run in the Follow select", () => {
    const entries = [requested(1, "run1", "a1", "nvidia-smi"), requested(2, "run2", "b1", "npm test")];
    const { model: m } = renderFeed({ projectEntries: entries, feedRunId: "run1" });
    expect(items().map((li) => li.querySelector(".headline")?.textContent)).toEqual([
      'The Fake agent wants to run the command "nvidia-smi"',
    ]);
    const follow = within(feed()).getByRole("combobox", { name: "Follow" }) as HTMLSelectElement;
    expect(follow.value).toBe("run1");
    expect([...follow.options].map((o) => o.textContent)).toEqual([
      "All runs",
      "Fake · Detect GPU",
      "Claude · Fix the login page so that it remembers …",
    ]);
    fireEvent.change(follow, { target: { value: "run2" } });
    expect(m.onFollowRun).toHaveBeenCalledWith("run2");
    fireEvent.change(follow, { target: { value: "" } });
    expect(m.onFollowRun).toHaveBeenCalledWith(null);
  });

  it("shows at most the latest 500 items and says so", () => {
    const entries = Array.from({ length: 600 }, (_, i) => message(i + 1, "run2", `m${i + 1}`));
    renderFeed({ projectEntries: entries });
    expect(FEED_LIMIT).toBe(500);
    expect(items()).toHaveLength(500);
    expect(items()[0]!.textContent).toContain('"m101"');
    expect(within(feed()).getByText("Showing the latest 500")).toBeTruthy();
  });

  it("says nothing about a limit when everything fits", () => {
    renderFeed({ projectEntries: [message(1, "run2", "hi")] });
    expect(within(feed()).queryByText("Showing the latest 500")).toBeNull();
  });

  it("paints an override red, with its label, and marks entries that need attention", () => {
    renderFeed({ projectEntries: [overrideCommand(1, "run2", "git", ["status"]), requested(2, "run2", "a1", "ls"), message(3, "run2", "hi")] });
    const [override, request, said] = items();
    expect(override!.classList.contains("override")).toBe(true);
    expect(override!.textContent).toContain("OVERRIDE");
    expect(request!.classList.contains("attention")).toBe(true);
    expect(request!.classList.contains("override")).toBe(false);
    expect(said!.className).toBe("");
  });

  it("narrates only the entries that arrived, not the whole list again", () => {
    const first = [message(1, "run1", "a"), message(2, "run1", "b")];
    const { rerender } = renderFeed({ projectEntries: first });
    shared.narrate.mockClear();
    rerender({ projectEntries: [...first, message(3, "run1", "c")] });
    expect(shared.narrate).toHaveBeenCalledTimes(1);
    expect(items()).toHaveLength(3);
  });

  it("strips terminal codes from headlines before showing hidden characters", () => {
    renderFeed({ projectEntries: [message(1, "run1", "\u001b[31mred\u001b[0m done")] });
    expect(items()[0]!.querySelector(".headline")?.textContent).toBe('The Fake agent said: "red done"');
  });

  it("can be reached and scrolled with the keyboard, and names its list", () => {
    renderFeed({ projectEntries: [message(1, "run1", "a")] });
    const list = within(feed()).getByRole("list", { name: "Agent feed entries" });
    expect(list.tabIndex).toBe(0);
  });

  it("ends a running run's items with a live marker", () => {
    const { rerender } = renderFeed({ projectEntries: [message(1, "run1", "hi")], feedRunId: "run1" });
    expect(within(feed()).getByRole("status").textContent).toBe("Working…");
    rerender({ feedRunId: "run2" });
    expect(within(feed()).queryByText("Working…")).toBeNull();
  });

  it("says how to start when there is nothing to show", () => {
    renderFeed();
    expect(feed().textContent).toContain("Nothing to show yet. Start an agent in the Agents view or the Conversation tab.");
  });

  it("renders hostile text as inert text with hidden characters visible", () => {
    renderFeed({ projectEntries: [message(1, "run1", "<img src=x onerror=alert(1)>\u200B"), completed(2, "run1", "a1", "ok\u202Eko")] });
    expect(document.querySelector("img, script")).toBeNull();
    expect(feed().textContent).toContain("ok\\u202eko");
    expect(feed().textContent).not.toMatch(/[\u200B\u202E]/);
  });

  describe("autoscroll", () => {
    /** Gives the list a scroll geometry jsdom does not compute. */
    function geometry(list: HTMLElement, g: { scrollHeight: number; clientHeight: number }) {
      Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => g.scrollHeight });
      Object.defineProperty(list, "clientHeight", { configurable: true, get: () => g.clientHeight });
    }
    const list = () => within(feed()).getByRole("list");

    it("keeps the bottom in view, and offers a jump with a count once the Owner has scrolled up", () => {
      const first = [message(1, "run1", "a"), message(2, "run1", "b")];
      const { rerender } = renderFeed({ projectEntries: first });
      const g = { scrollHeight: 1000, clientHeight: 200 };
      geometry(list(), g);
      rerender({ projectEntries: [...first, message(3, "run1", "c")] });
      expect(list().scrollTop).toBe(1000);

      // Scrolled up by 100 px: more than 40 from the bottom.
      act(() => {
        list().scrollTop = 700;
        fireEvent.scroll(list());
      });
      g.scrollHeight = 1100;
      rerender({ projectEntries: [...first, message(3, "run1", "c"), message(4, "run1", "d"), message(5, "run1", "e")] });
      expect(list().scrollTop).toBe(700);
      const jump = within(feed()).getByRole("button", { name: "Jump to latest (2 new)" });
      fireEvent.click(jump);
      expect(list().scrollTop).toBe(1100);
      expect(within(feed()).queryByRole("button", { name: /Jump to latest/ })).toBeNull();
    });

    it("updates the count of new items at most once a second, as a status", () => {
      vi.useFakeTimers();
      const first = [message(1, "run1", "a")];
      const { rerender } = renderFeed({ projectEntries: first });
      geometry(list(), { scrollHeight: 1000, clientHeight: 200 });
      act(() => {
        list().scrollTop = 0;
        fireEvent.scroll(list());
      });
      const more = (n: number) => Array.from({ length: n }, (_, i) => message(i + 2, "run1", `m${i + 2}`));
      rerender({ projectEntries: [...first, ...more(1)] });
      const count = () => within(feed()).getByRole("button", { name: /Jump to latest/ }).textContent;
      expect(count()).toBe("Jump to latest (1 new)");
      expect(within(feed()).getByRole("button", { name: /Jump to latest/ }).querySelector('[role="status"]')).not.toBeNull();
      rerender({ projectEntries: [...first, ...more(3)] });
      expect(count()).toBe("Jump to latest (1 new)");
      act(() => vi.advanceTimersByTime(1000));
      expect(count()).toBe("Jump to latest (3 new)");
    });

    it("keeps the item the Owner is reading in place when old items are dropped from the top", () => {
      const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop")!;
      const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
      // Every item is 100 px tall, stacked in order.
      Object.defineProperty(HTMLElement.prototype, "offsetTop", {
        configurable: true,
        get(this: HTMLElement) {
          return this.tagName === "LI" && this.parentElement ? Array.prototype.indexOf.call(this.parentElement.children, this) * 100 : 0;
        },
      });
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 100 });
      try {
        const all = Array.from({ length: 510 }, (_, i) => message(i + 1, "run2", `m${i + 1}`));
        const { rerender } = renderFeed({ projectEntries: all.slice(0, 500) });
        geometry(list(), { scrollHeight: 50_000, clientHeight: 200 });
        // Reading item 301, at the top of the view.
        act(() => {
          list().scrollTop = 30_000;
          fireEvent.scroll(list());
        });
        rerender({ projectEntries: all });
        // Ten items were dropped above it: it now starts 1,000 px higher, and the view follows it.
        expect(list().scrollTop).toBe(29_000);
      } finally {
        Object.defineProperty(HTMLElement.prototype, "offsetTop", offsetTop);
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
      }
    });

    it("keeps following when the Owner is within 40 px of the bottom", () => {
      const first = [message(1, "run1", "a")];
      const { rerender } = renderFeed({ projectEntries: first });
      const g = { scrollHeight: 1000, clientHeight: 200 };
      geometry(list(), g);
      act(() => {
        list().scrollTop = 770;
        fireEvent.scroll(list());
      });
      g.scrollHeight = 1050;
      rerender({ projectEntries: [...first, message(2, "run1", "b")] });
      expect(list().scrollTop).toBe(1050);
      expect(within(feed()).queryByRole("button", { name: /Jump to latest/ })).toBeNull();
    });
  });
});
