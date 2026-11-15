import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ROLE_DESCRIPTIONS } from "@theterminal/shared";
import { InviteDialog } from "../src/components/InviteDialog";
import { FP, INVITES, jsonResponse } from "./people-fixtures";

const LINE =
  "This link works once and expires in 7 days. Send it over a channel you trust, and tell the person the certificate fingerprint some other way too.";
const OFF = "Remote access is off: this link only works on this computer. Turn it on under Remote access to invite someone else.";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("InviteDialog", () => {
  it("offers the three roles with their descriptions, and shows the link once with its fingerprint", async () => {
    const url = `https://tt-test.local:4318/join/CODE#fp=${FP}`;
    fetchMock.mockResolvedValue(jsonResponse({ invite: INVITES[0], url, fingerprint: FP }, 201));
    const onCreated = vi.fn();
    render(<InviteDialog remoteOn onClose={vi.fn()} onCreated={onCreated} />);
    const dialog = screen.getByRole("dialog", { name: "Invite someone" });
    const radios = within(dialog).getAllByRole("radio").map((r) => r.getAttribute("value"));
    expect(radios).toEqual(["viewer", "reviewer", "maintainer"]);
    for (const r of ["viewer", "reviewer", "maintainer"] as const) expect(within(dialog).getByText(ROLE_DESCRIPTIONS[r])).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("radio", { name: /^Maintainer/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create invitation" }));
    const link = (await within(dialog).findByLabelText("Invitation link")) as HTMLInputElement;
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({ role: "maintainer" });
    expect(link.readOnly).toBe(true);
    expect(link.value).toBe(url);
    expect(within(dialog).getByText(LINE)).toBeTruthy();
    expect(within(dialog).getByText(FP)).toBeTruthy();
    expect(within(dialog).queryByText(OFF)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Copy link" })).toBeTruthy();
    // Shown once: no second invitation from the same dialog.
    expect(within(dialog).queryByRole("button", { name: "Create invitation" })).toBeNull();
    expect(onCreated).toHaveBeenCalled();
  });

  it("says the link works only here while remote access is off", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ invite: INVITES[0], url: "http://theterminal.localhost:4317/join/CODE", fingerprint: null }, 201));
    render(<InviteDialog remoteOn={false} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(await screen.findByText(OFF)).toBeTruthy();
  });

  it("closes on Escape and on Close", async () => {
    const onClose = vi.fn();
    render(<InviteDialog remoteOn={false} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });
});
