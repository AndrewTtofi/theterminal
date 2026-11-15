import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ShareSnapshot } from "@theterminal/shared";
import { ApiError } from "../src/api";
import { SharePanel } from "../src/views/SharePanel";
import { HASH, preview, renderShare } from "./share-fixtures";

const ACK = "I have read this page and I am happy to share everything on it.";
const NO_PREVIEW = "Choose what to include in the Share view and press Preview share page.";

const region = () => screen.getByRole("region", { name: "Share preview" });
const confirmButton = () => screen.getByRole("button", { name: "Confirm and save snapshot" }) as HTMLButtonElement;

describe("SharePanel", () => {
  it("explains how to get a preview when there is none", () => {
    renderShare(<SharePanel id="share" />);
    expect(within(region()).getByText(NO_PREVIEW)).toBeTruthy();
    expect(screen.queryByTitle("Share page preview")).toBeNull();
  });

  it("shows exactly the page in a sandboxed frame, its size, hash and expiry, and what is not included", () => {
    renderShare(<SharePanel id="share" />, { share: { preview: preview() } });
    expect(within(region()).getByRole("heading", { name: "This is exactly what will be shared" })).toBeTruthy();
    expect(region().textContent).toContain(`20480 bytes · hash ${HASH.slice(0, 12)} · preview expires `);
    const frame = screen.getByTitle("Share page preview") as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("Book Club");
    const aside = screen.getByRole("complementary", { name: "Not included" });
    expect(within(aside).getAllByRole("listitem")).toHaveLength(9);
  });

  it("renders hostile text in the not-included list as text", () => {
    const snapshot = { hidden: ['<img src=x onerror="alert(1)">', "a‮b"] } as unknown as ShareSnapshot;
    renderShare(<SharePanel id="share" />, { share: { preview: preview({ snapshot }) } });
    const aside = screen.getByRole("complementary", { name: "Not included" });
    expect(aside.querySelector("img")).toBeNull();
    expect(aside.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(aside.textContent).not.toContain("‮");
  });

  it("enables Confirm only once the acknowledgement is ticked, confirms, says so and resets the box", async () => {
    const { model } = renderShare(<SharePanel id="share" />, { share: { preview: preview() } });
    expect(confirmButton().disabled).toBe(true);
    const ack = screen.getByRole("checkbox", { name: ACK }) as HTMLInputElement;
    await userEvent.click(ack);
    expect(confirmButton().disabled).toBe(false);
    await userEvent.click(confirmButton());
    expect(model.share.onConfirm).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Saved. Open, download or share it from the Share view.")).toBeTruthy();
    expect(ack.checked).toBe(false);
    expect(confirmButton().disabled).toBe(true);
  });

  it("on a stale preview says so and clears the preview", async () => {
    renderShare(<SharePanel id="share" />, {
      share: { preview: preview(), onConfirm: vi.fn().mockRejectedValue(new ApiError(409, "preview_stale")) },
    });
    await userEvent.click(screen.getByRole("checkbox", { name: ACK }));
    await userEvent.click(confirmButton());
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("The preview has changed or expired. Preview again before confirming."),
    );
    expect(screen.queryByTitle("Share page preview")).toBeNull();
    expect(screen.getByText(NO_PREVIEW)).toBeTruthy();
  });

  it("shows other refusals and keeps the preview", async () => {
    renderShare(<SharePanel id="share" />, {
      share: { preview: preview(), onConfirm: vi.fn().mockRejectedValue(new ApiError(423, "read_only")) },
    });
    await userEvent.click(screen.getByRole("checkbox", { name: ACK }));
    await userEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Workspace is read-only"));
    expect(screen.getByTitle("Share page preview")).toBeTruthy();
  });

  it("resets the acknowledgement when a new preview arrives", async () => {
    const first = renderShare(<SharePanel id="share" />, { share: { preview: preview() } });
    await userEvent.click(screen.getByRole("checkbox", { name: ACK }));
    expect((screen.getByRole("checkbox", { name: ACK }) as HTMLInputElement).checked).toBe(true);
    const next = { ...first.model, share: { ...first.model.share, preview: preview({ previewId: "pv2" }) } };
    const { ShellContext } = await import("../src/shell/model");
    const { shellNav } = await import("./connections-harness");
    first.rerender(
      <ShellContext.Provider value={{ model: next, dock: () => first.dock, ...shellNav() }}>
        <SharePanel id="share" />
      </ShellContext.Provider>,
    );
    expect((screen.getByRole("checkbox", { name: ACK }) as HTMLInputElement).checked).toBe(false);
  });
});
