import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONNECTION_CATALOG } from "@theterminal/shared";

vi.mock("../src/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/api")>();
  return {
    ...real,
    api: {
      listConnections: vi.fn(),
      getConnectionCatalog: vi.fn(),
      startSignIn: vi.fn(),
      getSignIn: vi.fn(),
      cancelSignIn: vi.fn(),
      getSignInStatus: vi.fn(),
    },
  };
});

import { api, ApiError } from "../src/api";
import { SignInPanel } from "../src/views/SignInPanel";
import { ConnectionEditor } from "../src/views/ConnectionEditor";
import { renderWithConnections } from "./connections-harness";

const m = vi.mocked(api);
const NOTE = (p: string) => `You sign in on ${p}'s own page. The Terminal never sees your password or login tokens.`;

beforeEach(() => {
  vi.clearAllMocks();
  m.listConnections.mockResolvedValue([]);
  m.getConnectionCatalog.mockResolvedValue([...CONNECTION_CATALOG]);
  m.cancelSignIn.mockResolvedValue(undefined);
  m.getSignInStatus.mockResolvedValue({ claude: "signed_out", codex: "signed_out", gemini: "unknown" });
});

describe("SignInPanel", () => {
  it("starts the sign-in, shows the login link and code, a spinner, then Signed in", async () => {
    m.startSignIn.mockResolvedValue({ id: "s1" });
    m.getSignIn
      .mockResolvedValueOnce({ state: "running", lines: ["https://auth.openai.com/codex/device", "ABCD-12345"] })
      .mockResolvedValue({ state: "succeeded", lines: ["https://auth.openai.com/codex/device", "ABCD-12345"] });
    render(<SignInPanel provider="codex" onClose={() => undefined} pollMs={5} />);

    expect(screen.getByText(NOTE("OpenAI"))).toBeTruthy();
    expect(m.startSignIn).toHaveBeenCalledWith("codex");
    const link = (await screen.findByRole("link", { name: "https://auth.openai.com/codex/device" })) as HTMLAnchorElement;
    expect(link.href).toBe("https://auth.openai.com/codex/device");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(link.rel).toContain("noreferrer");
    expect(screen.getByText("ABCD-12345")).toBeTruthy();
    await screen.findByText("Signed in");
    expect(screen.queryByRole("status", { name: "Waiting for you to sign in" })).toBeNull();
  });

  it("shows the spinner while the sign-in runs and Sign-in failed when it fails", async () => {
    m.startSignIn.mockResolvedValue({ id: "s1" });
    let finish = false;
    m.getSignIn.mockImplementation(async () => (finish ? { state: "failed", lines: [] } : { state: "running", lines: [] }));
    render(<SignInPanel provider="claude" onClose={() => undefined} pollMs={5} />);
    expect(await screen.findByRole("status", { name: "Waiting for you to sign in" })).toBeTruthy();
    expect(screen.getByText(NOTE("Anthropic"))).toBeTruthy();
    finish = true;
    await screen.findByText("Sign-in failed");
  });

  it("never renders a line that is not an https link as a link", async () => {
    m.startSignIn.mockResolvedValue({ id: "s1" });
    m.getSignIn.mockResolvedValue({ state: "running", lines: ["javascript:alert(1)"] });
    render(<SignInPanel provider="codex" onClose={() => undefined} pollMs={5} />);
    await screen.findByText("javascript:alert(1)");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("Cancel stops the sign-in and closes the panel; closing while it runs also cancels", async () => {
    m.startSignIn.mockResolvedValue({ id: "s1" });
    m.getSignIn.mockResolvedValue({ state: "running", lines: [] });
    const onClose = vi.fn();
    const { unmount } = render(<SignInPanel provider="codex" onClose={onClose} pollMs={5} />);
    await waitFor(() => expect(m.getSignIn).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(m.cancelSignIn).toHaveBeenCalledWith("s1");
    expect(onClose).toHaveBeenCalled();
    unmount();
  });

  it("says when a sign-in for the provider is already running", async () => {
    m.startSignIn.mockRejectedValue(new ApiError(409, "signin_running"));
    render(<SignInPanel provider="codex" onClose={() => undefined} />);
    expect((await screen.findByRole("alert")).textContent).toBe("A sign-in to Codex is already running.");
  });

  it("Gemini shows the command to run in a terminal and Check again", async () => {
    m.getSignInStatus.mockResolvedValueOnce({ claude: "signed_out", codex: "signed_out", gemini: "not_installed" });
    render(<SignInPanel provider="gemini" onClose={() => undefined} />);
    expect(m.startSignIn).not.toHaveBeenCalled();
    expect(screen.getByText(NOTE("Google"))).toBeTruthy();
    expect(screen.getByText("gemini")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByText("Gemini CLI is not installed");
  });

  it("Check again reports a completed terminal sign-in", async () => {
    m.startSignIn.mockResolvedValue({ id: "s1" });
    m.getSignIn.mockResolvedValue({ state: "running", lines: [] });
    m.getSignInStatus.mockResolvedValue({ claude: "signed_in", codex: "signed_out", gemini: "unknown" });
    render(<SignInPanel provider="claude" onClose={() => undefined} pollMs={5} />);
    expect(screen.getByText("claude auth login")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByText("Signed in");
  });
});

describe("ConnectionEditor sign-in", () => {
  it("a Sign in button under the own-plan option opens the panel", async () => {
    m.startSignIn.mockResolvedValue({ id: "s1" });
    m.getSignIn.mockResolvedValue({ state: "running", lines: [] });
    renderWithConnections(<ConnectionEditor id="connection:new:codex" />);
    await waitFor(() => expect(m.listConnections).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("region", { name: "Sign in to Codex" })).toBeTruthy();
    expect(m.startSignIn).toHaveBeenCalledWith("codex");
  });
});
