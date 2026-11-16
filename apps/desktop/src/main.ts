/**
 * The Electron main process: starts the core server as a child on a real Node, then shows it in a locked-down
 * window (or, with `--headless`, writes a ready file and shows nothing). Nothing from core runs inside Electron.
 *
 * - One app per data folder: the single-instance lock lives in the profile. A second launch on the same folder
 *   exits 0 silently, even when its other flags (`--port`, `--headless`, `--ready-file`) differ; it only brings the
 *   first instance's window forward.
 * - Quitting stops the server over IPC (`server.stop()`). A headless launch is asked to quit with SIGINT or SIGTERM.
 *   A killed host gets no chance to do that. On POSIX the server notices its IPC channel closing and shuts down on
 *   its own, releasing its lock. On Windows the server child is in the host's kill-on-close job object (libuv), so
 *   it is killed with the host: its `server.lock` stays behind naming a dead pid, and the next start takes the
 *   folder over.
 */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, Menu, session, shell, WebContentsView, type Session } from "electron";
import type { ReadyMessage } from "@theterminal/core/dist/host.js";
import { DesktopArgsError, parseDesktopArgs, type DesktopArgs } from "./args.js";
import { desktopDataDir, devLayout, packagedLayout, profileDir, restrictedSignInRequested, serverArgs, serverLogFile, type Layout } from "./layout.js";
import { forgetBootstrapUrl, hardenContents, hardenSession, isFatalLoadFailure } from "./harden.js";
import { pickedPath } from "./folder-pick.js";
import { hardenPreviewContents, hardenPreviewSession, policyFor } from "./preview-policy.js";
import { createPreviewViews } from "./preview-views.js";
import { createColorRecorder, loadWindowColor, saveWindowColor } from "./window-color.js";
import { finishRestart } from "./lifecycle.js";
import { menuTemplate } from "./menu.js";
import { writeReadyFile } from "./ready-file.js";
import { fallbackMacPath, loginShellPath, serverEnv } from "./server-env.js";
import { ServerStartError, startServer, type ServerHandle } from "./server-process.js";

const TITLE = "The Terminal";
const START_FAILED = "The Terminal could not start";
/** Added to the app window's user agent, so the UI knows it can ask for live preview views. */
const DESKTOP_UA_MARK = " TheTerminalDesktop";
/** The longest link shown in the "open in your browser" confirmation. */
const CONFIRM_URL_MAX = 2000;

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

  const openExternal = (url: string) => void shell.openExternal(url);
  /** Asks the person before a preview sends them to a link in their own browser. */
  const confirmOpen = async (url: string): Promise<boolean> => {
    const options = {
      type: "question" as const,
      title: TITLE,
      message: "Open this link in your browser?",
      detail: url.length > CONFIRM_URL_MAX ? `${url.slice(0, CONFIRM_URL_MAX)}…` : url,
      buttons: ["Open in my browser", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return response === 0;
  };
  // The sessions of preview partitions, each with the origin its views show. Every other session is the app's.
  const previewOrigins = new WeakMap<Session, string>();
  const previewViews = createPreviewViews<Session>({
    window: () => win,
    makeView: (partition) =>
      // No preload; the session is already marked, so web-contents-created gives these contents the preview policy.
      new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition } }),
    fromPartition: (p) => session.fromPartition(p),
    markPreviewSession: (s, origin) => {
      if (!previewOrigins.has(s)) hardenPreviewSession(s);
      previewOrigins.set(s, origin);
    },
    confirmOpen,
    openExternal,
  });

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
    previewViews.closeAll();
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
    // A preview partition's contents get the preview policy; every other contents the app's, as before.
    app.on("web-contents-created", (_event, contents) => {
      const origin = previewOrigins.get(contents.session);
      if (policyFor(origin !== undefined) === "preview" && origin !== undefined) {
        hardenPreviewContents(contents, { origin, confirmOpen, openExternal });
      } else {
        hardenContents(contents, { appPort: () => ready?.port, openExternal });
      }
    });
    try {
      const env = await buildServerEnv(layout);
      if (quitting) return;
      server = startServer({
        nodeFile: layout.nodeFile,
        cliFile: layout.cliFile,
        args: serverArgs(layout, dataDir, args.port, { restrictedSignIn: restrictedSignInRequested(process.env) }),
        env,
        logFile: serverLogFile(dataDir),
        // The first launch waits for the user to allow keychain access; the server is ready only after that.
        readyTimeoutMs: 120_000,
        // The native folder dialog, asked for by the server child over IPC. The chosen path goes back to the child
        // only; the window has no preload and no renderer IPC. No window (headless, or closed on macOS): null.
        onPickFolder: () => {
          if (!win || win.isDestroyed()) return Promise.resolve(null);
          return dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] }).then(pickedPath);
        },
        // Device views of website previews, laid over the Preview tab, and their screenshots. Asked for by the server
        // child over IPC and checked by startServer; the window still has no preload and no renderer IPC.
        onPreview: async (m) => (m.type === "preview_views" ? previewViews.apply(m) : previewViews.capture(m.previewId)),
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
    // The server is stopped before the relaunch, so the new app finds the data folder free. `app.exit()` skips
    // `before-quit`; `stopping` keeps a quit that arrives meanwhile from stopping the server a second time.
    stopping = true;
    await finishRestart({
      restart: response === 0,
      stopServer: () => server?.stop() ?? Promise.resolve(),
      relaunch: () => app.relaunch(),
      exit: (code) => app.exit(code),
    });
  }

  function createWindow(r: ReadyMessage): BrowserWindow {
    const w = new BrowserWindow({
      show: false,
      width: 1400,
      height: 900,
      title: TITLE,
      backgroundColor: loadWindowColor(windowColorFile()),
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    // Navigation, new windows and webviews are locked down by hardenContents (web-contents-created).
    forgetBootstrapUrl(w.webContents, r.port);
    // The UI uses live preview views only in the desktop app (and when the server says it can show them).
    w.webContents.setUserAgent(`${w.webContents.getUserAgent()}${DESKTOP_UA_MARK}`);
    w.webContents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
      if (isFatalLoadFailure(errorCode, isMainFrame)) void offerRestart("The Terminal's window could not load.");
    });
    w.webContents.on("render-process-gone", () => void offerRestart("The Terminal's window stopped unexpectedly."));
    w.once("ready-to-show", () => w.show());
    // Remember the theme's background so the next window opens in it. The main process reads it itself (no preload
    // or IPC). On close the renderer is usually gone too soon, so it is also saved on blur and every 30 s.
    const initialColor = loadWindowColor(windowColorFile());
    const recorder = createColorRecorder({ read: () => readWindowBg(w), save: (c) => saveWindowColor(windowColorFile(), c), initial: initialColor });
    const timer = setInterval(() => void recorder.record(), 30_000);
    w.on("blur", () => void recorder.record());
    w.on("close", () => void recorder.record());
    w.on("closed", () => {
      clearInterval(timer);
      previewViews.closeAll();
      if (win === w) win = null;
    });
    void w.loadURL(r.url);
    return w;
  }
}

function windowColorFile(): string {
  return join(app.getPath("userData"), "window.json");
}

/** Reads `--bg` from the page, giving up after 500 ms. */
async function readWindowBg(w: BrowserWindow): Promise<unknown> {
  if (w.isDestroyed()) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), 500);
  });
  const read = w.webContents.executeJavaScript('getComputedStyle(document.documentElement).getPropertyValue("--bg")') as Promise<unknown>;
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
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

/** Electron's default menu, with Open in Browser in the File menu and no DevTools item when packaged (see menu.ts). */
function setMenu(r: ReadyMessage): void {
  const template = menuTemplate({
    mac: process.platform === "darwin",
    packaged: app.isPackaged,
    openInBrowser: () => void shell.openExternal(r.url),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
