import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LINKING_ACK } from "@theterminal/shared";

vi.mock("../src/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/api")>();
  return {
    ...real,
    api: { renameMachine: vi.fn(), enableLinking: vi.fn(), disableLinking: vi.fn(), unpairMachine: vi.fn(), getMachineCapacity: vi.fn() },
  };
});

import { api, ApiError } from "../src/api";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { MachinesSideBar } from "../src/views/MachinesSideBar";
import { fakeDock, shellNav } from "./connections-harness";
import { machine, overview, self } from "./machines-fixtures";
import { machines as capacities } from "./capacity-fixtures";

const m = vi.mocked(api);

function renderSideBar(machines: Partial<WorkbenchModel["machines"]>) {
  const refresh = vi.fn();
  const dock = fakeDock();
  const model = { machines: { overview: null, error: null, refresh, ...machines } } as unknown as WorkbenchModel;
  const view = render(
    <ShellContext.Provider value={{ model, dock: () => dock, ...shellNav() }}>
      <MachinesSideBar />
    </ShellContext.Provider>,
  );
  return { refresh, dock, ...view };
}

const allowLinking = () => screen.getByRole("switch", { name: "Allow linking" });

beforeEach(() => {
  vi.clearAllMocks();
  m.getMachineCapacity.mockResolvedValue(capacities[0]!);
});

describe("MachinesSideBar", () => {
  it("loads the overview when it opens", () => {
    const { refresh } = renderSideBar({});
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("says why it cannot load", () => {
    renderSideBar({ error: "request_failed" });
    expect(screen.getByText("Could not load machines")).toBeTruthy();
  });

  it("shows only the keychain sentence when this computer has no identity", () => {
    renderSideBar({ overview: overview({ identity: "unavailable", self: null }) });
    expect(screen.getByText("Your keychain is unavailable, so this computer has no identity for linking.")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Link a machine" })).toBeNull();
  });

  it("shows this computer's name, fingerprint in groups of four and the linking switch, off", () => {
    renderSideBar({ overview: overview() });
    const section = screen.getByRole("region", { name: "This computer" });
    expect(within(section).getByText("Mac")).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Rename" })).toBeTruthy();
    expect(section.textContent).toContain("Fingerprint a1b2 c3d4 e5f6 0718");
    expect(allowLinking().getAttribute("aria-checked")).toBe("false");
    expect(section.textContent).not.toContain("Linking on");
  });

  it("asks for the exact acknowledgement before turning linking on, and posts it only after the checkbox", async () => {
    m.enableLinking.mockResolvedValue(self({ linking: { enabled: true, port: 4418 } }));
    const { refresh } = renderSideBar({ overview: overview() });
    refresh.mockClear();
    await userEvent.click(allowLinking());
    const dialog = screen.getByRole("dialog", { name: "Allow linking" });
    expect(within(dialog).getByText(LINKING_ACK)).toBeTruthy();
    const allow = within(dialog).getByRole("button", { name: "Allow" }) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    await userEvent.click(allow);
    expect(m.enableLinking).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "I have read this" }));
    expect(allow.disabled).toBe(false);
    await userEvent.click(allow);
    expect(m.enableLinking).toHaveBeenCalledWith(LINKING_ACK);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(refresh).toHaveBeenCalled();
  });

  it("sends nothing when the dialog is cancelled", async () => {
    renderSideBar({ overview: overview() });
    await userEvent.click(allowLinking());
    await userEvent.click(screen.getByRole("checkbox", { name: "I have read this" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(m.enableLinking).not.toHaveBeenCalled();
    // Opening it again starts unticked.
    await userEvent.click(allowLinking());
    expect((screen.getByRole("checkbox", { name: "I have read this" }) as HTMLInputElement).checked).toBe(false);
  });

  it("shows a refusal to turn linking on", async () => {
    m.enableLinking.mockRejectedValue(new ApiError(503, "identity_unavailable"));
    renderSideBar({ overview: overview() });
    await userEvent.click(allowLinking());
    await userEvent.click(screen.getByRole("checkbox", { name: "I have read this" }));
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Your keychain is unavailable, so this computer has no identity for linking.",
    );
  });

  it("shows the port when linking is on, and turns it off without a dialog", async () => {
    m.disableLinking.mockResolvedValue(self());
    const { refresh } = renderSideBar({ overview: overview({ self: self({ linking: { enabled: true, port: 4418 } }) }) });
    refresh.mockClear();
    expect(screen.getByText("Linking on · port 4418")).toBeTruthy();
    expect(allowLinking().getAttribute("aria-checked")).toBe("true");
    await userEvent.click(allowLinking());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(m.disableLinking).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("renames this computer with a short name and the ledger help", async () => {
    m.renameMachine.mockResolvedValue(self({ name: "GPU desktop" }));
    const { refresh } = renderSideBar({ overview: overview() });
    refresh.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Computer name" }) as HTMLInputElement;
    expect(input.maxLength).toBe(40);
    expect(input.value).toBe("Mac");
    expect(screen.getByText('Pick a short name such as "Mac" or "GPU desktop". It is recorded in the ledger of every machine you link.')).toBeTruthy();
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
    await userEvent.clear(input);
    await userEvent.type(input, "GPU desktop");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(m.renameMachine).toHaveBeenCalledWith("GPU desktop");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Computer name" })).toBeNull());
    expect(refresh).toHaveBeenCalled();
  });

  it("sends one rename when Enter is pressed twice", async () => {
    m.renameMachine.mockReturnValue(new Promise(() => {}));
    renderSideBar({ overview: overview() });
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Computer name" });
    await userEvent.type(input, "!{Enter}{Enter}");
    expect(m.renameMachine).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the unlink confirmation, and back to Unlink on Keep", async () => {
    renderSideBar({ overview: overview({ machines: [machine()] }) });
    await userEvent.click(screen.getByRole("button", { name: 'Unlink "GPU box"' }));
    const confirm = screen.getByRole("group", { name: 'Unlink "GPU box"?' });
    expect(confirm.contains(document.activeElement)).toBe(true);
    await userEvent.click(within(confirm).getByRole("button", { name: "Keep" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: 'Unlink "GPU box"' }));
  });

  it("says when no machine is linked, and opens the Link a machine tab", async () => {
    const { dock } = renderSideBar({ overview: overview() });
    const section = screen.getByRole("region", { name: "Linked machines" });
    expect(within(section).getByText("No machines linked yet.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Link a machine" }));
    expect(dock.open).toHaveBeenCalledWith("link_machine", "Link a machine", "main");
  });

  it("lists each linked machine with its presence and fingerprint", () => {
    renderSideBar({
      overview: overview({
        machines: [
          machine(),
          machine({ id: "33".repeat(16), name: "Laptop", online: false }),
          machine({ id: "44".repeat(16), name: "Spare", online: null, checkedAt: null }),
        ],
      }),
    });
    const rows = within(screen.getByRole("list", { name: "Linked machines" })).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("heading").textContent)).toEqual(["GPU box", "Laptop", "Spare"]);
    expect(rows.map((r) => r.querySelector(".machine-dot")?.textContent)).toEqual(["online", "offline", "not checked"]);
    expect(rows[0]!.textContent).toContain("Fingerprint 0f1e 2d3c 4b5a 6978");
  });

  it("unlinks a machine only after the confirmation", async () => {
    m.unpairMachine.mockResolvedValue(undefined);
    const { refresh } = renderSideBar({ overview: overview({ machines: [machine()] }) });
    refresh.mockClear();
    await userEvent.click(screen.getByRole("button", { name: 'Unlink "GPU box"' }));
    expect(m.unpairMachine).not.toHaveBeenCalled();
    const confirm = screen.getByRole("group", { name: 'Unlink "GPU box"?' });
    await userEvent.click(within(confirm).getByRole("button", { name: "Keep" }));
    expect(m.unpairMachine).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: 'Unlink "GPU box"' }));
    await userEvent.click(within(screen.getByRole("group", { name: 'Unlink "GPU box"?' })).getByRole("button", { name: "Unlink" }));
    expect(m.unpairMachine).toHaveBeenCalledWith("22".repeat(16));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("shows a remote machine's name inert, with hidden characters made visible", () => {
    const name = "GPU\u202eexe.bat\u0007<b>x</b>";
    const { container } = renderSideBar({ overview: overview({ machines: [machine({ name })] }) });
    const heading = within(screen.getByRole("list", { name: "Linked machines" })).getByRole("heading");
    expect(heading.textContent).toBe("GPU\\u202eexe.bat\\u0007<b>x</b>");
    expect(heading.querySelector("b")).toBeNull();
    expect(container.textContent).not.toMatch(/[\u202e\u0007]/);
    expect(screen.getByRole("button", { name: 'Unlink "GPU\\u202eexe.bat\\u0007<b>x</b>"' })).toBeTruthy();
  });

  it("shows each linked machine's hardware on one line, as it last answered", async () => {
    m.getMachineCapacity.mockImplementation(async (id: string) =>
      id === "22".repeat(16) ? capacities[0]! : { ...capacities[1]!, machineId: id, name: "Laptop" },
    );
    renderSideBar({ overview: overview({ machines: [machine(), machine({ id: "33".repeat(16), name: "Laptop", online: false })] }) });
    const rows = within(screen.getByRole("list", { name: "Linked machines" })).getAllByRole("listitem");
    await waitFor(() => expect(rows[0]!.querySelector(".machine-hardware")?.textContent).toBe("AMD Ryzen 9 7950X · 64 GB · NVIDIA RTX 4090"));
    // Offline: the values it last sent.
    await waitFor(() => expect(rows[1]!.querySelector(".machine-hardware")?.textContent).toBe("Apple M1 · 16 GB · GPU not detected"));
    // From the shared 30 s cache, not a fresh ask per row.
    expect(m.getMachineCapacity.mock.calls.map((c) => c.join(" ")).sort()).toEqual([`${"22".repeat(16)} true`, `${"33".repeat(16)} true`]);
  });

  it("says when a machine sent no hardware, and a fixed sentence when its capacity could not be read", async () => {
    m.getMachineCapacity.mockImplementation(async (id: string) => {
      if (id === "22".repeat(16)) return { ...capacities[0]!, hardware: null };
      throw new ApiError(502, "machine_refused", { message: "<img src=x onerror=alert(1)>refused" });
    });
    const { container } = renderSideBar({ overview: overview({ machines: [machine(), machine({ id: "33".repeat(16), name: "Laptop" })] }) });
    const rows = within(screen.getByRole("list", { name: "Linked machines" })).getAllByRole("listitem");
    await waitFor(() => expect(rows[0]!.querySelector(".machine-hardware")?.textContent).toBe("Hardware not reported"));
    await waitFor(() => expect(rows[1]!.querySelector(".machine-hardware")?.textContent).toBe("Hardware unavailable"));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).not.toContain("refused");
  });

  it("shows a remote machine's hardware with hidden characters made visible", async () => {
    m.getMachineCapacity.mockResolvedValue({ ...capacities[0]!, hardware: { ...capacities[0]!.hardware!, cpu: "Ryzen\u202E9" } });
    const { container } = renderSideBar({ overview: overview({ machines: [machine()] }) });
    const row = within(screen.getByRole("list", { name: "Linked machines" })).getByRole("listitem");
    await waitFor(() => expect(row.querySelector(".machine-hardware")?.textContent).toBe("Ryzen\\u202e9 · 64 GB · NVIDIA RTX 4090"));
    expect(container.textContent).not.toMatch(/[\u202e]/);
  });

  it("says plainly, as an alert, when a machine's key has changed", async () => {
    m.getMachineCapacity.mockRejectedValue(new ApiError(409, "machine_key_mismatch"));
    renderSideBar({ overview: overview({ machines: [machine()] }) });
    const row = within(screen.getByRole("list", { name: "Linked machines" })).getByRole("listitem");
    const alert = await within(row).findByRole("alert");
    expect(alert.textContent).toBe("This machine's key has changed. Unlink it and pair again.");
    expect(alert.className).toContain("warning");
    expect(row.querySelector(".machine-hardware")).toBeNull();
  });
});
