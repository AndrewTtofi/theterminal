// Packaging for The Terminal. Every switch Plan 9B (signing and notarization) changes lives in this file.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLayout, buildMachinePaths } from "./scripts/stage-lib.mjs";
import { BUNDLE_CLAUDE } from "./bundle-claude.mjs";

export { BUNDLE_CLAUDE };

const require = createRequire(import.meta.url);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const electronVersion = JSON.parse(readFileSync(require.resolve("electron/package.json"), "utf8")).version;

/** electron-builder's signing inputs: any of them set means a build would try to sign. */
const SIGNING_ENV = ["CSC_LINK", "CSC_NAME", "WIN_CSC_LINK", "CSC_KEY_PASSWORD", "WIN_CSC_KEY_PASSWORD"];

/** A release version: `MAJOR.MINOR.PATCH` with an optional pre-release suffix. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Fails the build when the packed app's Resources do not hold exactly what staging checked.
 * @param {import("electron-builder").AfterPackContext} context
 */
async function afterPack(context) {
  const { Arch } = await import("electron-builder");
  const platform = context.electronPlatformName;
  const resources =
    platform === "darwin"
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : join(context.appOutDir, "resources");
  const problems = assertLayout(resources, /** @type {NodeJS.Platform} */ (platform), Arch[context.arch], {
    bundleClaude: BUNDLE_CLAUDE,
    buildPaths: buildMachinePaths(REPO_ROOT),
  });
  if (problems.length > 0) throw new Error(`Packaged layout is incomplete: ${problems.join(", ")}`);
}

/**
 * The electron-builder configuration for an environment.
 * @param {NodeJS.ProcessEnv} env
 * @returns {import("electron-builder").Configuration}
 */
export function builderConfig(env) {
  if (env.THETERMINAL_SIGN === "1" || SIGNING_ENV.some((name) => env[name])) {
    // Plan 9B: hardened runtime, entitlements for V8 JIT, notarization and signtool are configured here.
    throw new Error("Signing is configured in Plan 9B");
  }
  const version = env.THETERMINAL_VERSION;
  if (version !== undefined && !VERSION.test(version)) throw new Error(`Invalid THETERMINAL_VERSION: ${version}`);

  return {
    productName: "The Terminal",
    appId: "org.theterminal.desktop",
    electronVersion,
    ...(version !== undefined && { extraMetadata: { version } }),
    directories: { output: "release" },
    // The shell only: core, Node and the UI run outside Electron, from Resources (never inside asar).
    asar: true,
    files: ["dist/**/*", "package.json"],
    // stage/{core,node,ui} -> Resources/{core,node,ui}. One mapping from stage/ itself: electron-builder always drops
    // a node_modules directly under a mapping's `from`, which would drop core's.
    extraResources: [{ from: "stage", to: ".", filter: ["core/**/*", "node/**/*", "ui/**/*"] }],
    // Native addons are N-API prebuilds loaded by the shipped Node, never by Electron.
    npmRebuild: false,
    artifactName: "TheTerminal-${version}-${os}-${arch}.${ext}",
    publish: null,
    afterPack,
    mac: {
      target: [{ target: "dmg" }],
      // Ad-hoc: Apple Silicon refuses to run unsigned arm64 code. 9B sets a Developer ID and the hardened runtime.
      identity: "-",
      hardenedRuntime: false,
    },
    win: {
      // Unsigned in 9A. 9B adds signtoolOptions.
      target: [{ target: "nsis", arch: ["x64"] }],
    },
    nsis: { oneClick: true, perMachine: false },
  };
}

// Never pick up a signing certificate from the keychain by accident.
process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

export default builderConfig(process.env);
