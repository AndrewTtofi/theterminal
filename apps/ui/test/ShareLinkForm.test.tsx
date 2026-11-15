import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../src/api";
import { ShareLinkForm } from "../src/components/ShareLinkForm";
import { ADDRESSES, SHARE_ID } from "./share-fixtures";

const URL = "http://127.0.0.1:47400/tok-TESTKEY";

function renderForm(onCreateLink = vi.fn().mockResolvedValue({ url: URL }), addresses = ADDRESSES, addressesError: string | null = null) {
  render(<ShareLinkForm shareId={SHARE_ID} addresses={addresses} addressesError={addressesError} onCreateLink={onCreateLink} />);
  return { onCreateLink };
}

afterEach(() => vi.restoreAllMocks());

describe("ShareLinkForm", () => {
  it("offers the addresses by label and the durations, 24 hours by default, and says what a link allows", () => {
    renderForm();
    expect(screen.getByRole("form", { name: "Share on your network" })).toBeTruthy();
    const address = screen.getByRole("combobox", { name: "Address" }) as HTMLSelectElement;
    expect([...address.options].map((o) => o.textContent)).toEqual(["This computer only", "Local network (192.168.1.20)"]);
    const ttl = screen.getByRole("combobox", { name: "Valid for" }) as HTMLSelectElement;
    expect([...ttl.options].map((o) => o.textContent)).toEqual(["1 hour", "8 hours", "24 hours", "7 days"]);
    expect(ttl.selectedOptions[0]!.textContent).toBe("24 hours");
    expect(
      screen.getByText(
        "Anyone with the link can read this snapshot, and nothing else, until it expires or you revoke it. It works only while The Terminal is running.",
      ),
    ).toBeTruthy();
  });

  it("creates a link and shows it once, read-only, with Copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { onCreateLink } = renderForm();
    await userEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(onCreateLink).toHaveBeenCalledWith(SHARE_ID, "127.0.0.1", 1440);
    const input = (await screen.findByRole("textbox", { name: "Share link" })) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe(URL);
    expect(screen.getAllByDisplayValue(URL)).toHaveLength(1);
    expect(document.body.textContent).not.toContain(URL);
    expect(screen.getByText("This link is shown once. Copy it now.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(URL);
    // One link per project, shown once: a second Create would only be refused, or replace the url on screen.
    expect((screen.getByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onCreateLink).toHaveBeenCalledTimes(1);
  });

  it("passes the chosen address and duration", async () => {
    const { onCreateLink } = renderForm();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Address" }), "192.168.1.20");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Valid for" }), "60");
    await userEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(onCreateLink).toHaveBeenCalledWith(SHARE_ID, "192.168.1.20", 60);
  });

  it("does not break when the clipboard is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    renderForm();
    await userEvent.click(screen.getByRole("button", { name: "Create link" }));
    await userEvent.click(await screen.findByRole("button", { name: "Copy" }));
    expect(screen.getByRole("textbox", { name: "Share link" })).toBeTruthy();
  });

  it("shows a refusal worded for the Owner", async () => {
    renderForm(vi.fn().mockRejectedValue(new ApiError(409, "share_link_active")));
    await userEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("A link is already live for this project. Revoke it first."));
    expect(screen.queryByRole("textbox", { name: "Share link" })).toBeNull();
  });

  it("cannot create a link with no address offered", () => {
    renderForm(undefined, []);
    expect((screen.getByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says why there is no address when the addresses could not be loaded", () => {
    renderForm(undefined, [], "request_failed");
    expect((screen.getByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe(
      "The addresses this computer can share on could not be loaded. Close and open the Share view to try again.",
    );
  });

  it("does not repeat a load failure once addresses are known", () => {
    renderForm(undefined, ADDRESSES, "request_failed");
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
