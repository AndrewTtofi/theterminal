import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WritebackPreview } from "@theterminal/shared";
import { ApiError, api } from "../src/api";
import { WritebackDialog } from "../src/components/WritebackDialog";

afterEach(() => vi.restoreAllMocks());

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const preview = (kind: "folder" | "github", head = H1): WritebackPreview => ({
  kind,
  head,
  files: [
    { path: "src/app.txt", change: "modify" },
    { path: "notes.md", change: "add" },
    { path: "old.txt", change: "delete" },
  ],
});

function setup(kind: "folder" | "github") {
  const onClose = vi.fn();
  render(<WritebackDialog projectId="p1" kind={kind} onClose={onClose} />);
  return { dialog: screen.getByRole("dialog"), onClose };
}

describe("WritebackDialog", () => {
  it("lists the files and asks before writing them to the folder, sending the preview's head", async () => {
    vi.spyOn(api, "writebackPreview").mockResolvedValue(preview("folder"));
    const apply = vi.spyOn(api, "applyToFolder").mockResolvedValue({ written: 2, deleted: 0, skipped: [{ path: "old.txt", reason: "changed" }] });
    const { dialog } = setup("folder");
    expect(await within(dialog).findByText("Write these 3 files to your folder?")).toBeTruthy();
    const list = within(dialog).getByRole("list", { name: "Files to write" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["changedsrc/app.txt", "addednotes.md", "deletedold.txt"]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Apply to my folder" }));
    expect(apply).toHaveBeenCalledWith("p1", H1);
    expect(await within(dialog).findByText("Skipped because they changed in your folder: old.txt")).toBeTruthy();
  });

  it("on preview_stale says so and loads the list again", async () => {
    const load = vi.spyOn(api, "writebackPreview").mockResolvedValueOnce(preview("folder")).mockResolvedValueOnce(preview("folder", H2));
    const apply = vi.spyOn(api, "applyToFolder").mockRejectedValueOnce(new ApiError(409, "preview_stale")).mockResolvedValueOnce({ written: 3, deleted: 0, skipped: [] });
    const { dialog } = setup("folder");
    await within(dialog).findByText("Write these 3 files to your folder?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Apply to my folder" }));
    expect(await within(dialog).findByText("The files changed since you looked. Review the list again.")).toBeTruthy();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await userEvent.click(within(dialog).getByRole("button", { name: "Apply to my folder" }));
    expect(apply).toHaveBeenLastCalledWith("p1", H2);
  });

  it("opens a pull request and links to it", async () => {
    vi.spyOn(api, "writebackPreview").mockResolvedValue(preview("github"));
    const publish = vi.spyOn(api, "publishToGitHub").mockResolvedValue({ branch: "the-terminal/0a1b2c3d", pullUrl: "https://github.com/you/site/pull/7", skipped: [] });
    const { dialog } = setup("github");
    expect(await within(dialog).findByText("Open a pull request with these 3 files?")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish to GitHub" }));
    expect(publish).toHaveBeenCalledWith("p1", H1);
    const link = await within(dialog).findByRole("link", { name: /pull request/ });
    expect(link.getAttribute("href")).toBe("https://github.com/you/site/pull/7");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("says when there is nothing to send back", async () => {
    vi.spyOn(api, "writebackPreview").mockResolvedValue({ kind: "folder", head: H1, files: [] });
    const { dialog } = setup("folder");
    expect(await within(dialog).findByText("Nothing to write back yet. Accept an agent's changes first.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Apply to my folder" })).toBeNull();
  });

  it("closes on Escape and from Cancel", async () => {
    vi.spyOn(api, "writebackPreview").mockResolvedValue(preview("folder"));
    const { dialog, onClose } = setup("folder");
    await within(dialog).findByText("Write these 3 files to your folder?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
