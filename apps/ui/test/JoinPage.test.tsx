import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ROLE_DESCRIPTIONS } from "@theterminal/shared";

const id = vi.hoisted(() => ({
  passkeysAvailable: vi.fn(),
  joinWithPasskey: vi.fn(),
  joinWithKey: vi.fn(),
}));
vi.mock("../src/identity", () => id);

import { ApiError } from "../src/api";
import { JoinPage } from "../src/pages/JoinPage";

const FP = Array.from({ length: 32 }, (_, i) => (i * 7 + 16).toString(16).toUpperCase().padStart(2, "0").slice(-2)).join(":");
const OTHER = FP.replace(/^../, FP.startsWith("00") ? "01" : "00");
const COMPARE =
  "Compare it with the fingerprint your browser shows for this site's certificate (click the lock icon). Continue only if they are the same.";

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const info = (over: Record<string, unknown> = {}) => ({
  role: "reviewer", expiresAt: "2026-11-22T00:00:00.000Z", passkeys: true, host: "tt-test.local:4318", fingerprint: FP, ...over,
});

function renderPage(hash: string, navigate = vi.fn()) {
  window.location.hash = hash;
  render(<JoinPage code="abc" navigate={navigate} />);
  return { navigate, main: screen.getByRole("main", { name: "Join this workspace" }) };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  id.passkeysAvailable.mockResolvedValue(true);
  id.joinWithPasskey.mockReset();
  id.joinWithKey.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("JoinPage", () => {
  it("shows the role, the link's fingerprint beside the served one and the lock-icon line, and never claims a match", async () => {
    fetchMock.mockResolvedValue(json(info()));
    const { main } = renderPage(`#fp=${FP}`);
    expect(await within(main).findByText("You have been invited as a Reviewer.")).toBeTruthy();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/join/abc");
    expect(within(main).getByText(ROLE_DESCRIPTIONS.reviewer)).toBeTruthy();
    expect(within(main).getByRole("heading", { level: 1, name: "Join this workspace" })).toBeTruthy();
    const link = within(main).getByTestId("link-fingerprint");
    expect(link.textContent).toBe(FP);
    expect(within(main).getByText("Certificate fingerprint in your link:")).toBeTruthy();
    expect(within(main).getByTestId("served-fingerprint").textContent).toBe(FP);
    expect(within(main).getByText(COMPARE)).toBeTruthy();
    expect(within(main).getByRole("button", { name: "Create a passkey and join" })).toBeTruthy();
    expect(screen.queryByText(/they match/i)).toBeNull();
    expect(main.textContent).not.toMatch(/\bmatch(es|ed)?\b(?! the)/i);
    expect(main.textContent).not.toMatch(/they do not match/i);
    expect(main.textContent).not.toMatch(/\b(verified|safe to continue|secure connection)\b/i);
  });

  it("with a fingerprint that differs from the link's, says so in the attention colour and disables the form", async () => {
    fetchMock.mockResolvedValue(json(info({ fingerprint: OTHER })));
    const { main } = renderPage(`#fp=${FP}`);
    const warning = await within(main).findByText("They do not match. Do not continue: someone may be intercepting the connection.");
    expect(warning.className).toContain("attention");
    expect(warning.closest("[role='alert']")).not.toBeNull();
    expect((within(main).getByLabelText("Your name") as HTMLInputElement).disabled).toBe(true);
    expect((within(main).getByRole("button", { name: "Create a passkey and join" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables the form for a link fingerprint that is not one, and shows it inert", async () => {
    fetchMock.mockResolvedValue(json(info()));
    const { main } = renderPage(`#fp=${encodeURIComponent("<b>x</b>\u202e")}`);
    expect(await within(main).findByText(/is not a certificate fingerprint/)).toBeTruthy();
    expect(main.querySelector("b")).toBeNull();
    expect((within(main).getByLabelText("Your name") as HTMLInputElement).disabled).toBe(true);
  });

  it("offers a key in this browser when passkeys cannot work here, with the note", async () => {
    fetchMock.mockResolvedValue(json(info({ passkeys: false, fingerprint: null })));
    const { main, navigate } = renderPage("");
    const button = await within(main).findByRole("button", { name: "Create a key in this browser and join" });
    expect(
      within(main).getByText(
        "This browser cannot use passkeys here (the address is an IP, or passkeys are unsupported). A key will be created and kept in this browser only.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(COMPARE)).toBeNull();
    const name = within(main).getByLabelText("Your name") as HTMLInputElement;
    expect(name.maxLength).toBe(60);
    expect(within(main).getByText("Your name is recorded in this workspace's ledger next to everything you do.")).toBeTruthy();
    id.joinWithKey.mockResolvedValue({});
    await userEvent.type(name, "  Reviewer One ");
    await userEvent.click(button);
    expect(id.joinWithKey).toHaveBeenCalledWith("abc", "Reviewer One");
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
  });

  it("uses a key when the server allows passkeys but this browser has none", async () => {
    id.passkeysAvailable.mockResolvedValue(false);
    fetchMock.mockResolvedValue(json(info()));
    const { main } = renderPage(`#fp=${FP}`);
    expect(await within(main).findByRole("button", { name: "Create a key in this browser and join" })).toBeTruthy();
  });

  it("joins with a passkey and goes to the workspace", async () => {
    fetchMock.mockResolvedValue(json(info()));
    id.joinWithPasskey.mockResolvedValue({});
    const { main, navigate } = renderPage(`#fp=${FP}`);
    await userEvent.type(await within(main).findByLabelText("Your name"), "Reviewer One");
    await userEvent.click(within(main).getByRole("button", { name: "Create a passkey and join" }));
    expect(id.joinWithPasskey).toHaveBeenCalledWith("abc", "Reviewer One");
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
  });

  it("words a refused join and a throttled one", async () => {
    fetchMock.mockResolvedValue(json(info()));
    const { main, navigate } = renderPage(`#fp=${FP}`);
    await userEvent.type(await within(main).findByLabelText("Your name"), "R");
    id.joinWithPasskey.mockRejectedValueOnce(new ApiError(401, "invalid_credential"));
    await userEvent.click(within(main).getByRole("button", { name: "Create a passkey and join" }));
    expect((await within(main).findByRole("alert")).textContent).toBe("That did not work. Try again.");
    id.joinWithPasskey.mockRejectedValueOnce(new ApiError(429, "rate_limited", { retryAfterS: 42 }));
    await userEvent.click(within(main).getByRole("button", { name: "Create a passkey and join" }));
    await waitFor(() => expect(within(main).getByRole("alert").textContent).toBe("Too many attempts. Try again in 42 seconds."));
    // The browser's own refusal (the person closed the passkey prompt) reads the same as a failed check.
    id.joinWithPasskey.mockRejectedValueOnce(new DOMException("cancelled", "NotAllowedError"));
    await userEvent.click(within(main).getByRole("button", { name: "Create a passkey and join" }));
    await waitFor(() => expect(within(main).getByRole("alert").textContent).toBe("That did not work. Try again."));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("says an invitation that is no longer valid, with no form", async () => {
    fetchMock.mockResolvedValue(json({ error: "invite_invalid" }, 404));
    const { main } = renderPage("");
    expect(await within(main).findByText("This invitation is no longer valid. Ask the Owner for a new one.")).toBeTruthy();
    expect(within(main).queryByLabelText("Your name")).toBeNull();
  });
});
