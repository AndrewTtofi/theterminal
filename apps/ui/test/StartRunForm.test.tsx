import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderAsOwner as render } from "./as-owner";
import userEvent from "@testing-library/user-event";
import type { Card, Connection, MachineCapacity } from "@theterminal/shared";
import { StartRunForm } from "../src/components/StartRunForm";
import { LOCAL_MODEL_NOTE } from "../src/api";
import { machine } from "./machines-fixtures";

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

  describe("on a local model", () => {
    const qwen = { id: "lm1", kind: "llm", provider: "local_model", name: "Qwen on Ollama", enabled: true } as unknown as Connection;
    const llama = { id: "lm2", kind: "llm", provider: "local_model", name: "Llama", enabled: true } as unknown as Connection;
    const off = { id: "lm3", kind: "llm", provider: "local_model", name: "Off", enabled: false } as unknown as Connection;
    const claude = { id: "c-1", kind: "llm", provider: "claude", name: "Claude key", enabled: true } as unknown as Connection;

    it("lists the enabled local models under their own heading, and sends the one chosen with Codex", async () => {
      const onStart = vi.fn().mockResolvedValue(true);
      render(<StartRunForm adapters={["codex", "claude"]} cards={[]} connections={[aws, qwen, llama, off, claude]} onStart={onStart} />);
      expect(screen.getByRole("group", { name: "Run on a local model" })).toBeTruthy();
      expect(screen.queryByLabelText("Off")).toBeNull();
      expect(screen.queryByLabelText(/Claude key/)).toBeNull();
      await userEvent.click(screen.getByLabelText("Qwen on Ollama"));
      // Only one local model per run: choosing another replaces it.
      await userEvent.click(screen.getByLabelText("Llama"));
      expect((screen.getByLabelText("Qwen on Ollama") as HTMLInputElement).checked).toBe(false);
      await userEvent.type(screen.getByLabelText("Prompt"), "go");
      await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
      expect(onStart).toHaveBeenCalledWith("codex", "go", ["lm2"]);
    });

    it("disables the local models for any agent but Codex, says why, and never sends one", async () => {
      const onStart = vi.fn().mockResolvedValue(true);
      render(<StartRunForm adapters={["codex", "claude"]} cards={[]} connections={[qwen]} onStart={onStart} />);
      await userEvent.click(screen.getByLabelText("Qwen on Ollama"));
      await userEvent.selectOptions(screen.getByLabelText("Agent"), "claude");
      const box = screen.getByLabelText("Qwen on Ollama") as HTMLInputElement;
      expect(box.disabled).toBe(true);
      expect(box.checked).toBe(false);
      expect(screen.getByText("Only Codex can run on a local model in The Terminal yet.")).toBeTruthy();
      await userEvent.type(screen.getByLabelText("Prompt"), "go");
      await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
      expect(onStart).toHaveBeenCalledWith("claude", "go", []);
    });
  });
  describe("offline", () => {
    const NOTE = "You seem to be offline. Cloud models will not answer; a local model will.";
    const qwen = { id: "lm1", kind: "llm", provider: "local_model", name: "Qwen on Ollama", enabled: true } as unknown as Connection;

    it("notes that cloud models will not answer, and still starts the run", async () => {
      const onStart = vi.fn().mockResolvedValue(true);
      render(<StartRunForm adapters={["claude"]} cards={[]} connections={[]} offline onStart={onStart} />);
      expect(screen.getByText(NOTE)).toBeTruthy();
      await userEvent.type(screen.getByLabelText("Prompt"), "go");
      const start = screen.getByRole("button", { name: "Start agent" }) as HTMLButtonElement;
      expect(start.disabled).toBe(false);
      await userEvent.click(start);
      expect(onStart).toHaveBeenCalledWith("claude", "go", []);
    });

    it("drops the note once a local model is ticked with Codex, and brings it back when the tick is cleared", async () => {
      render(<StartRunForm adapters={["codex"]} cards={[]} connections={[qwen]} offline onStart={vi.fn()} />);
      expect(screen.getByText(NOTE)).toBeTruthy();
      await userEvent.click(screen.getByLabelText("Qwen on Ollama"));
      expect(screen.queryByText(NOTE)).toBeNull();
      await userEvent.click(screen.getByLabelText("Qwen on Ollama"));
      expect(screen.getByText(NOTE)).toBeTruthy();
    });

    it("keeps the note for an agent that cannot use the ticked local model", async () => {
      render(<StartRunForm adapters={["codex", "claude"]} cards={[]} connections={[qwen]} offline onStart={vi.fn()} />);
      await userEvent.click(screen.getByLabelText("Qwen on Ollama"));
      expect(screen.queryByText(NOTE)).toBeNull();
      await userEvent.selectOptions(screen.getByLabelText("Agent"), "claude");
      expect(screen.getByText(NOTE)).toBeTruthy();
    });

    it("says nothing for the fake agent, or when not offline", () => {
      const { unmount } = render(<StartRunForm adapters={["fake"]} cards={[]} connections={[]} offline onStart={vi.fn()} />);
      expect(screen.queryByText(NOTE)).toBeNull();
      unmount();
      render(<StartRunForm adapters={["claude"]} cards={[]} connections={[]} onStart={vi.fn()} />);
      expect(screen.queryByText(NOTE)).toBeNull();
    });
  });

  describe("Run on", () => {
    const gpu = machine({ id: "m1", name: "GPU box", online: true });
    const away = machine({ id: "m2", name: "Old laptop", online: false });
    const changed = machine({ id: "m3", name: "Studio", online: false, problem: "key_mismatch" });
    const caps = (over: Partial<MachineCapacity> = {}): MachineCapacity => ({
      machineId: "m1", name: "GPU box", online: true, checkedAt: "2026-11-15T10:00:00.000Z", lastSeenAt: null, problem: null,
      hardware: null, localModels: [], sources: [], adapters: ["fake", "codex"],
      connections: [
        { id: "r1", kind: "cloud", provider: "aws", name: "Remote AWS" },
        { id: "lm", kind: "llm", provider: "local_model", name: "Big model" },
      ],
      ...over,
    });

    it("lists This computer and every paired machine; an offline one is disabled and says so; none paired, no picker", () => {
      const { rerender } = render(<StartRunForm adapters={["fake"]} cards={[]} connections={[]} machines={[gpu, away, changed]} onStart={vi.fn()} />);
      const picker = screen.getByLabelText("Run on") as HTMLSelectElement;
      // A machine whose address answered with another key is said so, never as offline.
      expect([...picker.options].map((o) => [o.textContent, o.disabled])).toEqual([
        ["This computer", false],
        ["GPU box", false],
        ["Old laptop (offline)", true],
        ["Studio (key changed)", true],
      ]);
      expect(picker.value).toBe("");
      // A machine not checked yet (online null) can be chosen: only one that failed its last check is offline.
      rerender(<StartRunForm adapters={["fake"]} cards={[]} connections={[]} machines={[machine({ id: "m4", name: "New box", online: null })]} onStart={vi.fn()} />);
      expect([...(screen.getByLabelText("Run on") as HTMLSelectElement).options].map((o) => [o.textContent, o.disabled])).toEqual([
        ["This computer", false],
        ["New box", false],
      ]);
      rerender(<StartRunForm adapters={["fake"]} cards={[]} connections={[]} machines={[]} onStart={vi.fn()} />);
      expect(screen.queryByLabelText("Run on")).toBeNull();
    });

    it("a machine's connections replace this computer's, under a legend naming it, and Start sends the machine", async () => {
      const onStart = vi.fn().mockResolvedValue(true);
      const machineCapacity = vi.fn().mockResolvedValue(caps());
      render(
        <StartRunForm
          adapters={["fake", "codex"]} cards={[]} connections={[aws]} machines={[gpu, away]} machineCapacity={machineCapacity} onStart={onStart}
        />,
      );
      expect(screen.getByRole("group", { name: "Give this run access to" })).toBeTruthy();
      await userEvent.selectOptions(screen.getByLabelText("Run on"), "m1");
      expect(machineCapacity).toHaveBeenCalledWith("m1");
      expect(await screen.findByRole("group", { name: "Give this run access to (on GPU box)" })).toBeTruthy();
      expect(screen.queryByLabelText("AWS prod (cloud account)")).toBeNull();
      // The local-model rule applies to the machine's local models too: only Codex runs on one.
      const local = screen.getByLabelText("Big model") as HTMLInputElement;
      expect(local.disabled).toBe(true);
      expect(screen.getByText(LOCAL_MODEL_NOTE)).toBeTruthy();
      await userEvent.click(screen.getByLabelText("Remote AWS (cloud account)"));
      await userEvent.type(screen.getByLabelText("Prompt"), "Train it");
      await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
      expect(onStart).toHaveBeenCalledWith("fake", "Train it", ["r1"], undefined, "m1");
    });

    it("back on This computer, its own connections return and nothing names a machine", async () => {
      const onStart = vi.fn().mockResolvedValue(true);
      render(
        <StartRunForm
          adapters={["fake"]} cards={[]} connections={[aws]} machines={[gpu]} machineCapacity={vi.fn().mockResolvedValue(caps())} onStart={onStart}
        />,
      );
      await userEvent.selectOptions(screen.getByLabelText("Run on"), "m1");
      await screen.findByLabelText("Remote AWS (cloud account)");
      await userEvent.click(screen.getByLabelText("Remote AWS (cloud account)"));
      await userEvent.selectOptions(screen.getByLabelText("Run on"), "");
      expect(screen.getByLabelText("AWS prod (cloud account)")).toBeTruthy();
      await userEvent.type(screen.getByLabelText("Prompt"), "Here");
      await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
      expect(onStart).toHaveBeenCalledWith("fake", "Here", []);
    });

    it("a machine's own words render inert, with invisible characters shown", async () => {
      const sneaky = machine({ id: "m3", name: "GPU\u202Ebox<b>", online: true });
      render(
        <StartRunForm
          adapters={["fake"]} cards={[]} connections={[]} machines={[sneaky]}
          machineCapacity={vi.fn().mockResolvedValue(caps({ connections: [{ id: "r9", kind: "mcp", provider: "mcp_http", name: "Docs\u200B<i>x</i>" }] }))}
          onStart={vi.fn()}
        />,
      );
      const option = [...(screen.getByLabelText("Run on") as HTMLSelectElement).options][1]!;
      expect(option.textContent).not.toContain("\u202E");
      expect(option.textContent).toContain("<b>");
      await userEvent.selectOptions(screen.getByLabelText("Run on"), "m3");
      const label = await screen.findByText(/Docs/);
      expect(label.textContent).not.toContain("\u200B");
      expect(label.textContent).toContain("<i>x</i>");
      expect(document.querySelector("b, i")).toBeNull();
    });

    it("a machine that cannot be asked says so, and the form still starts the run there", async () => {
      const onStart = vi.fn().mockResolvedValue(true);
      render(
        <StartRunForm adapters={["fake"]} cards={[]} connections={[]} machines={[gpu]} machineCapacity={vi.fn().mockRejectedValue(new Error("x"))} onStart={onStart} />,
      );
      await userEvent.selectOptions(screen.getByLabelText("Run on"), "m1");
      expect((await screen.findByText("Could not ask GPU box what it offers.")).getAttribute("role")).toBe("status");
      await userEvent.type(screen.getByLabelText("Prompt"), "Go");
      await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
      expect(onStart).toHaveBeenCalledWith("fake", "Go", [], undefined, "m1");
    });
  });

  it("shows a hidden block cursor in the prompt box only while it is empty and focused", async () => {
    render(<StartRunForm adapters={["fake"]} cards={cards} connections={[]} onStart={vi.fn()} />);
    const box = screen.getByLabelText("Prompt");
    const cursor = () => box.parentElement!.querySelector(".cursor");
    expect(cursor()).toBeNull();
    await userEvent.click(box);
    expect(cursor()?.getAttribute("aria-hidden")).toBe("true");
    await userEvent.type(box, "x");
    expect(cursor()).toBeNull();
    await userEvent.clear(box);
    expect(cursor()).not.toBeNull();
    await userEvent.tab();
    expect(cursor()).toBeNull();
  });
});
