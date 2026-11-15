import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PeopleSideBar } from "../src/views/PeopleSideBar";
import { meOf, peopleModel, renderInShell, statusWith } from "./people-fixtures";

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("PeopleSideBar", () => {
  it("lists who is here with their role, view and project, names inert", () => {
    renderInShell(<PeopleSideBar />, peopleModel());
    const here = screen.getByRole("region", { name: "People here" });
    const rows = within(here).getAllByRole("listitem").map((li) => li.textContent);
    expect(rows).toEqual(["Reviewer One · Reviewer · Board in Local Model Hub", "<b>Viewer</b>\\u200b · Viewer · not in a project"]);
    expect(here.querySelector("b")).toBeNull();
    expect(within(here).getByRole("heading", { name: "People here" })).toBeTruthy();
  });

  it("lists everyone with role and an online mark, and gives the Owner Invite someone", async () => {
    renderInShell(<PeopleSideBar />, peopleModel());
    const all = screen.getByRole("region", { name: "Everyone" });
    const rows = within(all).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector(".person-name")?.textContent)).toEqual(["Owner", "Reviewer One", "<b>Viewer</b>\\u200b"]);
    expect(within(rows[1]!).getByRole("img", { name: "Online" })).toBeTruthy();
    expect(within(rows[0]!).getByRole("img", { name: "Offline" })).toBeTruthy();
    await userEvent.click(within(all).getByRole("button", { name: "Invite someone" }));
    expect(screen.getByRole("dialog", { name: "Invite someone" })).toBeTruthy();
  });

  it("gives nobody else Invite someone", () => {
    renderInShell(<PeopleSideBar />, peopleModel({ me: meOf({ personId: "r1", name: "Reviewer One", role: "reviewer" }) }));
    expect(screen.queryByRole("button", { name: "Invite someone" })).toBeNull();
  });

  it("sums up remote access and opens the People panel", async () => {
    const { dock } = renderInShell(<PeopleSideBar />, peopleModel({ status: statusWith({ enabled: true, listening: true, label: "tt-test.local:4318" }) }));
    const remote = screen.getByRole("region", { name: "Remote access" });
    expect(within(remote).getByText("On · tt-test.local:4318")).toBeTruthy();
    await userEvent.click(within(remote).getByRole("button", { name: "Open People" }));
    expect(dock.focus).toHaveBeenCalledWith("people");
  });

  it("says Off, and On without an address for a collaborator", () => {
    const { unmount } = renderInShell(<PeopleSideBar />, peopleModel());
    expect(within(screen.getByRole("region", { name: "Remote access" })).getByText("Off")).toBeTruthy();
    unmount();
    renderInShell(
      <PeopleSideBar />,
      peopleModel({ me: meOf({ personId: "r1", role: "reviewer" }), status: statusWith({ enabled: true, listening: true }) }),
    );
    expect(within(screen.getByRole("region", { name: "Remote access" })).getByText("On")).toBeTruthy();
  });
});
