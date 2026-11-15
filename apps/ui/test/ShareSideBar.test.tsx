import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../src/api";
import { ShareSideBar } from "../src/views/ShareSideBar";
import { SHARE_ID, link, renderShare, snapshotRecord } from "./share-fixtures";

afterEach(() => vi.restoreAllMocks());

describe("ShareSideBar", () => {
  it("asks for a project when none is selected", () => {
    renderShare(<ShareSideBar />, { selectedId: null });
    expect(screen.getByText("Select or create a project.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview share page" })).toBeNull();
  });

  it("loads the addresses when it opens", () => {
    const { model } = renderShare(<ShareSideBar />);
    expect(model.share.loadAddresses).toHaveBeenCalled();
  });

  it("offers what to include, says what stays out, and previews then focuses the share tab", async () => {
    const order: string[] = [];
    const { model, dock } = renderShare(<ShareSideBar />, {
      share: { onPreview: vi.fn(async () => (order.push("preview"), true)) },
    });
    dock.focus.mockImplementation((id: string) => order.push(`focus:${id}`));
    expect(screen.getByRole("heading", { name: "Share this project" })).toBeTruthy();
    const include = screen.getByRole("group", { name: "Include" });
    expect(within(include).getAllByRole("checkbox").map((b) => (b as HTMLInputElement).labels?.[0]?.textContent)).toEqual([
      "Include my prompts to agents",
      "Include this computer's hardware",
    ]);
    const days = screen.getByRole("combobox", { name: "Digest days" }) as HTMLSelectElement;
    expect([...days.options].map((o) => o.textContent)).toEqual(["Last 7 days", "Last 14 days", "Last 30 days"]);
    expect(
      screen.getByText("Everything else that is private stays out: secrets, file contents, raw agent output, account details."),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Preview share page" }));
    expect(model.share.onPreview).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["preview", "focus:share"]);
  });

  it("does not focus the share tab when the preview was not made, and shows why it failed", async () => {
    const { dock } = renderShare(<ShareSideBar />, {
      share: { onPreview: vi.fn().mockRejectedValue(new ApiError(409, "share_not_clean")) },
    });
    await userEvent.click(screen.getByRole("button", { name: "Preview share page" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The page could not be cleaned of sensitive text and was not generated.");
    expect(dock.focus).not.toHaveBeenCalled();
  });

  it("disables the preview button while a preview is being made", () => {
    renderShare(<ShareSideBar />, { share: { previewing: true } });
    expect((screen.getByRole("button", { name: "Preview share page" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports the options changed by a checkbox and the days select", async () => {
    const { model } = renderShare(<ShareSideBar />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Include my prompts to agents" }));
    expect(model.share.onOptionsChange).toHaveBeenLastCalledWith({ includePrompts: true, includeHardware: false, digestDays: 7 });
    await userEvent.click(screen.getByRole("checkbox", { name: "Include this computer's hardware" }));
    expect(model.share.onOptionsChange).toHaveBeenLastCalledWith({ includePrompts: false, includeHardware: true, digestDays: 7 });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Digest days" }), "30");
    expect(model.share.onOptionsChange).toHaveBeenLastCalledWith({ includePrompts: false, includeHardware: false, digestDays: 30 });
  });

  it("says when there are no snapshots and no live links", () => {
    renderShare(<ShareSideBar />);
    expect(screen.getByText("No snapshots yet. Preview and confirm one.")).toBeTruthy();
    expect(screen.getByText("No live links.")).toBeTruthy();
    expect(screen.getByText("Links work only while The Terminal is running on this computer.")).toBeTruthy();
  });

  it("lists a saved snapshot with Open, Download and Share on your network…", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderShare(<ShareSideBar />, { share: { snapshots: [snapshotRecord()] } });
    const list = screen.getByRole("list", { name: "Saved snapshots" });
    const row = within(list).getByRole("listitem");
    expect(row.textContent).toContain("20.0 KB");
    expect(row.textContent).toContain(`#${SHARE_ID.slice(0, 8)}`);
    const download = within(row).getByRole("link", { name: "Download" });
    expect(download.hasAttribute("download")).toBe(true);
    expect(download.getAttribute("href")).toBe(`/api/share/snapshots/${SHARE_ID}/download`);
    await userEvent.click(within(row).getByRole("button", { name: "Open" }));
    expect(open).toHaveBeenCalledWith(`/api/share/snapshots/${SHARE_ID}`, "_blank", "noopener");
    expect(screen.queryByRole("form", { name: "Share on your network" })).toBeNull();
    const reveal = within(row).getByRole("button", { name: "Share on your network…" });
    expect(reveal.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(reveal);
    expect(reveal.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("form", { name: "Share on your network" })).toBeTruthy();
  });

  it("lists live links with their scope, end and port, and revokes one", async () => {
    const { model } = renderShare(<ShareSideBar />, {
      share: { links: [link(), link({ id: "l0", state: "revoked", endedAt: "2026-11-15T11:00:00.000Z" })] },
    });
    const list = screen.getByRole("list", { name: "Live links" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("This computer only · until ");
    expect(rows[0]!.textContent).toContain(" · port 47400");
    expect(screen.queryByText("No live links.")).toBeNull();
    await userEvent.click(within(rows[0]!).getByRole("button", { name: "Revoke" }));
    expect(model.share.onRevokeLink).toHaveBeenCalledWith("l1");
  });

  it("shows why a revoke failed", async () => {
    renderShare(<ShareSideBar />, {
      share: { links: [link()], onRevokeLink: vi.fn().mockRejectedValue(new ApiError(409, "link_not_active")) },
    });
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That link is no longer live."));
  });

  it("opens the daily digest tab", async () => {
    const { dock } = renderShare(<ShareSideBar />);
    expect(screen.getByRole("heading", { name: "Daily digest" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open daily digest" }));
    expect(dock.focus).toHaveBeenCalledWith("digest");
  });
});
