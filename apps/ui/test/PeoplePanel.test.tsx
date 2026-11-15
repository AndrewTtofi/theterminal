import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const id = vi.hoisted(() => ({ addPasskey: vi.fn(), addBrowserKey: vi.fn(), passkeysAvailable: vi.fn() }));
vi.mock("../src/identity", () => id);

import { PeoplePanel } from "../src/views/PeoplePanel";
import { FP, REMOTE_ON, jsonResponse, meOf, peopleModel, renderInShell } from "./people-fixtures";

let fetchMock: ReturnType<typeof vi.fn>;
const sent = () => fetchMock.mock.calls.map(([url, init]) => ({
  url: url as string,
  method: (init as RequestInit | undefined)?.method ?? "GET",
  body: (init as RequestInit | undefined)?.body === undefined ? undefined : JSON.parse((init as RequestInit).body as string),
}));

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 200));
  vi.stubGlobal("fetch", fetchMock);
  id.passkeysAvailable.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());

const panel = () => screen.getByRole("region", { name: "People" });

describe("PeoplePanel", () => {
  it("lists everyone in a table with name, role, credentials, last seen and online, names inert", () => {
    renderInShell(<PeoplePanel />, peopleModel());
    const table = within(panel()).getByRole("table", { name: "Everyone" });
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers.slice(0, 5)).toEqual(["Name", "Role", "Credentials", "Last seen", "Online"]);
    expect(table.querySelector("tbody b")).toBeNull();
    expect(within(table).getByText("<b>Viewer</b>\\u200b")).toBeTruthy();
  });

  it("lets the Owner change a role, which sends { role }", async () => {
    const model = peopleModel();
    renderInShell(<PeoplePanel />, model);
    const select = within(panel()).getByRole("combobox", { name: "Role of Reviewer One" });
    expect([...(select as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["Viewer", "Reviewer", "Maintainer"]);
    await userEvent.selectOptions(select, "maintainer");
    await waitFor(() => expect(sent()).toContainEqual({ url: "/api/people/r1", method: "PATCH", body: { role: "maintainer" } }));
    expect(model.refreshPeople).toHaveBeenCalled();
    // Nobody changes the Owner's row or their own.
    expect(within(panel()).queryByRole("combobox", { name: "Role of Owner" })).toBeNull();
  });

  it("removes a person only after Remove <name> confirms it", async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, 204));
    renderInShell(<PeoplePanel />, peopleModel());
    const row = within(panel()).getByText("Reviewer One").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Remove" }));
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(within(row).getByRole("button", { name: "Remove Reviewer One" }));
    await waitFor(() => expect(sent()).toContainEqual({ url: "/api/people/r1", method: "DELETE", body: undefined }));
  });

  it("signs a person out everywhere", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ revoked: 2 }));
    renderInShell(<PeoplePanel />, peopleModel());
    const row = within(panel()).getByText("Reviewer One").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Sign out everywhere" }));
    await waitFor(() => expect(sent()).toContainEqual({ url: "/api/people/r1/sign-out", method: "POST", body: {} }));
  });

  it("shows no management controls to anyone but the Owner, and no invitations or remote form", () => {
    renderInShell(<PeoplePanel />, peopleModel({ me: meOf({ personId: "r1", name: "Reviewer One", role: "reviewer" }), invites: [] }));
    expect(within(panel()).queryByRole("combobox")).toBeNull();
    expect(within(panel()).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(panel()).queryByRole("region", { name: "Invitations" })).toBeNull();
    expect(within(panel()).queryByRole("switch", { name: "Remote access" })).toBeNull();
  });

  it("lists pending invitations for the Owner, with Revoke", async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, 204));
    renderInShell(<PeoplePanel />, peopleModel());
    const invites = within(panel()).getByRole("region", { name: "Invitations" });
    expect(invites.textContent).toContain("Maintainer");
    await userEvent.click(within(invites).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(sent()).toContainEqual({ url: "/api/people/invites/i1", method: "DELETE", body: undefined }));
  });

  it("turns remote access on with the chosen certificate", async () => {
    fetchMock.mockResolvedValue(jsonResponse(REMOTE_ON));
    renderInShell(<PeoplePanel />, peopleModel());
    const sw = within(panel()).getByRole("switch", { name: "Remote access" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(within(panel()).getByText("Allow people on the network to reach this workspace")).toBeTruthy();
    expect(within(panel()).getByRole("radio", { name: "Self-signed certificate" })).toBeTruthy();
    expect(within(panel()).getByRole("radio", { name: "Certificate from Let's Encrypt (needs the domain and port 80)" })).toBeTruthy();
    expect(within(panel()).getByRole("radio", { name: "My own certificate files" })).toBeTruthy();
    await userEvent.click(sw);
    await waitFor(() => expect(sent()).toContainEqual({ url: "/api/remote", method: "PUT", body: { enabled: true, tls: "self_signed" } }));
  });

  it("words owner_credential_required", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "owner_credential_required" }, 409));
    renderInShell(<PeoplePanel />, peopleModel());
    await userEvent.click(within(panel()).getByRole("switch", { name: "Remote access" }));
    expect(
      (await within(panel()).findByText(
        "Add a passkey or key for yourself first, under Your credentials. Your local sign-in never leaves this computer.",
      )).getAttribute("role"),
    ).toBe("alert");
  });

  it("shows the certificate fingerprint read-only with Copy while remote access is on, and the note", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderInShell(<PeoplePanel />, peopleModel({ remote: REMOTE_ON }));
    const fp = within(panel()).getByLabelText("Certificate fingerprint") as HTMLInputElement;
    expect(fp.readOnly).toBe(true);
    expect(fp.value).toBe(FP);
    expect(within(panel()).getByRole("switch", { name: "Remote access" }).getAttribute("aria-checked")).toBe("true");
    expect(within(panel()).getByText("192.168.1.20")).toBeTruthy();
    expect(within(panel()).getByText(/Browsers cannot verify a self-signed certificate/)).toBeTruthy();
    await userEvent.click(within(panel()).getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(FP);
  });

  it("lists your sessions, signs one out by its id, and marks the current one", async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, 204));
    const me = meOf({
      personId: "r1", name: "Reviewer One", role: "reviewer", listener: "remote", method: "passkey",
      sessions: [
        { id: "ab12cd34", listener: "remote", createdAt: "2026-11-14T09:00:00.000Z", lastSeenAt: "2026-11-15T09:00:00.000Z", current: true },
        { id: "ef56ab78", listener: "local", createdAt: "2026-11-13T09:00:00.000Z", lastSeenAt: "2026-11-13T10:00:00.000Z", current: false },
      ],
    });
    const model = peopleModel({ me });
    renderInShell(<PeoplePanel />, model);
    const sessions = within(panel()).getByRole("region", { name: "Your sessions" });
    const rows = within(sessions).getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("this one");
    expect(rows[1]!.textContent).not.toContain("this one");
    expect(rows[1]!.textContent).toContain("This computer");
    await userEvent.click(within(rows[1]!).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(sent()).toContainEqual({ url: "/api/me/sessions/ef56ab78", method: "DELETE", body: undefined }));
    expect(model.refreshPeople).toHaveBeenCalled();
  });

  it("lists your credentials with Remove, and adds a key for this browser", async () => {
    const me = meOf({ credentials: [{ kind: "key", credentialId: "k1", label: "Laptop" }] });
    const model = peopleModel({ me });
    id.addBrowserKey.mockResolvedValue(me);
    fetchMock.mockResolvedValue(jsonResponse(null, 204));
    renderInShell(<PeoplePanel />, model);
    const creds = within(panel()).getByRole("region", { name: "Your credentials" });
    expect(creds.textContent).toContain("Laptop");
    await userEvent.click(within(creds).getByRole("button", { name: "Add a key for this browser" }));
    expect(id.addBrowserKey).toHaveBeenCalled();
    await userEvent.click(within(creds).getByRole("button", { name: "Remove Laptop" }));
    await waitFor(() => expect(sent()).toContainEqual({ url: "/api/me/credentials/k1", method: "DELETE", body: undefined }));
    expect(within(creds).getByRole("button", { name: "Add a passkey" })).toBeTruthy();
  });
});
