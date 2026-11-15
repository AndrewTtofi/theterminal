import { join } from "node:path";

/** Where the server's Node, the core CLI, core itself and the built UI are. */
export type Layout = { nodeFile: string; cliFile: string; coreDir: string; uiDir: string };

/** A packaged app: Node, core and the UI live under `Resources/`, outside asar. */
export function packagedLayout(resourcesPath: string, platform: NodeJS.Platform): Layout {
  const coreDir = join(resourcesPath, "core");
  return {
    nodeFile: join(resourcesPath, "node", platform === "win32" ? "node.exe" : "node"),
    cliFile: join(coreDir, "dist", "cli.js"),
    coreDir,
    uiDir: join(resourcesPath, "ui"),
  };
}

/** A development launch from `apps/desktop`: the built core and UI in the repository, and `node` from PATH. */
export function devLayout(appPath: string): Layout {
  const root = join(appPath, "..", "..");
  const coreDir = join(root, "packages", "core");
  return {
    nodeFile: "node",
    cliFile: join(coreDir, "dist", "cli.js"),
    coreDir,
    uiDir: join(root, "apps", "ui", "dist"),
  };
}

/** The data folder shared with the CLI: `<appData>/TheTerminal`, the same as core's default, or the override. */
export function desktopDataDir(appData: string, override?: string): string {
  return override ?? join(appData, "TheTerminal");
}

/** The Chromium profile. The single-instance lock lives here, so it is per data folder. */
export function profileDir(dataDir: string): string {
  return join(dataDir, "desktop");
}

/** The server child's stdout and stderr, truncated at every start. */
export function serverLogFile(dataDir: string): string {
  return join(profileDir(dataDir), "server.log");
}

/** The core CLI arguments for the server child. Without a port, core picks its default. */
export function serverArgs(layout: Layout, dataDir: string, port?: number, opts: { restrictedSignIn?: boolean } = {}): string[] {
  const args = ["start", "--data-dir", dataDir, "--ui-dir", layout.uiDir, "--core-dir", layout.coreDir];
  if (port !== undefined) args.push("--port", String(port));
  // The server child's environment is allowlisted, so the switch goes to it as a flag.
  if (opts.restrictedSignIn === true) args.push("--allow-restricted-signin");
  return args;
}

/**
 * The restricted sign-in switch, as the app was started: THETERMINAL_RESTRICTED_SIGNIN=1 exactly (the same variable
 * the headless server reads). Read once, at start.
 */
export function restrictedSignInRequested(env: NodeJS.ProcessEnv): boolean {
  return env.THETERMINAL_RESTRICTED_SIGNIN === "1";
}
