import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { OVERRIDE_MEANS } from "@theterminal/shared";
import type { AgentRun, LedgerEntry } from "@theterminal/shared";
import { OverrideSection } from "../src/components/OverrideSection";
import { ShellContext } from "../src/shell/model";
import type { ShellContextValue, WorkbenchModel } from "../src/shell/model";
import { BASE, changes, run1 } from "./changes-fixtures";
import { shellNav } from "./connections-harness";

const REASON = "The agent left a broken build";

let seq = 0;
const overrideEntry = (type: LedgerEntry["type"], payload: Record<string, unknown>): LedgerEntry => ({
  seq: ++seq, id: `o${seq}`, ts: "2026-11-15T10:00:00.000Z", projectId: "p1", actor: { kind: "human", id: "owner" }, type,
  payload: { runId: "run1", ...payload }, prevHash: "", hash: "",
});

function setup(over: Partial<WorkbenchModel> = {}, run: AgentRun = run1) {
  const model = {
    changesRunId: "run1",
    // No commits by the agent (head is the fork point), so every changed file is uncommitted.
    changes: changes({ head: BASE }),
    entries: [],
    onOverrideDiscard: vi.fn(async () => true),
    onOverrideCommand: vi.fn(async () => true),
    ...over,
  } as unknown as WorkbenchModel;
  const shell: ShellContextValue = { model, dock: () => null, ...shellNav() };
  render(
    <ShellContext.Provider value={shell}>
      <OverrideSection run={run} />
    </ShellContext.Provider>,
  );
  const section = () => screen.getByText("Emergency override").closest("details") as HTMLElement;
  return { model, shell, section };
}

const discardForm = () => screen.getByRole("group", { name: "Discard this run's changes" });
const commandForm = () => screen.getByRole("group", { name: "Run a command in this run's working copy" });
const type = (label: string, value: string, within_: HTMLElement) =>
  fireEvent.change(within(within_).getByLabelText(label), { target: { value } });
const WHY = "Why? (required, at least 10 characters)";

describe("OverrideSection", () => {
  it("says plainly what an override is and links to Learn", () => {
    const { shell, section } = setup();
    const details = section();
    expect(details.className).toContain("override");
    expect(screen.getByText("Emergency override").tagName).toBe("SUMMARY");
    expect(details.textContent).toContain(OVERRIDE_MEANS);
    expect(details.textContent).toContain(
      "It runs as you, outside the agent gate and the working copy's sandbox, and it can change files.",
    );
    fireEvent.click(within(details).getByRole("button", { name: "Learn more" }));
    expect(shell.openLearn).toHaveBeenCalledWith("emergency_override");
  });

  it("keeps Discard disabled until the reason has 10 characters, then discards with the trimmed reason", async () => {
    const { model } = setup();
    expect(discardForm().textContent).toContain("Commits the agent made are kept.");
    expect(within(discardForm()).queryByLabelText(WHY)).toBeNull();
    fireEvent.click(within(discardForm()).getByRole("button", { name: "Discard…" }));
    const go = within(discardForm()).getByRole("button", { name: "Discard 1 file" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    type(WHY, "   short    ", discardForm());
    expect(go.disabled).toBe(true);
    type(WHY, `  ${REASON}  `, discardForm());
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(model.onOverrideDiscard).toHaveBeenCalledWith("run1", REASON));
    expect(await screen.findByText("Recorded. Watch the Ledger or the Terminal for the result.")).toBeTruthy();
    expect(within(discardForm()).queryByLabelText(WHY)).toBeNull();
  });

  it("does not claim a file count when the agent committed, since only uncommitted files are discarded", () => {
    setup({ changes: changes() });
    fireEvent.click(within(discardForm()).getByRole("button", { name: "Discard…" }));
    expect(within(discardForm()).getByRole("button", { name: "Discard uncommitted changes" })).toBeTruthy();
  });

  it("asks for confirmation showing the exact command and folder, then sends it and clears the form", async () => {
    const { model } = setup();
    const form = commandForm();
    expect((within(form).getByLabelText("Program") as HTMLInputElement).placeholder).toBe("git");
    expect(form.textContent).toContain(
      "The program is started directly, not through a shell, with no connection keys in its environment; files in your home folder are still readable. Output is recorded in the ledger.",
    );
    const run = within(form).getByRole("button", { name: "Run as override" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    type("Program", "git", form);
    type("Arguments (one per line)", "status\n--short\n", form);
    type(WHY, "short", form);
    expect(run.disabled).toBe(true);
    type(WHY, REASON, form);
    expect(run.disabled).toBe(false);
    fireEvent.click(run);

    const confirm = within(form).getByRole("group", { name: "Confirm the override" });
    expect(within(confirm).getByText("git").tagName).toBe("CODE");
    expect(within(confirm).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["status", "--short"]);
    expect(confirm.textContent).toContain("the top of the working copy");
    expect(model.onOverrideCommand).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm and run" }));

    await waitFor(() =>
      expect(model.onOverrideCommand).toHaveBeenCalledWith("run1", { program: "git", args: ["status", "--short"], reason: REASON }),
    );
    expect(await within(form).findByText("Recorded. Watch the Ledger or the Terminal for the result.")).toBeTruthy();
    expect((within(form).getByLabelText("Program") as HTMLInputElement).value).toBe("");
    expect((within(form).getByLabelText(WHY) as HTMLInputElement).value).toBe("");
  });

  it("sends the folder when one is given, and goes back from the confirmation without running", async () => {
    const { model } = setup();
    const form = commandForm();
    type("Program", "npm", form);
    type("Arguments (one per line)", "test", form);
    type("Folder (optional, inside the working copy)", " web ", form);
    type(WHY, REASON, form);
    fireEvent.click(within(form).getByRole("button", { name: "Run as override" }));
    expect(within(form).getByRole("group", { name: "Confirm the override" }).textContent).toContain("web");
    fireEvent.click(within(form).getByRole("button", { name: "Back" }));
    expect(within(form).queryByRole("group", { name: "Confirm the override" })).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Run as override" }));
    fireEvent.click(within(form).getByRole("button", { name: "Confirm and run" }));
    await waitFor(() =>
      expect(model.onOverrideCommand).toHaveBeenCalledWith("run1", { program: "npm", args: ["test"], cwd: "web", reason: REASON }),
    );
  });

  it("refuses a program name it could never run", () => {
    setup();
    const form = commandForm();
    type("Program", "git status; rm", form);
    type(WHY, REASON, form);
    expect((within(form).getByRole("button", { name: "Run as override" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps what was typed when the override is refused", async () => {
    const { model } = setup({ onOverrideCommand: vi.fn(async () => false) });
    const form = commandForm();
    type("Program", "git", form);
    type(WHY, REASON, form);
    fireEvent.click(within(form).getByRole("button", { name: "Run as override" }));
    fireEvent.click(within(form).getByRole("button", { name: "Confirm and run" }));
    await waitFor(() => expect(model.onOverrideCommand).toHaveBeenCalled());
    expect((within(form).getByLabelText("Program") as HTMLInputElement).value).toBe("git");
    expect(within(form).queryByText("Recorded. Watch the Ledger or the Terminal for the result.")).toBeNull();
  });

  it("disables both forms with a sentence while the agent is running", () => {
    setup({}, { ...run1, status: "running" });
    expect(screen.getByText("Stop the agent first.")).toBeTruthy();
    expect((discardForm() as HTMLFieldSetElement).disabled).toBe(true);
    expect((commandForm() as HTMLFieldSetElement).disabled).toBe(true);
  });

  it("disables both forms while another override of the run has not finished", () => {
    const command = overrideEntry("override.command", { overrideId: "ov1", program: "git", args: [], cwd: ".", reason: REASON });
    setup({ entries: [command] });
    expect(screen.getByText("An override is already running for this run")).toBeTruthy();
    expect((discardForm() as HTMLFieldSetElement).disabled).toBe(true);
    expect((commandForm() as HTMLFieldSetElement).disabled).toBe(true);
  });

  it("enables the forms again once that override completed, and ignores other runs' overrides", () => {
    const command = overrideEntry("override.command", { overrideId: "ov1", program: "git", args: [], cwd: ".", reason: REASON });
    const done = overrideEntry("override.completed", {
      overrideId: "ov1", ok: true, exitCode: 0, signal: null, timedOut: false, durationMs: 5, output: "",
    });
    const other = { ...overrideEntry("override.discard", { overrideId: "ov2", reason: REASON, files: 1 }), payload: { runId: "run9", overrideId: "ov2" } };
    setup({ entries: [done, command, other] });
    expect(screen.queryByText("An override is already running for this run")).toBeNull();
    expect((discardForm() as HTMLFieldSetElement).disabled).toBe(false);
    expect((commandForm() as HTMLFieldSetElement).disabled).toBe(false);
  });
});
