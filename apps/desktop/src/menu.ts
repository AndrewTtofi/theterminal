import type { MenuItemConstructorOptions } from "electron";

export type MenuItem = MenuItemConstructorOptions;

/**
 * Electron's default menu with Open in Browser in the File menu. A packaged app has no Toggle Developer Tools item
 * (and its window has `devTools: false`); a development launch keeps it.
 */
export function menuTemplate(o: { mac: boolean; packaged: boolean; openInBrowser: () => void }): MenuItem[] {
  const view: MenuItem[] = [
    { role: "reload" },
    { role: "forceReload" },
    ...(o.packaged ? [] : [{ role: "toggleDevTools" } as const]),
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];
  return [
    ...(o.mac ? [{ role: "appMenu" } as const] : []),
    {
      label: "File",
      submenu: [{ label: "Open in Browser", click: () => o.openInBrowser() }, { type: "separator" }, o.mac ? { role: "close" } : { role: "quit" }],
    },
    { role: "editMenu" },
    { label: "View", submenu: view },
    { role: "windowMenu" },
  ];
}
