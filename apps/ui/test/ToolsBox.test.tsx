import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import type { NativeTools, Role } from "@theterminal/shared";
import { ToolsBox } from "../src/preview/ToolsBox";
import { RoleContext } from "../src/shell/model";

const tools = (over: Partial<NativeTools> = {}): NativeTools => ({
  platform: "darwin",
  ios: { supported: true, xcode: null, simulators: [], missing: ["xcode"] },
  android: { supported: true, sdk: true, avds: ["Pixel_9"], missing: [] },
  ...over,
});

const renderAs = (role: Role, el: ReactElement) => render(<RoleContext.Provider value={role}>{el}</RoleContext.Provider>);

describe("ToolsBox", () => {
  it("marks a missing tool and explains how to install it", () => {
    renderAs("owner", <ToolsBox kind="ios" tools={tools()} error={null} />);
    expect(screen.getByRole("heading", { name: "What you need on this computer" })).toBeTruthy();
    const rows = screen.getAllByRole("listitem");
    const xcode = rows.find((r) => r.textContent?.includes("Xcode") && !r.textContent.includes("command line"))!;
    expect(within(xcode).getByText("!")).toBeTruthy();
    // The other iOS tools are present.
    expect(rows.filter((r) => r.textContent?.startsWith("✓")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Install Xcode from the App Store.")).toBeNull();
    fireEvent.click(within(xcode).getByRole("button", { name: "How to install" }));
    expect(screen.getByText("Install Xcode from the App Store.")).toBeTruthy();
    expect(screen.getByText("Open it once and accept the licence.")).toBeTruthy();
    const link = within(xcode).getByRole("link");
    expect(link.getAttribute("href")).toBe("https://developer.apple.com/xcode/");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("shows only ✓ when nothing is missing", () => {
    renderAs("owner", <ToolsBox kind="android" tools={tools()} error={null} />);
    expect(screen.queryByText("!")).toBeNull();
    expect(screen.queryByRole("button", { name: "How to install" })).toBeNull();
  });

  it("says iPhone apps need a Mac on another platform", () => {
    renderAs("owner", <ToolsBox kind="ios" tools={tools({ platform: "win32", ios: { supported: false, xcode: null, simulators: [], missing: [] } })} error={null} />);
    expect(screen.getByText("iPhone apps need a Mac.")).toBeTruthy();
  });

  it("tells anyone but the Owner who sets the tools up", () => {
    renderAs("maintainer", <ToolsBox kind="ios" tools={null} error={null} />);
    expect(screen.getByText("The Owner sets up the tools on this computer.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "How to install" })).toBeNull();
  });
});
