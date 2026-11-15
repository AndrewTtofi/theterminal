/**
 * The Electron main process: starts the core server as a child on a real Node, then shows it in a locked-down
 * window (or, with `--headless`, writes a ready file and shows nothing). Nothing from core runs inside Electron.
 */
import { execFile } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, Menu, session, shell, type MenuItemConstructorOptions } from "electron";
import type { ReadyMessage } from "@theterminal/core/dist/host.js";
import { DesktopArgsError, parseDesktopArgs, type DesktopArgs } from "./args.js";
import { desktopDataDir, devLayout, packagedLayout, profileDir, serverArgs, serverLogFile, type Layout } from "./layout.js";
import { externalUrl, isAppUrl } from "./navigation.js";
import { fallbackMacPath, loginShellPath, serverEnv } from "./server-env.js";
import { ServerStartError, startServer, type ServerHandle } from "./server-process.js";

const TITLE = "The Terminal";
const START_FAILED = "The Terminal could not start";

type HostModule = typeof import("@theterminal/core/dist/host.js");

boot();

/** Parses the flags, fixes the profile in the data folder and takes the single-instance lock, then runs. */
function boot(): void {
  let args: DesktopArgs;
  try {
    args = parseDesktopArgs(process.argv.slice(app.isPackaged ? 1 : 2));
  } catch (err) {
    if (!(err instanceof DesktopArgsError)) throw err;
    process.stderr.write(`${err.message}\n`);
    app.exit(2);
    return;
  }

  let dataDir: string;
  try {
    dataDir = desktopDataDir(app.getPath("appData"), args.dataDir);
    mkdirSync(profileDir(dataDir), { recursive: true });
    // Before the lock: the lock lives in the profile, so it is per data folder.
    app.setPath("userData", profileDir(dataDir));
  } catch (err) {
    process.stderr.write(`${START_FAILED}: ${(err as Error).message}\n`);
    app.exit(1);
    return;
  }

  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  run(args, dataDir);
}

function run(args: DesktopArgs, dataDir: string): void {
  const layout: Layout = app.isPackaged ? packagedLayout(process.resourcesPath, process.platform) : devLayout(app.getAppPath());
  let server: ServerHandle | undefined;
  let ready: ReadyMessage | undefined;
  let win: BrowserWindow | null = null;
  let quitting = false;
  let stopping = false;

  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  // Keep running on macOS with no window, as Mac apps do; quit everywhere else.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (!args.headless && ready && !win && !quitting) win = createWindow(ready);
  });

  app.on("before-quit", (event) => {
    quitting = true;
    if (stopping) {
      event.preventDefault();
      return;
    }
    stopping = true;
    event.preventDefault();
    void (server ? server.stop() : Promise.resolve()).finally(() => app.exit(0));
  });

  // A headless launch has no window to close: a signal is how it is asked to quit.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());

  const fail = (detail: string) => {
    if (quitting) return;
    if (args.headless) process.stderr.write(`${START_FAILED}: ${detail}\n`);
    else dialog.showErrorBox(START_FAILED, detail);
    app.exit(1);
  };

  void app.whenReady().then(async () => {
    try {
      const env = await buildServerEnv(layout);
      if (quitting) return;
      server = startServer({
        nodeFile: layout.nodeFile,
        cliFile: layout.cliFile,
        args: serverArgs(layout, dataDir, args.port),
        env,
        logFile: serverLogFile(dataDir),
      });
      ready = await server.ready;
    } catch (err) {
      fail(err instanceof ServerStartError ? err.detail || err.message : (err as Error).message);
      return;
    }
    if (quitting) return;
    void server.exited.then(() => onUnexpectedExit());

    if (args.headless) {
      if (process.platform === "darwin") app.dock?.hide();
      if (args.readyFile) {
        try {
          writeReadyFile(args.readyFile, ready);
        } catch (err) {
          fail((err as Error).message);
          return;
        }
      }
      return;
    }
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    setMenu(ready);
    win = createWindow(ready);
  });

  async function onUnexpectedExit(): Promise<void> {
    if (quitting) return;
    if (args.headless) {
      process.stderr.write("The Terminal's server stopped unexpectedly.\n");
      app.exit(1);
      return;
    }
    const options = {
      type: "error" as const,
      title: TITLE,
      message: "The Terminal's server stopped unexpectedly.",
      buttons: ["Restart", "Quit"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (quitting) return;
    if (response === 0) app.relaunch();
    app.exit(0);
  }

  function createWindow(r: ReadyMessage): BrowserWindow {
    const w = new BrowserWindow({
      show: false,
      width: 1400,
      height: 900,
      title: TITLE,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    const openExternally = (url: string) => {
      const external = externalUrl(url);
      if (external !== null) void shell.openExternal(external);
    };
    w.webContents.setWindowOpenHandler(({ url }) => {
      openExternally(url);
      return { action: "deny" };
    });
    w.webContents.on("will-navigate", (event, url) => {
      if (isAppUrl(url, r.port)) return;
      event.preventDefault();
      openExternally(url);
    });
    w.once("ready-to-show", () => w.show());
    w.on("closed", () => {
      if (win === w) win = null;
    });
    void w.loadURL(r.url);
    return w;
  }
}

/** The allowlisted environment for the server child, with the login-shell PATH on macOS. */
async function buildServerEnv(layout: Layout): Promise<NodeJS.ProcessEnv> {
  // Loaded at run time from core itself: the packaged shell bundles none of core.
  const host = (await import(pathToFileURL(join(layout.coreDir, "dist", "host.js")).href)) as HostModule;
  let loginPath: string | null = null;
  if (process.platform === "darwin") {
    loginPath = (await loginShellPath(process.env.SHELL, probe)) ?? fallbackMacPath(process.env.PATH);
  }
  return serverEnv(process.env, process.platform, host.allowlistedEnv, loginPath);
}

/** Runs the login-shell probe: a fixed argument list, no shell, a timeout, utf8, and no stdin. Resolves with stdout. */
function probe(file: string, probeArgs: string[], opts: { timeout: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      probeArgs,
      { timeout: opts.timeout, encoding: "utf8", windowsHide: true, shell: false },
      (err, stdout) => {
        // The markers decide what counts, so stdout is used even when the shell exits non-zero.
        if (stdout) resolve(stdout);
        else reject(err ?? new Error("no output"));
      },
    );
    // execFile ignores a stdio option: end stdin so an rc file that reads input gets EOF.
    child.stdin?.end();
  });
}

/** Written atomically, so a reader never sees half a file. It never holds the token. */
function writeReadyFile(file: string, r: ReadyMessage): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ loopbackUrl: r.loopbackUrl, port: r.port }), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Electron's default menu, with Open in Browser in the File menu. */
function setMenu(r: ReadyMessage): void {
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" } as const] : []),
    {
      label: "File",
      submenu: [
        { label: "Open in Browser", click: () => void shell.openExternal(r.url) },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
