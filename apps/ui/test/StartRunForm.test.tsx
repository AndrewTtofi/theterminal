import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Card, Connection } from "@theterminal/shared";
import { StartRunForm } from "../src/components/StartRunForm";

const cards: Card[] = [
  { id: "c1", projectId: "p1", title: "Login", stage: "build", status: "todo", createdAt: "", updatedAt: "" },
  { id: "c2", projectId: "p1", title: "Search", stage: "plan", status: "todo", createdAt: "", updatedAt: "" },
];
const aws = { id: "k1", kind: "cloud", name: "AWS prod", enabled: true } as unknown as Connection;

describe("StartRunForm", () => {
  it("submits with the default label, in the order adapter, prompt, connections, card", async () => {
    const onStart = vi.fn().mockResolvedValue(true);
    render(<StartRunForm adapters={["fake"]} cards={cards} connections={[aws]} onStart={onStart} />);
    await userEvent.selectOptions(screen.getByLabelText("Card (optional)"), "c2");
    await userEvent.click(screen.getByLabelText("AWS prod (cloud account)"));
    await userEvent.type(screen.getByLabelText("Prompt"), "Add search");
    await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
    expect(onStart).toHaveBeenCalledWith("fake", "Add search", ["k1"], "c2");
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("");
  });

  it("takes a submit label and starts on the default card", async () => {
    const onStart = vi.fn().mockResolvedValue(true);
    render(<StartRunForm adapters={["fake"]} cards={cards} connections={[]} defaultCardId="c1" submitLabel="Ask" onStart={onStart} />);
    expect((screen.getByLabelText("Card (optional)") as HTMLSelectElement).value).toBe("c1");
    await userEvent.type(screen.getByLabelText("Prompt"), "Add a logout button");
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(onStart).toHaveBeenCalledWith("fake", "Add a logout button", [], "c1");
  });

  it("does not send a default card that is not in the project", async () => {
    const onStart = vi.fn().mockResolvedValue(true);
    render(<StartRunForm adapters={["fake"]} cards={cards} connections={[]} defaultCardId="gone" onStart={onStart} />);
    await userEvent.type(screen.getByLabelText("Prompt"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
    expect(onStart).toHaveBeenCalledWith("fake", "hello", []);
  });

  it("keeps the prompt when starting failed", async () => {
    const onStart = vi.fn().mockResolvedValue(false);
    render(<StartRunForm adapters={["fake"]} cards={[]} connections={[]} onStart={onStart} />);
    await userEvent.type(screen.getByLabelText("Prompt"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("hello");
  });

  it("puts focus back in the prompt after starting, and announces only when asked to", async () => {
    const onStart = vi.fn().mockResolvedValue(true);
    const { rerender } = render(<StartRunForm adapters={["fake"]} cards={[]} connections={[]} onStart={onStart} />);
    const box = screen.getByLabelText("Prompt");
    await userEvent.type(box, "hello");
    await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
    expect(document.activeElement).toBe(box);
    expect(screen.getByRole("status").textContent).toBe("");
    rerender(<StartRunForm adapters={["fake"]} cards={[]} connections={[]} onStart={onStart} startedMessage={(n) => `Asked ${n}.`} />);
    await userEvent.type(box, "again");
    await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
    expect(screen.getByRole("status").textContent).toBe("Asked Fake.");
  });

  it("announces nothing and keeps the prompt when starting failed", async () => {
    const onStart = vi.fn().mockResolvedValue(false);
    render(<StartRunForm adapters={["fake"]} cards={[]} connections={[]} onStart={onStart} startedMessage={(n) => `Asked ${n}.`} />);
    await userEvent.type(screen.getByLabelText("Prompt"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
