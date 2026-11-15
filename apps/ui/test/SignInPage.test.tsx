import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const id = vi.hoisted(() => ({
  passkeysAvailable: vi.fn(),
  hasBrowserKey: vi.fn(),
  signInWithPasskey: vi.fn(),
  signInWithKey: vi.fn(),
}));
vi.mock("../src/identity", () => id);

import { ApiError } from "../src/api";
import { SignInPage } from "../src/pages/SignInPage";

const LINE = "The Owner signs in on this computer without a password; everyone else uses the passkey or key they created when they joined.";

beforeEach(() => {
  for (const f of Object.values(id)) f.mockReset();
  id.passkeysAvailable.mockResolvedValue(true);
});

describe("SignInPage", () => {
  it("offers the browser's key only when one is in IndexedDB", async () => {
    id.hasBrowserKey.mockResolvedValue(false);
    const { unmount } = render(<SignInPage navigate={vi.fn()} />);
    const main = screen.getByRole("main", { name: "Sign in" });
    expect(within(main).getByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(await within(main).findByRole("button", { name: "Sign in with a passkey" })).toBeTruthy();
    expect(within(main).getByText(LINE)).toBeTruthy();
    await waitFor(() => expect(id.hasBrowserKey).toHaveBeenCalled());
    expect(within(main).queryByRole("button", { name: "Sign in with this browser's key" })).toBeNull();
    unmount();

    id.hasBrowserKey.mockResolvedValue(true);
    render(<SignInPage navigate={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Sign in with this browser's key" })).toBeTruthy();
  });

  it("signs in with the key and goes to the workspace", async () => {
    id.hasBrowserKey.mockResolvedValue(true);
    id.signInWithKey.mockResolvedValue({});
    const navigate = vi.fn();
    render(<SignInPage navigate={navigate} />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign in with this browser's key" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
  });

  it("words a lockout in minutes and a failed passkey", async () => {
    id.hasBrowserKey.mockResolvedValue(false);
    const navigate = vi.fn();
    render(<SignInPage navigate={navigate} />);
    id.signInWithPasskey.mockRejectedValueOnce(new ApiError(423, "locked", { retryAfterS: 840 }));
    await userEvent.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Too many failed attempts. Try again in 14 minutes.");
    id.signInWithPasskey.mockRejectedValueOnce(new ApiError(401, "invalid_credential"));
    await userEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That did not work. Try again."));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("disables the passkey button where passkeys cannot work, and says why", async () => {
    id.passkeysAvailable.mockResolvedValue(false);
    id.hasBrowserKey.mockResolvedValue(true);
    render(<SignInPage navigate={vi.fn()} />);
    await screen.findByRole("button", { name: "Sign in with this browser's key" });
    expect((screen.getByRole("button", { name: "Sign in with a passkey" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/cannot use passkeys here/)).toBeTruthy();
  });
});
