import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentRun, CardStory, LedgerEntry } from "@theterminal/shared";
import { StoryPanel } from "../src/views/StoryPanel";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { shellNav } from "./connections-harness";

const card = { id: "c1", projectId: "p1", title: "Login", stage: "build", status: "active", createdAt: "", updatedAt: "" } as const;
const run: AgentRun = {
  id: "r1", projectId: "p1", cardId: "c1", adapter: "fake", authMode: "none", prompt: "check the GPU", status: "completed",
  worktree: "w/r1", base: null, costUsd: 0.25, inputTokens: null, outputTokens: null, error: null, startedAt: "", finishedAt: null, machineId: null,
};
const owner = { kind: "human", id: "owner" } as const;
const agent = { kind: "agent", id: "r1" } as const;
let seq = 0;
const entry = (type: LedgerEntry["type"], payload: unknown, actor: LedgerEntry["actor"] = owner): LedgerEntry => ({
  seq: ++seq, id: `e${seq}`, ts: "2026-11-15T10:00:00.000Z", projectId: "p1", actor, type, payload, prevHash: "", hash: "",
});

function story(over: Partial<CardStory> = {}): CardStory {
  seq = 0;
  return {
    card,
    runs: [run],
    actions: [],
    entries: [
      entry("card.created", { cardId: "c1", title: "Login", stage: "plan" }),
      entry("agent.started", { runId: "r1", cardId: "c1", adapter: "fake", prompt: "check the GPU" }),
      entry("agent.action.requested", {
        runId: "r1", actionId: "a1", kind: "shell", tool: "Bash", summary: "Run: nvidia-smi", input: { command: "nvidia-smi" },
      }, agent),
      entry("agent.action.decided", { runId: "r1", actionId: "a1", decision: "allow", by: "human", reason: "" }),
      entry("agent.action.completed", { runId: "r1", actionId: "a1", ok: true, output: "GPU 0: Test Card" }, agent),
      entry("gate.waived", {
        gateId: "plan_approved", cardId: "c1", from: "plan", to: "design", unmet: ["The plan has been approved"],
        reason: "a demo for the book club", acknowledgement: "x", waivedBy: "owner",
      }),
    ],
    gateDecisions: [],
    costUsd: 0.25,
    integrity: { ok: true },
    unreadable: [],
    ...over,
  };
}

function setup(load: () => Promise<CardStory>) {
  const listeners = new Set<(e: LedgerEntry) => void>();
  const model = {
    story: vi.fn(load),
    subscribeEntries: (cb: (e: LedgerEntry) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as unknown as WorkbenchModel;
  const r = render(
    <ShellContext.Provider value={{ model, dock: () => null, ...shellNav() }}>
      <StoryPanel id="story:c1" />
    </ShellContext.Provider>,
  );
  const emit = (e: LedgerEntry) => act(() => listeners.forEach((l) => l(e)));
  return { model, emit, listeners, unmount: r.unmount };
}

describe("StoryPanel", () => {
  it("tells what happened in plain language with the raw record under each line, and the cost", async () => {
    const { model } = setup(() => Promise.resolve(story()));
    const panel = await screen.findByRole("region", { name: "Story: Login" });
    expect(model.story).toHaveBeenCalledWith("c1");
    expect(within(panel).getByRole("heading", { name: "Login" })).toBeTruthy();
    expect(panel.textContent).toContain("Build");
    expect(panel.textContent).toContain("active");
    expect(panel.textContent).toContain("Agent cost so far: $0.25 (estimate)");

    const happened = within(panel).getByRole("list", { name: "What happened" });
    const items = within(happened).getAllByRole("listitem");
    const headlines = items.map((li) => li.querySelector(".headline")?.textContent);
    expect(headlines).toContain('The Fake agent wants to run the command "nvidia-smi"');
    expect(headlines).toContain("Owner allowed it");
    expect(headlines).toContain("Done (1 line of output)");
    const done = items.find((li) => li.querySelector(".headline")?.textContent === "Done (1 line of output)")!;
    const raw = done.querySelector("details")!;
    expect(raw.querySelector("summary")!.textContent).toBe("Raw");
    expect(raw.querySelector("summary")!.getAttribute("aria-label")).toBe("Raw record: Done (1 line of output)");
    expect(raw.querySelector("pre")!.textContent).toContain("GPU 0: Test Card");
    expect(done.querySelector("time")).toBeTruthy();
  });

  it("lists the decisions with their reasons", async () => {
    setup(() => Promise.resolve(story()));
    const panel = await screen.findByRole("region", { name: "Story: Login" });
    const decisions = within(panel).getByRole("list", { name: "Decisions and why" });
    const items = within(decisions).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("Owner allowed it");
    expect(items[1]).toContain('Owner waived "Plan approved"');
    expect(items[1]).toContain("a demo for the book club");
  });

  it("lists an override under Decisions and why, in red, with its reason", async () => {
    const s = story();
    const discard = entry("override.discard", { overrideId: "o1", runId: "r1", reason: "The agent broke the build", files: 2 });
    setup(() => Promise.resolve({ ...s, entries: [...s.entries, discard] }));
    const panel = await screen.findByRole("region", { name: "Story: Login" });
    const decisions = within(panel).getByRole("list", { name: "Decisions and why" });
    const items = within(decisions).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    const last = items[2];
    expect(last.classList.contains("override")).toBe(true);
    expect(last.querySelector(".headline")!.textContent).toMatch(/^OVERRIDE: Owner discarded 2 changed file\(s\)/);
    expect(last.textContent).toContain("Why: The agent broke the build");
    expect(items[0].classList.contains("override")).toBe(false);
    const happened = within(panel).getByRole("list", { name: "What happened" });
    const lines = within(happened).getAllByRole("listitem");
    expect(lines[lines.length - 1].classList.contains("override")).toBe(true);
  });

  it("says nothing has happened when only the card was created, and shows no cost", async () => {
    const s = story({ runs: [], costUsd: null });
    setup(() => Promise.resolve({ ...s, entries: s.entries.slice(0, 1) }));
    const panel = await screen.findByRole("region", { name: "Story: Login" });
    expect(panel.textContent).toContain("Nothing has happened on this card yet.");
    expect(panel.textContent).toContain("No agent cost recorded");
  });

  it("warns when part of the record could not be read", async () => {
    setup(() => Promise.resolve(story({ integrity: { ok: false, brokenAtSeq: 4 }, unreadable: [{ seq: 4, unreadable: true }] })));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Part of this card's record could not be read. The ledger's integrity check failed at entry #4.");
    expect(alert.textContent).toContain("#4");
  });

  it("warns about unreadable entries even when the chain check passed", async () => {
    setup(() => Promise.resolve(story({ unreadable: [{ seq: 3, unreadable: true }, { seq: 5, unreadable: true }] })));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Part of this card's record could not be read.");
    expect(alert.textContent).toContain("#3, #5");
  });

  it("reloads on entries naming the card or one of its runs, and not on others", async () => {
    const { model, emit } = setup(() => Promise.resolve(story()));
    await screen.findByRole("region", { name: "Story: Login" });
    expect(model.story).toHaveBeenCalledTimes(1);
    emit({ ...entry("card.moved", { cardId: "c2", from: "plan", to: "design" }), seq: 100 });
    emit({ ...entry("agent.message", { runId: "r9", text: "hi" }, agent), seq: 101 });
    expect(model.story).toHaveBeenCalledTimes(1);
    emit({ ...entry("agent.message", { runId: "r1", text: "hi" }, agent), seq: 102 });
    await waitFor(() => expect(model.story).toHaveBeenCalledTimes(2));
    emit({ ...entry("card.moved", { cardId: "c1", from: "build", to: "ship" }), seq: 103 });
    await waitFor(() => expect(model.story).toHaveBeenCalledTimes(3));
  });

  it("shows an error when the story cannot be loaded", async () => {
    setup(() => Promise.reject(new Error("down")));
    expect(await screen.findByText("This card's story could not be loaded.")).toBeTruthy();
  });

  it("stops listening when the tab closes", async () => {
    const { listeners, unmount } = setup(() => Promise.resolve(story()));
    await screen.findByRole("region", { name: "Story: Login" });
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });
});
