import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BUILTIN_THEMES, resolveColors, type Theme } from "@theterminal/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettings } from "../src/views/AppearanceSettings";
import { THEMES_KEY, currentTheme, loadUserThemes, saveChosenThemeId, saveUserThemes } from "../src/theme/theme-store";

const ice = BUILTIN_THEMES.find((t) => t.id === "ice")!;
const light = BUILTIN_THEMES.find((t) => t.id === "light")!;
const prop = (k: string) => document.documentElement.style.getPropertyValue(`--${k}`);
const gallery = () => screen.getByRole("list", { name: "Themes" });
const card = (name: string) => within(gallery()).getByRole("button", { name });
const themeFile = (body: string, name = "x.theme.json") => new File([body], name, { type: "application/json" });

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  saveChosenThemeId("ice");
  saveUserThemes([]);
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("AppearanceSettings", () => {
  it("shows every built-in theme as a card with swatches, and marks Ice as the default and current one", () => {
    render(<AppearanceSettings />);
    const names = within(gallery()).getAllByRole("listitem").map((li) => li.querySelector(".theme-card-name")?.textContent);
    expect(names).toEqual(BUILTIN_THEMES.map((t) => t.name));
    expect(card("Ice, default").getAttribute("aria-pressed")).toBe("true");
    expect(card("Light").getAttribute("aria-pressed")).toBe("false");
    expect(card("Light").querySelectorAll(".swatch")).toHaveLength(3);
  });

  it("applies a theme as soon as its card is clicked", async () => {
    render(<AppearanceSettings />);
    await userEvent.click(card("Light"));
    expect(prop("bg")).toBe(light.colors.bg);
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(card("Light").getAttribute("aria-pressed")).toBe("true");
    expect(currentTheme().id).toBe("light");
  });

  it("built-in themes offer Duplicate & edit and Export, but no Rename, Edit or Delete", async () => {
    render(<AppearanceSettings />);
    for (const t of BUILTIN_THEMES) {
      await userEvent.click(card(t.id === "ice" ? "Ice, default" : t.name));
      expect(screen.getByRole("button", { name: "Duplicate & edit" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
      expect(screen.queryByLabelText("Theme name")).toBeNull();
    }
  });

  it("Duplicate & edit makes a copy, opens the editor, and an Accent change applies live and is kept", async () => {
    const { unmount } = render(<AppearanceSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Duplicate & edit" }));
    const copy = loadUserThemes()[0]!;
    expect(copy.name).toBe("Ice copy");
    expect(copy.id).not.toBe("ice");
    expect(currentTheme().id).toBe(copy.id);
    const editor = screen.getByRole("region", { name: "Edit Ice copy" });
    for (const label of ["Background", "Panels", "Text", "Accent", "Needs you", "Danger"]) {
      expect(within(editor).getByLabelText(label).getAttribute("type")).toBe("color");
      expect(within(editor).getByLabelText(`${label} hex`)).toBeTruthy();
    }
    const hex = within(editor).getByLabelText("Accent hex");
    await userEvent.clear(hex);
    await userEvent.type(hex, "#ff00aa");
    expect(prop("accent")).toBe("#ff00aa");
    expect((within(editor).getByLabelText("Accent") as HTMLInputElement).value).toBe("#ff00aa");

    unmount();
    expect(loadUserThemes()[0]!.colors.accent).toBe("#ff00aa");
    expect(currentTheme().colors.accent).toBe("#ff00aa");
    render(<AppearanceSettings />);
    expect(card("Ice copy").getAttribute("aria-pressed")).toBe("true");
  });

  it("changes from the colour picker apply live too", async () => {
    render(<AppearanceSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Duplicate & edit" }));
    const picker = screen.getByLabelText("Background") as HTMLInputElement;
    fireEvent.input(picker, { target: { value: "#202020" } });
    expect(prop("bg")).toBe("#202020");
    expect((screen.getByLabelText("Background hex") as HTMLInputElement).value).toBe("#202020");
  });

  it("an invalid hex value is marked and not applied", async () => {
    render(<AppearanceSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Duplicate & edit" }));
    const hex = screen.getByLabelText("Accent hex");
    await userEvent.clear(hex);
    await userEvent.type(hex, "red; x");
    expect(hex.getAttribute("aria-invalid")).toBe("true");
    expect(prop("accent")).toBe(ice.colors.accent);
    expect(loadUserThemes()[0]!.colors.accent).toBe(ice.colors.accent);
  });

  it("Advanced lists every colour key", async () => {
    render(<AppearanceSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Duplicate & edit" }));
    const advanced = screen.getByText("Advanced").closest("details")!;
    expect(advanced.querySelectorAll("input[type='color']")).toHaveLength(Object.keys(resolveColors(ice)).length);
    expect(within(advanced).getByLabelText("--diff-hunk hex")).toBeTruthy();
  });

  it("names a readability problem and its ratio to one decimal place", async () => {
    render(<AppearanceSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Duplicate & edit" }));
    const hex = screen.getByLabelText("Text hex");
    await userEvent.clear(hex);
    await userEvent.type(hex, "#333333");
    const warning = screen.getAllByRole("status").find((s) => s.textContent?.includes("Text on background"));
    expect(warning?.textContent).toMatch(/1\.\d:1/);
    expect(warning?.textContent).toContain("4.5:1");
  });

  it("setting Override equal to the background shows the fallback note and keeps Ice's override", async () => {
    render(<AppearanceSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Duplicate & edit" }));
    const hex = screen.getByLabelText("--override hex");
    await userEvent.clear(hex);
    await userEvent.type(hex, ice.colors.bg!);
    expect(screen.getAllByRole("status").some((s) => s.textContent === "Override colour was too hard to read, so the default is used.")).toBe(true);
    expect(prop("override")).toBe(ice.colors.override);
  });

  it("renames a user theme", async () => {
    render(<AppearanceSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Duplicate & edit" }));
    const name = screen.getByLabelText("Theme name");
    await userEvent.clear(name);
    await userEvent.type(name, "Glacier");
    expect(loadUserThemes()[0]!.name).toBe("Glacier");
    expect(card("Glacier")).toBeTruthy();
  });

  it("deletes a user theme after confirming, and goes back to Ice", async () => {
    saveUserThemes([{ version: 1, id: "mine", name: "Mine", base: "dark", colors: { accent: "#ff00aa" } }]);
    saveChosenThemeId("mine");
    render(<AppearanceSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Mine" }));
    expect(loadUserThemes()).toEqual([]);
    expect(within(gallery()).queryByRole("button", { name: "Mine" })).toBeNull();
    expect(currentTheme().id).toBe("ice");
    expect(prop("accent")).toBe(ice.colors.accent);
  });

  it("refuses an invalid import with the parse error in an alert and adds nothing", async () => {
    render(<AppearanceSettings />);
    await userEvent.upload(screen.getByLabelText("Import theme file"), themeFile('{"version":1,"id":"x","name":"X","base":"dark","colors":{"bg":"red"}}'));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("That theme is not valid. colors.bg: a colour must be #rgb, #rrggbb or #rrggbbaa");
    expect(loadUserThemes()).toEqual([]);
    expect(localStorage.getItem(THEMES_KEY)).toBeNull();
    expect(prop("bg")).not.toBe("red");
  });

  it("refuses a file over 64 KB without reading it", async () => {
    render(<AppearanceSettings />);
    const big = themeFile("x".repeat(65 * 1024));
    const text = vi.spyOn(big, "text");
    await userEvent.upload(screen.getByLabelText("Import theme file"), big);
    expect((await screen.findByRole("alert")).textContent).toMatch(/too large/);
    expect(text).not.toHaveBeenCalled();
    expect(loadUserThemes()).toEqual([]);
  });

  it("imports a valid theme, selects it, and gives a clashing id a suffix", async () => {
    render(<AppearanceSettings />);
    const neon: Theme = { version: 1, id: "ice", name: "Neon", base: "dark", colors: { accent: "#39ff14" } };
    await userEvent.upload(screen.getByLabelText("Import theme file"), themeFile(JSON.stringify(neon)));
    expect(await within(gallery()).findByRole("button", { name: "Neon" })).toBeTruthy();
    const stored = loadUserThemes();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe("ice-2");
    expect(currentTheme().id).toBe("ice-2");
    expect(prop("accent")).toBe("#39ff14");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("exports the current theme as <id>.theme.json through an object URL", async () => {
    const created: Blob[] = [];
    const createObjectURL = vi.fn((b: Blob) => (created.push(b), "blob:theme"));
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this);
    });
    render(<AppearanceSettings />);
    await userEvent.click(card("Light"));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(clicks[0]?.download).toBe("light.theme.json");
    expect(clicks[0]?.href).toBe("blob:theme");
    expect(JSON.parse(await created[0]!.text())).toEqual(light);
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:theme"));
  });

  it("keeps working when storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<AppearanceSettings />);
    await userEvent.click(card("Light"));
    expect(prop("bg")).toBe(light.colors.bg);
  });
});
