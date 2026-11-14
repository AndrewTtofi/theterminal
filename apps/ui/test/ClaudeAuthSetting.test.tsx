import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClaudeAuthSetting } from "../src/components/ClaudeAuthSetting";

const ACK = "Example warning text from the server.";

describe("ClaudeAuthSetting", () => {
  it("keeps Confirm disabled until the box is ticked, then posts the exact ack", async () => {
    const onChange = vi.fn();
    render(<ClaudeAuthSetting mode="api_key" subscriptionAck={ACK} onChange={onChange} />);
    expect(screen.queryByText(ACK)).toBeNull();
    await userEvent.click(screen.getByLabelText("My own Claude subscription"));
    expect(screen.getByText(ACK)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await userEvent.click(screen.getByLabelText("I understand and accept this risk"));
    expect(confirm.disabled).toBe(false);
    await userEvent.click(confirm);
    expect(onChange).toHaveBeenCalledWith("subscription", ACK);
  });

  it("switches back to API key without a checkbox", async () => {
    const onChange = vi.fn();
    render(<ClaudeAuthSetting mode="subscription" subscriptionAck={ACK} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText("API key (recommended)"));
    expect(onChange).toHaveBeenCalledWith("api_key");
  });
});
