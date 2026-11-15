import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AuthMode, Provider } from "@theterminal/shared";
import { ProviderAuthSettings } from "../src/components/ProviderAuthSettings";

const ACKS: Record<Provider, string> = {
  claude: "Example claude warning.",
  codex: "Example codex warning.",
  gemini: "Example gemini warning.",
};
const API: Record<Provider, AuthMode> = { claude: "api_key", codex: "api_key", gemini: "api_key" };

const section = (name: string) => within(screen.getByRole("group", { name }));

describe("ProviderAuthSettings", () => {
  it.each([
    ["Claude", "claude", "My own Claude subscription", "subscription"],
    ["Codex", "codex", "My own ChatGPT plan", "chatgpt"],
    ["Gemini", "gemini", "My own Google account", "google"],
  ] as const)("%s: Confirm stays disabled until ticked, then posts the exact ack", async (name, provider, label, mode) => {
    const onChange = vi.fn();
    render(<ProviderAuthSettings modes={API} acks={ACKS} onChange={onChange} />);
    const s = section(`${name} sign-in`);
    expect(screen.queryByText(ACKS[provider])).toBeNull();
    await userEvent.click(s.getByLabelText(label));
    expect(screen.getByText(ACKS[provider])).toBeTruthy();
    const confirm = s.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await userEvent.click(s.getByLabelText("I understand and accept this risk"));
    expect(confirm.disabled).toBe(false);
    await userEvent.click(confirm);
    expect(onChange).toHaveBeenCalledWith(provider, mode, ACKS[provider]);
  });

  it("switches back to API key without a checkbox", async () => {
    const onChange = vi.fn();
    render(<ProviderAuthSettings modes={{ ...API, codex: "chatgpt" }} acks={ACKS} onChange={onChange} />);
    await userEvent.click(section("Codex sign-in").getByLabelText("API key (recommended)"));
    expect(onChange).toHaveBeenCalledWith("codex", "api_key");
    expect(screen.queryByLabelText("I understand and accept this risk")).toBeNull();
  });

  it("returns the radio to the server's mode when the change fails", async () => {
    const onChange = vi.fn().mockResolvedValue(false);
    render(<ProviderAuthSettings modes={{ ...API, gemini: "google" }} acks={ACKS} onChange={onChange} />);
    const s = section("Gemini sign-in");
    await userEvent.click(s.getByLabelText("API key (recommended)"));
    await vi.waitFor(() =>
      expect((s.getByLabelText("My own Google account") as HTMLInputElement).checked).toBe(true),
    );
    expect((s.getByLabelText("API key (recommended)") as HTMLInputElement).checked).toBe(false);
  });

  it("hides the own-plan choice of a provider whose own-plan mode is turned off, with one plain line instead", () => {
    render(<ProviderAuthSettings modes={API} acks={ACKS} ownModeAvailable={{ claude: false, codex: true, gemini: false }} onChange={vi.fn()} />);
    const claude = section("Claude sign-in");
    expect(claude.queryByLabelText("My own Claude subscription")).toBeNull();
    expect(claude.getByText("Signing in with your own Claude plan is turned off until Anthropic allows it. Use an API key.")).toBeTruthy();
    expect((claude.getByLabelText("API key (recommended)") as HTMLInputElement).checked).toBe(true);
    const gemini = section("Gemini sign-in");
    expect(gemini.queryByLabelText("My own Google account")).toBeNull();
    expect(
      gemini.getByText("Signing in with your own Google account is turned off: Google doesn't allow other apps to use Gemini CLI's Google sign-in. Use an API key."),
    ).toBeTruthy();
    // Codex's ChatGPT sign-in is unchanged.
    const codex = section("Codex sign-in");
    expect(codex.getByLabelText("My own ChatGPT plan")).toBeTruthy();
    expect(codex.queryByText(/turned off/)).toBeNull();
  });

  it("shows every own-plan choice when the server allows them", () => {
    render(<ProviderAuthSettings modes={API} acks={ACKS} ownModeAvailable={{ claude: true, codex: true, gemini: true }} onChange={vi.fn()} />);
    expect(section("Claude sign-in").getByLabelText("My own Claude subscription")).toBeTruthy();
    expect(section("Gemini sign-in").getByLabelText("My own Google account")).toBeTruthy();
    expect(screen.queryByText(/turned off/)).toBeNull();
  });
});
