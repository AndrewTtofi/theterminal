import { describe, expect, it, vi } from "vitest";
import { menuTemplate, type MenuItem } from "../src/menu.js";

/** Every role in the template, submenus included. */
function roles(items: MenuItem[]): string[] {
  return items.flatMap((i) => [...(i.role ? [i.role] : []), ...(Array.isArray(i.submenu) ? roles(i.submenu) : [])]);
}

function labels(items: MenuItem[]): string[] {
  return items.flatMap((i) => [...(i.label ? [i.label] : []), ...(Array.isArray(i.submenu) ? labels(i.submenu) : [])]);
}

describe("menuTemplate", () => {
  it("offers Toggle Developer Tools only in a development launch", () => {
    const dev = menuTemplate({ mac: true, packaged: false, openInBrowser: () => {} });
    const packaged = menuTemplate({ mac: true, packaged: true, openInBrowser: () => {} });
    expect(roles(dev)).toContain("toggleDevTools");
    expect(roles(packaged)).not.toContain("toggleDevTools");
  });

  it("keeps the rest of the View menu when packaged", () => {
    const r = roles(menuTemplate({ mac: false, packaged: true, openInBrowser: () => {} }));
    for (const role of ["reload", "forceReload", "resetZoom", "zoomIn", "zoomOut", "togglefullscreen"]) expect(r).toContain(role);
  });

  it("has an Open in Browser item in the File menu that calls back", () => {
    const open = vi.fn();
    const t = menuTemplate({ mac: false, packaged: true, openInBrowser: open });
    const file = t.find((i) => i.label === "File");
    const item = (file?.submenu as MenuItem[]).find((i) => i.label === "Open in Browser");
    (item?.click as () => void)();
    expect(open).toHaveBeenCalledOnce();
    expect(labels(t)).toContain("Open in Browser");
  });

  it("has the app menu and Close on macOS, Quit elsewhere", () => {
    const mac = roles(menuTemplate({ mac: true, packaged: true, openInBrowser: () => {} }));
    const other = roles(menuTemplate({ mac: false, packaged: true, openInBrowser: () => {} }));
    expect(mac).toContain("appMenu");
    expect(mac).toContain("close");
    expect(other).not.toContain("appMenu");
    expect(other).toContain("quit");
  });
});
