import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_HOME, HOME_KEY } from "../src/home/home-store";
import { HomeView } from "../src/views/HomeView";
import { homeModel, renderInShell } from "./home-fixtures";

beforeEach(() => localStorage.clear());

/** The blocks Home shows, in order, by their data-block id. */
const shownBlocks = () => [...document.querySelectorAll<HTMLElement>("[data-block]")].map((el) => el.dataset.block);
const row = (name: string) => screen.getByRole("listitem", { name });

describe("HomeEditor", () => {
  it("toggles in place from Edit Home", async () => {
    renderInShell(<HomeView />, homeModel());
    const edit = screen.getByRole("button", { name: "Edit Home" });
    expect(edit.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(edit);
    expect(edit.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("list", { name: "Home blocks" })).toBeTruthy();
  });

  it("hides an unchecked block on Done and saves it", async () => {
    renderInShell(<HomeView />, homeModel());
    await userEvent.click(screen.getByRole("button", { name: "Edit Home" }));
    await userEvent.click(within(row("Project files")).getByRole("checkbox", { name: "Project files" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("region", { name: "Project files" })).toBeNull();
    expect(JSON.parse(localStorage.getItem(HOME_KEY) ?? "{}").hidden).toEqual(["files"]);
    expect(screen.queryByRole("list", { name: "Home blocks" })).toBeNull();
  });

  it("never lets the approvals block be turned off", async () => {
    renderInShell(<HomeView />, homeModel());
    await userEvent.click(screen.getByRole("button", { name: "Edit Home" }));
    const box = within(row("Needs your approval")).getByRole("checkbox", { name: "Needs your approval" }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(true);
    expect(box.title).toBe("Always shown");
  });

  it("moves blocks with the keyboard buttons", async () => {
    renderInShell(<HomeView />, homeModel());
    await userEvent.click(screen.getByRole("button", { name: "Edit Home" }));
    const up = within(row("Ask box")).getByRole("button", { name: "Move up" }) as HTMLButtonElement;
    expect(up.disabled).toBe(true);
    await userEvent.click(within(row("Ask box")).getByRole("button", { name: "Move down" }));
    expect(shownBlocks()[0]).toBe("approvals");
    expect(within(screen.getByRole("list", { name: "Home blocks" })).getAllByRole("listitem")[0]?.textContent).toContain("Needs your approval");
    // Focus stays with the block moved, so it can keep going.
    expect(document.activeElement).toBe(within(row("Ask box")).getByRole("button", { name: "Move down" }));
  });

  it("reorders by dragging a block onto another", async () => {
    renderInShell(<HomeView />, homeModel());
    await userEvent.click(screen.getByRole("button", { name: "Edit Home" }));
    const data = { setData: () => {}, getData: () => "", effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(row("Project files"), { dataTransfer: data });
    fireEvent.dragOver(row("Ask box"), { dataTransfer: data });
    fireEvent.drop(row("Ask box"), { dataTransfer: data });
    expect(shownBlocks()[0]).toBe("files");
  });

  it("chooses one column for Working now", async () => {
    renderInShell(<HomeView />, homeModel());
    await userEvent.click(screen.getByRole("button", { name: "Edit Home" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Working now columns" })).getByRole("radio", { name: "1" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(JSON.parse(localStorage.getItem(HOME_KEY) ?? "{}").workingColumns).toBe(1);
    const working = document.querySelector<HTMLElement>("[data-block='working'] .home-cards");
    expect(working?.style.getPropertyValue("--home-columns")).toBe("1");
  });

  it("Reset restores the default order", async () => {
    renderInShell(<HomeView />, homeModel());
    await userEvent.click(screen.getByRole("button", { name: "Edit Home" }));
    await userEvent.click(within(row("Ask box")).getByRole("button", { name: "Move down" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(shownBlocks()[0]).toBe("approvals");
    await userEvent.click(screen.getByRole("button", { name: "Edit Home" }));
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(shownBlocks()).toEqual(DEFAULT_HOME.order);
    expect(localStorage.getItem(HOME_KEY)).toBeNull();
  });
});
