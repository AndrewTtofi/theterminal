import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DigestPanel } from "../src/views/DigestPanel";
import { digest, renderShare } from "./share-fixtures";

const region = () => screen.getByRole("region", { name: "Daily digest" });

describe("DigestPanel", () => {
  it("shows each day with its summary, its items and how many more there were", () => {
    renderShare(<DigestPanel id="digest" />);
    const day = within(region()).getByRole("article", { name: "2026-11-15 (UTC)" });
    expect(within(day).getByRole("heading", { level: 3, name: "2026-11-15 (UTC)" })).toBeTruthy();
    expect(within(day).getByText(digest().summary)).toBeTruthy();
    const items = within(day).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("09:30");
    expect(items[0]!.textContent).toContain('Owner created card "Login"');
    expect(items[1]!.className).toContain("attention");
    expect(items[2]!.className).toContain("override");
    expect(within(day).getByText("and 3 more")).toBeTruthy();
  });

  it("labels an override in words as well as colour", () => {
    renderShare(<DigestPanel id="digest" />, {
      digests: { list: [digest({ items: [{ seq: 9, time: "11:00", headline: "Owner discarded the changes", topic: "override", attention: false }] })] },
    });
    const item = within(region()).getByRole("listitem");
    expect(item.className).toBe("override");
    expect(item.textContent).toContain("OVERRIDE Owner discarded the changes");
  });

  it("leaves out the more line when nothing was cut", () => {
    renderShare(<DigestPanel id="digest" />, { digests: { list: [digest({ more: 0 })] } });
    expect(screen.queryByText(/and \d+ more/)).toBeNull();
  });

  it("changes the window", async () => {
    const { model } = renderShare(<DigestPanel id="digest" />);
    const days = within(region()).getByRole("combobox", { name: "Days" }) as HTMLSelectElement;
    expect([...days.options].map((o) => o.value)).toEqual(["7", "14", "30"]);
    await userEvent.selectOptions(days, "30");
    expect(model.digests.onDaysChange).toHaveBeenCalledWith(30);
  });

  it("says when the window is empty, and while it loads", () => {
    const { unmount } = renderShare(<DigestPanel id="digest" />, { digests: { list: [] } });
    expect(screen.getByText("No entries in this window.")).toBeTruthy();
    unmount();
    renderShare(<DigestPanel id="digest" />, { digests: { list: null } });
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("asks for a project when none is selected", () => {
    renderShare(<DigestPanel id="digest" />, { selectedId: null });
    expect(screen.getByText("Select or create a project.")).toBeTruthy();
  });

  it("renders a hostile day and time as text too", () => {
    renderShare(<DigestPanel id="digest" />, {
      digests: { list: [digest({ day: "2026-11-15\u202e", items: [{ seq: 1, time: "10:00\u202e", headline: "x", topic: "agent", attention: false }] })] },
    });
    expect(region().textContent).toContain("2026-11-15\\u202e (UTC)");
    expect(region().textContent).toContain("10:00\\u202e");
    expect(region().textContent).not.toContain("\u202e");
  });

  it("tells the model it is open for as long as it is mounted, so digests load and reload only then", () => {
    const stop = vi.fn();
    const watch = vi.fn(() => stop);
    const { unmount } = renderShare(<DigestPanel id="digest" />, { digests: { watch } });
    expect(watch).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("renders hostile headlines and summaries as text", () => {
    const hostile = '<img src=x onerror="alert(1)">\u202e';
    renderShare(<DigestPanel id="digest" />, {
      digests: { list: [digest({ summary: hostile, items: [{ seq: 1, time: "10:00", headline: hostile, topic: "agent", attention: false }] })] },
    });
    expect(region().querySelector("img")).toBeNull();
    expect(region().textContent).toContain('<img src=x onerror="alert(1)">\\u202e');
    expect(region().textContent).not.toContain("\u202e");
  });
});
