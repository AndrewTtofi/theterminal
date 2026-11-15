import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OVERRIDE_MEANS } from "@theterminal/shared";
import type { AgentRun, LedgerEntry } from "@theterminal/shared";
import { OverrideSection } from "../src/components/OverrideSection";
import { ShellContext } from "../src/shell/model";
import type { ShellContextValue, WorkbenchModel } from "../src/shell/model";
import { BASE, changes, run1 } from "./changes-fixtures";
import { shellNav } from "./connections-harness";
import { OWNER_ME } from "./as-owner";

const REASON = "The agent left a broken build";
const REFUSED = "Stop the agent first: it is still working in this run";

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
    projectEntries: [],
    onOverrideDiscard: vi.fn(async () => ({ ok: true as const, files: 3 })),
    onOverrideCommand: vi.fn(async () => ({ ok: true as const })),
    me: OWNER_ME,
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
const RECORDED = "Recorded. Watch the Ledger or the Terminal for the result.";

/** Fills the command form and opens its confirmation. */
function confirmCommand(program: string, args: string, extra?: () => void) {
  const form = commandForm();
  type("Program", program, form);
  type("Arguments (one per line)", args, form);
  extra?.();
  type(WHY, REASON, form);
  fireEvent.click(within(form).getByRole("button", { name: "Run as override" }));
  return within(form).getByRole("group", { name: "Confirm the override" });
}

/** Opens the discard form, gives the reason and opens its confirmation. */
function confirmDiscard(button: string | RegExp = /^Discard \d/) {
  fireEvent.click(within(discardForm()).getByRole("button", { name: "Discard…" }));
  type(WHY, REASON, discardForm());
  fireEvent.click(within(discardForm()).getByRole("button", { name: button }));
  return within(discardForm()).getByRole("group", { name: "Confirm the discard" });
}

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

  it("focuses the reason when the discard form opens, and needs 10 characters before it goes on", () => {
    setup();
    expect(discardForm().textContent).toContain("Commits the agent made are kept.");
    expect(within(discardForm()).queryByLabelText(WHY)).toBeNull();
    fireEvent.click(within(discardForm()).getByRole("button", { name: "Discard…" }));
    const why = within(discardForm()).getByLabelText(WHY);
    expect(document.activeElement).toBe(why);
    const go = within(discardForm()).getByRole("button", { name: "Discard 1 file" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    type(WHY, "   short    ", discardForm());
    expect(go.disabled).toBe(true);
    type(WHY, `  ${REASON}  `, discardForm());
    expect(go.disabled).toBe(false);
  });

  it("confirms a discard first, then sends the trimmed reason and shows the server's count", async () => {
    const { model } = setup();
    const status = within(discardForm()).getByRole("status");
    expect(status.textContent).toBe("");
    fireEvent.click(within(discardForm()).getByRole("button", { name: "Discard…" }));
    type(WHY, `  ${REASON}  `, discardForm());
    fireEvent.click(within(discardForm()).getByRole("button", { name: "Discard 1 file" }));
    const confirm = within(discardForm()).getByRole("group", { name: "Confirm the discard" });
    expect(document.activeElement).toBe(confirm);
    expect(confirm.textContent).toContain("This runs git read-tree HEAD, git reset --hard --no-recurse-submodules HEAD, then git clean -fd in the run's folder");
    expect(model.onOverrideDiscard).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm discard" }));
    await waitFor(() => expect(model.onOverrideDiscard).toHaveBeenCalledWith("run1", REASON));
    await waitFor(() => expect(status.textContent).toBe("Recorded: 3 uncommitted files discarded. Watch the Ledger or the Terminal for the result."));
    expect(within(discardForm()).queryByLabelText(WHY)).toBeNull();
  });

  it("goes back from the discard confirmation without discarding", () => {
    const { model } = setup();
    const confirm = confirmDiscard();
    fireEvent.click(within(confirm).getByRole("button", { name: "Back" }));
    expect(within(discardForm()).queryByRole("group", { name: "Confirm the discard" })).toBeNull();
    expect(document.activeElement).toBe(within(discardForm()).getByRole("button", { name: "Discard 1 file" }));
    expect(model.onOverrideDiscard).not.toHaveBeenCalled();
  });

  it("shows a refused discard inside the form and keeps the confirmation open", async () => {
    setup({ onOverrideDiscard: vi.fn(async () => ({ ok: false as const, error: REFUSED })) });
    const confirm = confirmDiscard();
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm discard" }));
    expect((await within(discardForm()).findByRole("alert")).textContent).toBe(REFUSED);
    expect(within(discardForm()).getByRole("group", { name: "Confirm the discard" })).toBeTruthy();
    expect((within(discardForm()).getByLabelText(WHY) as HTMLInputElement).value).toBe(REASON);
  });

  it("does not claim a file count when the agent committed, since only uncommitted files are discarded", () => {
    setup({ changes: changes() });
    fireEvent.click(within(discardForm()).getByRole("button", { name: "Discard…" }));
    expect(within(discardForm()).getByRole("button", { name: "Discard uncommitted changes" })).toBeTruthy();
  });

  it("still allows a discard when the cached changes list nothing, since they may be stale", () => {
    setup({ changes: changes({ head: BASE, files: [] }) });
    fireEvent.click(within(discardForm()).getByRole("button", { name: "Discard…" }));
    type(WHY, REASON, discardForm());
    const go = within(discardForm()).getByRole("button", { name: "Discard uncommitted changes" }) as HTMLButtonElement;
    expect(go.disabled).toBe(false);
  });

  it("asks for confirmation showing the exact command and folder, then sends it and clears the form", async () => {
    const { model } = setup();
    const form = commandForm();
    expect((within(form).getByLabelText("Program") as HTMLInputElement).placeholder).toBe("git");
    expect(form.textContent).toContain(
      "The program is started directly, not through a shell, with no connection keys in its environment. Anything you can reach, including files in your home folder, stays reachable to the program. Output is recorded in the ledger.",
    );
    const status = within(form).getByRole("status");
    expect(status.textContent).toBe("");
    const run = within(form).getByRole("button", { name: "Run as override" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    type("Program", "git", form);
    type("Arguments (one per line)", "status\n --short \n", form);
    type(WHY, "short", form);
    expect(run.disabled).toBe(true);
    type(WHY, REASON, form);
    expect(run.disabled).toBe(false);
    fireEvent.click(run);

    const confirm = within(form).getByRole("group", { name: "Confirm the override" });
    expect(document.activeElement).toBe(confirm);
    expect(within(confirm).getByText("git").tagName).toBe("CODE");
    // Quoted, so leading and trailing spaces show.
    expect(within(confirm).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["“status”", "“ --short ”"]);
    expect(confirm.textContent).toContain("the top of the working copy");
    expect(model.onOverrideCommand).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm and run" }));

    await waitFor(() =>
      expect(model.onOverrideCommand).toHaveBeenCalledWith("run1", { program: "git", args: ["status", " --short "], reason: REASON }),
    );
    await waitFor(() => expect(status.textContent).toBe(RECORDED));
    expect((within(form).getByLabelText("Program") as HTMLInputElement).value).toBe("");
    expect((within(form).getByLabelText(WHY) as HTMLInputElement).value).toBe("");
  });

  it("sends the folder when one is given, and Back returns focus to Run as override without running", async () => {
    const { model } = setup();
    const form = commandForm();
    const confirm = confirmCommand("npm", "test", () => type("Folder (optional, inside the working copy)", " web ", form));
    expect(confirm.textContent).toContain("web");
    fireEvent.click(within(form).getByRole("button", { name: "Back" }));
    expect(within(form).queryByRole("group", { name: "Confirm the override" })).toBeNull();
    expect(document.activeElement).toBe(within(form).getByRole("button", { name: "Run as override" }));
    fireEvent.click(within(form).getByRole("button", { name: "Run as override" }));
    fireEvent.click(within(form).getByRole("button", { name: "Confirm and run" }));
    await waitFor(() =>
      expect(model.onOverrideCommand).toHaveBeenCalledWith("run1", { program: "npm", args: ["test"], cwd: "web", reason: REASON }),
    );
  });

  it("does not run the command when Enter is pressed in a field", async () => {
    const { model } = setup();
    const form = commandForm();
    await userEvent.type(within(form).getByLabelText("Program"), "git{Enter}");
    await userEvent.type(within(form).getByLabelText(WHY), `${REASON}{Enter}`);
    await userEvent.type(within(form).getByLabelText("Folder (optional, inside the working copy)"), "{Enter}");
    expect(within(form).queryByRole("group", { name: "Confirm the override" })).toBeNull();
    expect(model.onOverrideCommand).not.toHaveBeenCalled();
  });

  it("refuses a program name it could never run", () => {
    setup();
    const form = commandForm();
    type("Program", "git status; rm", form);
    type(WHY, REASON, form);
    expect((within(form).getByRole("button", { name: "Run as override" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a refused command inside the form, keeps the confirmation open and what was typed", async () => {
    const { model } = setup({ onOverrideCommand: vi.fn(async () => ({ ok: false as const, error: REFUSED })) });
    const form = commandForm();
    const confirm = confirmCommand("git", "status");
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm and run" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(REFUSED);
    expect(model.onOverrideCommand).toHaveBeenCalledTimes(1);
    expect(within(form).getByRole("group", { name: "Confirm the override" })).toBeTruthy();
    expect((within(form).getByLabelText("Program") as HTMLInputElement).value).toBe("git");
    expect(within(form).getByRole("status").textContent).toBe("");
    fireEvent.click(within(form).getByRole("button", { name: "Back" }));
    expect(within(form).queryByRole("alert")).toBeNull();
  });

  it("disables both forms with a sentence while the agent is running", () => {
    setup({}, { ...run1, status: "running" });
    expect(screen.getByText("Stop the agent first.")).toBeTruthy();
    expect((discardForm() as HTMLFieldSetElement).disabled).toBe(true);
    expect((commandForm() as HTMLFieldSetElement).disabled).toBe(true);
  });

  it("disables both forms while another override of the run has not finished", () => {
    const command = overrideEntry("override.command", { overrideId: "ov1", program: "git", args: [], cwd: ".", reason: REASON });
    setup({ projectEntries: [command] });
    expect(screen.getByText("An override is already running for this run")).toBeTruthy();
    expect((discardForm() as HTMLFieldSetElement).disabled).toBe(true);
    expect((commandForm() as HTMLFieldSetElement).disabled).toBe(true);
  });

  it("reads the project's stream, not the Ledger's page, which may be every project's or still loading", () => {
    const command = overrideEntry("override.command", { overrideId: "ov1", program: "git", args: [], cwd: ".", reason: REASON });
    setup({ entries: [], projectEntries: [command] });
    expect(screen.getByText("An override is already running for this run")).toBeTruthy();
    expect((commandForm() as HTMLFieldSetElement).disabled).toBe(true);
  });

  it("enables the forms again once that override completed, and ignores other runs' overrides", () => {
    const command = overrideEntry("override.command", { overrideId: "ov1", program: "git", args: [], cwd: ".", reason: REASON });
    const done = overrideEntry("override.completed", {
      overrideId: "ov1", ok: true, exitCode: 0, signal: null, timedOut: false, durationMs: 5, output: "",
    });
    const other = { ...overrideEntry("override.discard", { overrideId: "ov2", reason: REASON, files: 1 }), payload: { runId: "run9", overrideId: "ov2" } };
    setup({ projectEntries: [done, command, other] });
    expect(screen.queryByText("An override is already running for this run")).toBeNull();
    expect((discardForm() as HTMLFieldSetElement).disabled).toBe(false);
    expect((commandForm() as HTMLFieldSetElement).disabled).toBe(false);
  });
});
