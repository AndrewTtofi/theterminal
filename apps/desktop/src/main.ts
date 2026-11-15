/**
 * The Electron main process: starts the core server as a child on a real Node, then shows it in a locked-down
 * window (or, with `--headless`, writes a ready file and shows nothing). Nothing from core runs inside Electron.
 *
 * - One app per data folder: the single-instance lock lives in the profile. A second launch on the same folder
 *   exits 0 silently, even when its other flags (`--port`, `--headless`, `--ready-file`) differ; it only brings the
 *   first instance's window forward.
 * - Quitting stops the server over IPC (`server.stop()`). A headless launch is asked to quit with SIGINT or SIGTERM.
 *   On Windows a killed or force-closed host gets no signal: the server then relies on core's own shutdown when its
 *   IPC channel disconnects. Callers that stop a headless app (the smoke suite) must check no `cli.js` is left.
 */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, Menu, session, shell, type MenuItemConstructorOptions } from "electron";
import type { ReadyMessage } from "@theterminal/core/dist/host.js";
import { DesktopArgsError, parseDesktopArgs, type DesktopArgs } from "./args.js";
import { desktopDataDir, devLayout, packagedLayout, profileDir, serverArgs, serverLogFile, type Layout } from "./layout.js";
import { forgetBootstrapUrl, hardenContents, hardenSession, isFatalLoadFailure } from "./harden.js";
import { writeReadyFile } from "./ready-file.js";
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
    // Owner-only: the profile holds the session cookie.
    mkdirSync(profileDir(dataDir), { recursive: true, mode: 0o700 });
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
  let restartOffered = false;

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
    // Before any web contents exists, so none is ever unguarded.
    hardenSession(session.defaultSession);
    app.on("web-contents-created", (_event, contents) =>
      hardenContents(contents, { appPort: () => ready?.port, openExternal: (url) => void shell.openExternal(url) }),
    );
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
    void server.exited
      .then(() => offerRestart("The Terminal's server stopped unexpectedly."))
      .catch((err: unknown) => process.stderr.write(`${(err as Error).message}\n`));

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
    setMenu(ready);
    win = createWindow(ready);
  });

  /** Tells the user something broke and offers Restart or Quit. Headless, it prints the message and exits 1. */
  async function offerRestart(message: string): Promise<void> {
    if (quitting || restartOffered) return;
    restartOffered = true;
    if (args.headless) {
      process.stderr.write(`${message}\n`);
      app.exit(1);
      return;
    }
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
    const options = {
      type: "error" as const,
      title: TITLE,
      message,
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
    // Navigation, new windows and webviews are locked down by hardenContents (web-contents-created).
    forgetBootstrapUrl(w.webContents, r.port);
    w.webContents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
      if (isFatalLoadFailure(errorCode, isMainFrame)) void offerRestart("The Terminal's window could not load.");
    });
    w.webContents.on("render-process-gone", () => void offerRestart("The Terminal's window stopped unexpectedly."));
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
