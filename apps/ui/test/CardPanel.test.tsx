import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Card, CardComment, CardInfo } from "@theterminal/shared";

vi.mock("../src/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/api")>();
  return { ...real, api: { cardComments: vi.fn(), addCardComment: vi.fn() } };
});

import { api, ApiError, errorMessage } from "../src/api";
import { CardPanel } from "../src/components/CardPanel";
import { ShellContext } from "../src/shell/model";
import { asRole, homeModel, homeRun, renderInShell } from "./home-fixtures";

const m = vi.mocked(api);

const card: Card = { id: "c1", projectId: "p1", title: "Fix the contact form", stage: "build", status: "active", createdAt: "", updatedAt: "" };
const info: CardInfo = {
  cardId: "c1", runId: "r1", adapter: "claude", runStatus: "running", percent: 50, now: "Checking it works", waiting: false,
  progress: { steps: ["Found the problem", "Wrote the fix", "Checking it works", "Ready for your review"], done: [1, 2], current: 3 },
  comments: 2, commentsWaiting: 1, screenshots: 0, moveRequest: null,
};
const note = (id: string, over: Partial<CardComment> = {}): CardComment => ({
  id, cardId: "c1", authorName: "Owner", role: "owner", text: "Make the error message red", at: "2026-11-16T10:42:00Z",
  state: "waiting", runId: null, adapter: null, ...over,
});

beforeEach(() => {
  m.cardComments.mockReset().mockResolvedValue({ comments: [] });
  m.addCardComment.mockReset();
});

const subscribe = () => vi.fn(() => () => {});
const show = (over = {}, onClose = vi.fn()) =>
  renderInShell(<CardPanel card={card} info={info} onClose={onClose} />, homeModel({ subscribeEntries: subscribe(), ...over }));

describe("CardPanel", () => {
  it("shows a new run's own lower percent on the same card", () => {
    const r = show();
    const panel = () => screen.getByRole("complementary", { name: "Card" });
    expect(within(panel()).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    const next: CardInfo = { ...info, runId: "r2", percent: 25, progress: { ...info.progress!, done: [1], current: 2 } };
    r.rerender(
      <ShellContext.Provider value={{ model: r.model, dock: () => r.dock, ...r.nav }}>
        <CardPanel card={card} info={next} onClose={vi.fn()} />
      </ShellContext.Provider>,
    );
    expect(within(panel()).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
  });

  it("shows the title, the bar and the latest run's checklist", async () => {
    show();
    const panel = screen.getByRole("complementary", { name: "Card" });
    expect(within(panel).getByText("Fix the contact form")).toBeTruthy();
    expect(within(panel).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    const steps = within(panel).getAllByRole("listitem").filter((li) => li.closest(".step-checklist"));
    expect(steps).toHaveLength(4);
    expect(steps[2]!.getAttribute("aria-current")).toBe("step");
    await waitFor(() => expect(m.cardComments).toHaveBeenCalledWith("c1"));
  });

  it("opens the full story in its tab", async () => {
    const { dock } = show();
    await userEvent.click(screen.getByRole("button", { name: "Open the full story" }));
    expect(dock.open).toHaveBeenCalledWith("story:c1", "Fix the contact form", "main");
  });

  it("offers Preview only when the latest run offered one", async () => {
    const openPreview = vi.fn();
    const data = { working: [homeRun("r1", {}, { offers: ["web"] })], finishedToday: [] };
    renderInShell(<CardPanel card={card} info={info} onClose={vi.fn()} />, homeModel({ subscribeEntries: subscribe(), openPreview }, data));
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(openPreview).toHaveBeenCalledWith("r1");
  });

  it("has no Preview without an offer", () => {
    show();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  });

  it("lists the notes with who, when and their state", async () => {
    m.cardComments.mockResolvedValue({
      comments: [
        note("n1", { state: "read", adapter: "claude", runId: "r1" }),
        note("n2", { text: "Also check it on iPhone", authorName: "Dana", role: "maintainer" }),
      ],
    });
    show();
    const read = await screen.findByText("Read by Claude");
    expect(read.className).toContain("ok");
    const waiting = screen.getByText("Waiting for the next run");
    expect(waiting.className).toContain("attention");
    const items = within(screen.getByRole("list", { name: "Notes" })).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("Make the error message red");
    expect(items[0]!.textContent).toContain("You");
    expect(items[1]!.textContent).toContain("Dana");
  });

  it("Send posts the note once and clears the box", async () => {
    m.addCardComment.mockResolvedValue(note("n9", { text: "Make it red" }));
    show();
    const box = screen.getByRole("textbox", { name: "Say something about this" });
    expect(box.getAttribute("maxLength")).toBe("2000");
    expect(screen.getByText("0/2000").className).toContain("num");
    await userEvent.type(box, "Make it red");
    expect(screen.getByText("11/2000")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(m.addCardComment).toHaveBeenCalledTimes(1);
    expect(m.addCardComment).toHaveBeenCalledWith("c1", "Make it red");
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
    expect(await screen.findByText("Make it red")).toBeTruthy();
  });

  it("keeps the text and says why when sending failed", async () => {
    const err = new ApiError(400, "secret_in_text");
    m.addCardComment.mockRejectedValue(err);
    show();
    const box = screen.getByRole("textbox", { name: "Say something about this" });
    await userEvent.type(box, "token ghp_TESTKEY");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(errorMessage(err))).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe("token ghp_TESTKEY");
  });

  it("does not send an empty note", async () => {
    show();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("gives a reviewer no box, only the sentence", () => {
    show({ me: asRole("reviewer") });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByText("Notes are for maintainers and above.")).toBeTruthy();
  });

  it("reads the notes again when one of the card's notes changes", async () => {
    let listener: (e: unknown) => void = () => {};
    const subscribeEntries = vi.fn((fn: (e: unknown) => void) => {
      listener = fn;
      return () => {};
    });
    show({ subscribeEntries });
    await waitFor(() => expect(m.cardComments).toHaveBeenCalledTimes(1));
    listener({ seq: 9, projectId: "p1", type: "card.comments_read", payload: { cardId: "c1", runId: "r1", commentIds: ["n1"] } });
    await waitFor(() => expect(m.cardComments).toHaveBeenCalledTimes(2));
    listener({ seq: 10, projectId: "p1", type: "card.comment", payload: { cardId: "c2" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(m.cardComments).toHaveBeenCalledTimes(2);
  });
});
