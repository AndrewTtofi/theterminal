import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { encodePairingCode } from "@theterminal/shared";
import type { LedgerEntry } from "@theterminal/shared";

vi.mock("../src/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/api")>();
  return { ...real, api: { showPairingCode: vi.fn(), cancelPairingCode: vi.fn(), pairMachine: vi.fn() } };
});

import { api, ApiError } from "../src/api";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { LinkMachinePanel } from "../src/views/LinkMachinePanel";
import { fakeDock, shellNav } from "./connections-harness";
import { PEER_FP, SELF_FP, machine, overview, self } from "./machines-fixtures";

const m = vi.mocked(api);
const CODE = encodePairingCode(PEER_FP, new Uint8Array([1, 2, 3, 4]));
const OWN_CODE = encodePairingCode(SELF_FP, new Uint8Array([9, 8, 7, 6]));
const NOW = new Date("2026-11-15T12:00:00.000Z");

function renderPanel(machines: Partial<WorkbenchModel["machines"]> = {}) {
  const refresh = vi.fn();
  const listeners = new Set<(e: LedgerEntry) => void>();
  const subscribeEntries = (fn: (e: LedgerEntry) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const nav = shellNav();
  const model = {
    machines: { overview: overview(), error: null, refresh, ...machines },
    subscribeEntries,
  } as unknown as WorkbenchModel;
  const view = render(
    <ShellContext.Provider value={{ model, dock: () => fakeDock(), ...nav }}>
      <LinkMachinePanel id="link_machine" />
    </ShellContext.Provider>,
  );
  const emit = (e: Partial<LedgerEntry>) => act(() => listeners.forEach((fn) => fn(e as LedgerEntry)));
  return { refresh, nav, emit, unmount: view.unmount };
}

const linkingOn = { self: self({ linking: { enabled: true, port: 4418 } }) };
const on = { overview: overview(linkingOn) };
const tab = (name: string) => screen.getByRole("tab", { name });

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("LinkMachinePanel", () => {
  it("has two tabs, Show a code first", async () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: "Link a machine" })).toBeTruthy();
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Show a code", "Enter a code"]);
    expect(tab("Show a code").getAttribute("aria-selected")).toBe("true");
    await userEvent.click(tab("Enter a code"));
    expect(tab("Enter a code").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Enter a code" })).toBeTruthy();
  });

  it("says linking must be on before a code can be shown, with a way to the switch", async () => {
    const { nav } = renderPanel();
    const panel = screen.getByRole("tabpanel", { name: "Show a code" });
    expect(within(panel).getByText("Linking must be on", { exact: false })).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Show a code" })).toBeNull();
    await userEvent.click(within(panel).getByRole("button", { name: "Open the Machines view" }));
    expect(nav.showView).toHaveBeenCalledWith("machines");
  });

  it("shows the code in large type with its expiry, this computer's fingerprint and the addresses, and cancels it", async () => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
    m.showPairingCode.mockResolvedValue({
      code: OWN_CODE,
      expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
      addresses: ["192.168.1.10:4418", "10.0.0.5:4418"],
    });
    m.cancelPairingCode.mockResolvedValue(undefined);
    renderPanel(on);
    await userEvent.click(screen.getByRole("button", { name: "Show a code" }));
    const code = await screen.findByLabelText("Pairing code");
    expect(code.textContent).toBe(OWN_CODE);
    expect(code.className).toContain("pairing-code");
    expect(screen.getByText(/Expires in (10:00|9:59)/)).toBeTruthy();
    const panel = screen.getByRole("tabpanel", { name: "Show a code" });
    expect(panel.textContent).toContain("a1b2 c3d4 e5f6 0718");
    expect(within(panel).getByText("If the other computer does not find this one, enter one of these addresses there:")).toBeTruthy();
    expect(within(panel).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["192.168.1.10:4418", "10.0.0.5:4418"]);

    await act(async () => {
      vi.advanceTimersByTime(65_000);
    });
    expect(screen.getByText("Expires in 8:55")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(m.cancelPairingCode).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByLabelText("Pairing code")).toBeNull());
  });

  it("withdraws a code still shown when the tab closes", async () => {
    m.showPairingCode.mockResolvedValue({ code: OWN_CODE, expiresAt: new Date(Date.now() + 600_000).toISOString(), addresses: [] });
    m.cancelPairingCode.mockResolvedValue(undefined);
    const { unmount } = renderPanel(on);
    await userEvent.click(screen.getByRole("button", { name: "Show a code" }));
    await screen.findByLabelText("Pairing code");
    unmount();
    expect(m.cancelPairingCode).toHaveBeenCalledTimes(1);
  });

  it("withdraws a code that arrives after the tab closed", async () => {
    let resolve!: (c: { code: string; expiresAt: string; addresses: string[] }) => void;
    m.showPairingCode.mockReturnValue(new Promise((r) => (resolve = r)));
    m.cancelPairingCode.mockResolvedValue(undefined);
    const { unmount } = renderPanel(on);
    await userEvent.click(screen.getByRole("button", { name: "Show a code" }));
    unmount();
    expect(m.cancelPairingCode).not.toHaveBeenCalled();
    await act(async () => resolve({ code: OWN_CODE, expiresAt: new Date(Date.now() + 600_000).toISOString(), addresses: [] }));
    expect(m.cancelPairingCode).toHaveBeenCalledTimes(1);
  });

  it("drops an expired code and offers a new one", async () => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
    m.showPairingCode.mockResolvedValue({ code: OWN_CODE, expiresAt: new Date(NOW.getTime() + 600_000).toISOString(), addresses: [] });
    renderPanel(on);
    await userEvent.click(screen.getByRole("button", { name: "Show a code" }));
    await screen.findByLabelText("Pairing code");
    await act(async () => {
      vi.advanceTimersByTime(601_000);
    });
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    expect(screen.getByText("The code expired.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show a new code" })).toBeTruthy();
  });

  it("says which machine linked while the code is shown, and asks the Owner to compare fingerprints", async () => {
    m.showPairingCode.mockResolvedValue({ code: OWN_CODE, expiresAt: new Date(Date.now() + 600_000).toISOString(), addresses: [] });
    const { refresh, emit } = renderPanel(on);
    await userEvent.click(screen.getByRole("button", { name: "Show a code" }));
    await screen.findByLabelText("Pairing code");
    refresh.mockClear();
    emit({
      type: "machine.paired",
      payload: { machineId: "22".repeat(16), name: "GPU box", publicKey: "A".repeat(60), fingerprint: PEER_FP, address: "192.168.1.20:4418", role: "showed_code" },
    });
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    const result = screen.getByRole("status");
    expect(result.textContent).toContain('Linked "GPU box"');
    expect(result.textContent).toContain("0f1e 2d3c 4b5a 6978");
    expect(result.textContent).toContain("compare");
    expect(result.textContent).not.toMatch(/\bmatch(es|ed)?\b/i);
    expect(refresh).toHaveBeenCalled();
  });

  it("lists the machines found on the network; picking one fills the address", async () => {
    const { refresh } = renderPanel({
      overview: overview({
        ...linkingOn,
        discovered: [{ machineId: "22".repeat(16), name: "GPU box", address: "192.168.1.20:4418", seenAt: NOW.toISOString() }],
      }),
    });
    refresh.mockClear();
    await userEvent.click(tab("Enter a code"));
    expect(refresh).toHaveBeenCalled();
    const list = screen.getByRole("listbox", { name: "Machines found on your network" });
    await userEvent.click(within(list).getByRole("option", { name: "GPU box · 192.168.1.20:4418" }));
    expect((screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement).value).toBe("192.168.1.20:4418");
  });

  it("puts one found machine in the tab order, moving between them with the arrow keys", async () => {
    renderPanel({
      overview: overview({
        discovered: [
          { machineId: "22".repeat(16), name: "GPU box", address: "192.168.1.20:4418", seenAt: NOW.toISOString() },
          { machineId: "33".repeat(16), name: "Laptop", address: "192.168.1.30:4418", seenAt: NOW.toISOString() },
        ],
      }),
    });
    await userEvent.click(tab("Enter a code"));
    const [first, second] = screen.getAllByRole("option");
    expect([first!.tabIndex, second!.tabIndex]).toEqual([0, -1]);
    first!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(second);
    expect([first!.tabIndex, second!.tabIndex]).toEqual([-1, 0]);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(first);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(second);
    await userEvent.keyboard("{Enter}");
    expect((screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement).value).toBe("192.168.1.30:4418");
  });

  it("shows a found machine's name inert, hidden characters made visible", async () => {
    renderPanel({
      overview: overview({ discovered: [{ machineId: "22".repeat(16), name: "Box​‮", address: "192.168.1.20:4418", seenAt: NOW.toISOString() }] }),
    });
    await userEvent.click(tab("Enter a code"));
    expect(screen.getByRole("option").textContent).toBe("Box\\u200b\\u202e · 192.168.1.20:4418");
  });

  it("upper-cases the code as typed, posts the address and code, and says which machine linked", async () => {
    m.pairMachine.mockResolvedValue(machine());
    const { refresh } = renderPanel();
    await userEvent.click(tab("Enter a code"));
    const address = screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement;
    const code = screen.getByRole("textbox", { name: "Code" }) as HTMLInputElement;
    expect(address.placeholder).toBe("192.168.1.10:4418");
    expect(code.placeholder).toBe("XXXXX-XXXXX-XXXXX-XXXXX");
    const link = screen.getByRole("button", { name: "Link" }) as HTMLButtonElement;
    expect(link.disabled).toBe(true);
    await userEvent.type(address, "192.168.1.20:4418");
    await userEvent.type(code, CODE.toLowerCase());
    expect(code.value).toBe(CODE);
    expect(link.disabled).toBe(false);
    refresh.mockClear();
    await userEvent.click(link);
    expect(m.pairMachine).toHaveBeenCalledWith("192.168.1.20:4418", CODE);
    const result = await screen.findByRole("status");
    await waitFor(() => expect(result.textContent).toContain('Linked "GPU box"'));
    expect(result.textContent).toContain("0f1e 2d3c 4b5a 6978");
    expect(result.textContent).not.toMatch(/\bmatch(es|ed)?\b/i);
    expect(refresh).toHaveBeenCalled();
    expect(code.value).toBe("");
  });

  it.each([
    ["pairing_code_mismatch", 400, "That code was not shown by the machine at this address"],
    ["pairing_rejected", 403, "The other machine rejected the code"],
    ["no_pairing", 404, "That machine is not showing a code right now"],
    ["machine_unreachable", 502, "Could not reach that address"],
    ["linking_disabled", 409, "Turn on linking first (Machines view)"],
  ])("words %s for the Owner", async (codeName, status, text) => {
    m.pairMachine.mockRejectedValue(new ApiError(status, codeName));
    renderPanel();
    await userEvent.click(tab("Enter a code"));
    await userEvent.type(screen.getByRole("textbox", { name: "Address" }), "192.168.1.20:4418");
    await userEvent.type(screen.getByRole("textbox", { name: "Code" }), CODE);
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    expect((await screen.findByRole("alert")).textContent).toBe(text);
    // The code is kept, so a typo can be fixed.
    expect((screen.getByRole("textbox", { name: "Code" }) as HTMLInputElement).value).toBe(CODE);
  });
});
