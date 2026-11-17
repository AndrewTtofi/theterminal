import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import {
  OWNER_ID, PREVIEW_LIMITS, visibleControls, type Actor, type AgentRun, type NativeTools, type PreviewFailure, type PreviewKind,
  type PreviewEventType, type PreviewPlan, type PreviewView, type Screenshot, type ToolId,
} from "@theterminal/shared";
import { NotFoundError } from "../board/board-service.js";
import { baseChildEnv } from "../agents/child-env.js";
import { truncate } from "../agents/redact.js";
import { RemoteRunError } from "../agents/runner.js";
import { runWorktree, type ChangesDeps } from "../changes/changes.js";
import { commitEvent, commitEvents } from "../events/commit.js";
import { getPreview, latestOffer, livePreviews, previewKeyConfirmed, previewSteps, runStarter } from "../events/projections.js";
import { HumanRequiredError } from "../intake/service.js";
import type { Ledger } from "../ledger/ledger.js";
import {
  NATIVE_TIMEOUTS, PreviewFailedError, androidPlan, androidSdkDir, bundleIdFrom, buildCount, chooseSimulator, detectTools, emulatorSerials, fillPlaceholders,
  findAppTarget, findIosApp, iosPlan, nativeEnv, readAndroidOutput, realTools, resolveTool, type Simulator, type ToolRunner,
} from "./native.js";
import { frameable, freePort, isExposed, listeningAddresses, portInUse, startSupervised, waitReady, type Exit, type Supervised } from "./process.js";
import { InvalidScreenshotError, storeScreenshot } from "./screenshots.js";
import { contentKey, resolveWebArgv, webPlan, type ResolveOptions } from "./web-command.js";

/**
 * Previews the person confirms (spec "Decisions after review" 1-3 and 9; plan 12 Task 10). A preview is the person's
 * own action, on the emergency override's pattern rather than the agent gate: the person sees the exact commands, and
 * the confirmation covers them and the bytes of the files they read (package.json and the lockfile, or the build
 * files) as one key. A start whose key no longer matches records nothing and asks again. Each stage is recorded with
 * the person as actor; the process tree is killed on every way out (a stop, the tab closing, 30 minutes without the
 * tab, shutdown), and a preview left by a previous process is recorded as `restarted`.
 *
 * What this does not confine: the dev server or the build runs the project's own code as the person, with the child
 * environment's allowlist (no connection keys) and nothing else; the person trusts what the confirmed command loads.
 */

export { PreviewFailedError, RemoteRunError };

export class PreviewChangedError extends Error {
  constructor() {
    super("the preview's commands or files changed; confirm again");
    this.name = "PreviewChangedError";
  }
}

export class PreviewNotAllowedError extends Error {
  constructor() {
    super("only the Owner or the person who started the run may do this");
    this.name = "PreviewNotAllowedError";
  }
}

export class NoPreviewOfferError extends Error {
  constructor() {
    super("the run offered nothing to preview");
    this.name = "NoPreviewOfferError";
  }
}

export class PreviewBusyError extends Error {
  constructor() {
    super("another preview is running");
    this.name = "PreviewBusyError";
  }
}

export class PlatformUnsupportedError extends Error {
  constructor(readonly kind: PreviewKind) {
    super(`${kind} previews are not available on this computer`);
    this.name = "PlatformUnsupportedError";
  }
}

export class NativeToolsMissingError extends Error {
  constructor(readonly missing: ToolId[]) {
    super("tools are missing for this preview");
    this.name = "NativeToolsMissingError";
  }
}

export class ScreenshotsUnavailableError extends Error {
  constructor() {
    super("screenshots of a website need the desktop app");
    this.name = "ScreenshotsUnavailableError";
  }
}

const SYSTEM: Actor = { kind: "system", id: "preview" };
const SWEEP_MS = 60_000;
const TARGET_CHARS = 200;
const DEVICE_CHARS = 60;

type StopReason = "person" | "tab_closed" | "idle" | "shutdown" | "restarted";

export type PreviewDeps = ChangesDeps & {
  ledger: Ledger;
  /** Runs the native tools (detection and the short steps). Default realTools(platform). */
  tools?: ToolRunner;
  /** Which platform's previews are offered. Default process.platform. */
  platform?: NodeJS.Platform;
  /** Where the default Android SDK folder is looked for. Default the user's home. */
  homedir?: string;
  /** The server's environment, read only for JAVA_HOME. Default process.env. */
  serverEnv?: NodeJS.ProcessEnv;
  /** The desktop app's capture of a website preview's device views (Task 11's PreviewHost). */
  capture?: (previewId: string) => Promise<{ device: string; png: Buffer }[]>;
  newId?: () => string;
  now?: () => Date;
  /** The readiness probe's wait between rounds. */
  sleep?: (ms: number) => Promise<void>;
  spawn?: typeof nodeSpawn;
  execFile?: typeof nodeExecFile;
  /** A logical website command as a program and arguments. Default resolveWebArgv. */
  resolveWeb?: (cmd: string[], port: number, o: ResolveOptions & { scriptText?: string | null }) => { file: string; args: string[] };
  /** The server's own ports: never probed as a website preview's. */
  ownPorts?: () => number[];
  /** The program a native tool runs for the supervised steps (builds, the emulator, binary output). Default resolveTool. */
  resolveNative?: (tool: string, env: NodeJS.ProcessEnv) => { file: string; args: string[] } | null;
};

/** Everything a start needs beyond the plan the person sees. */
type Prepared = {
  plan: PreviewPlan;
  /** The commands as they run (the plan's are cleaned for showing and recording). */
  commands: string[][];
  run: AgentRun;
  abs: string;
  env: NodeJS.ProcessEnv;
  script: string | null;
  statedPort: number | null;
  simulator?: Simulator;
  derivedData?: string;
  module?: string;
  avd?: string;
};

type Live = {
  id: string;
  runId: string;
  projectId: string;
  kind: PreviewKind;
  key: string;
  actor: Actor;
  steps: string[];
  done: number;
  lastSeen: number;
  liveCount: { n: number; m: number } | null;
  abort: AbortController;
  procs: Set<Supervised>;
  ended: boolean;
  env: NodeJS.ProcessEnv;
  device: string;
  udid?: string;
  bundleId?: string;
  appPackage?: string;
  /** The emulator every adb call names (`-s`), never a real phone. */
  serial?: string;
  booted: boolean;
};

const sleepFor = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `p`'s value, or "timeout" after `ms` (a real timer that never holds the process open). */
function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export class PreviewService {
  private readonly live = new Map<string, Live>();
  private shuttingDown = false;
  private sweeper: NodeJS.Timeout | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly tools: ToolRunner;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly resolveWeb: NonNullable<PreviewDeps["resolveWeb"]>;
  private readonly resolveNative: NonNullable<PreviewDeps["resolveNative"]>;

  constructor(private readonly deps: PreviewDeps) {
    this.platform = deps.platform ?? process.platform;
    this.tools = deps.tools ?? realTools(this.platform);
    this.newId = deps.newId ?? (() => randomUUID());
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? sleepFor;
    this.resolveWeb = deps.resolveWeb ?? ((cmd, port, o) => resolveWebArgv(cmd, port, o));
    this.resolveNative =
      deps.resolveNative ??
      ((tool, env) => {
        const file = resolveTool(tool, { platform: this.platform, env });
        return file === null ? null : { file, args: [] };
      });
  }

  private nowMs = (): number => this.now().getTime();

  /** The commands the person would confirm, and their key. Records nothing. */
  async plan(actor: Actor, runId: string, kind: PreviewKind, target?: string): Promise<PreviewPlan> {
    return (await this.prepare(actor, runId, kind, target)).plan;
  }

  /**
   * Starts the preview the person confirmed with `key`: recomputes the plan and refuses a different key
   * (PreviewChangedError, nothing recorded); returns the live preview of that run and kind when its key is the same
   * (`created: false`); else records `preview.requested` and `preview.started` and runs the stages in the background.
   */
  async start(actor: Actor, runId: string, i: { kind: PreviewKind; key: string; target?: string }): Promise<{ view: PreviewView; created: boolean }> {
    if (this.shuttingDown) throw new PreviewBusyError();
    const prep = await this.prepare(actor, runId, i.kind, i.target);
    if (prep.plan.key !== i.key) throw new PreviewChangedError();
    const same = this.admit(runId, i.kind, i.key);
    if (same !== null) return { view: this.view(same.id), created: false };
    const port = i.kind === "web" ? await freePort() : undefined;
    // Checked again: another start may have been admitted while the port was found.
    if (this.shuttingDown) throw new PreviewBusyError();
    const again = this.admit(runId, i.kind, i.key);
    if (again !== null) return { view: this.view(again.id), created: false };

    const id = this.newId();
    const { db, ledger } = this.deps;
    const projectId = prep.run.projectId;
    commitEvents(db, ledger, () => ({
      events: [
        {
          projectId, actor, type: "preview.requested",
          payload: {
            previewId: id, runId, kind: i.kind, commands: prep.plan.commands, key: prep.plan.key, install: prep.plan.install,
            target: prep.plan.target.label,
          },
        },
        { projectId, actor, type: "preview.started", payload: port === undefined ? { previewId: id } : { previewId: id, port } },
      ],
      result: () => undefined,
    }));
    const l: Live = {
      id, runId, projectId, kind: i.kind, key: prep.plan.key, actor, steps: previewSteps(i.kind, prep.plan.install), done: 0,
      lastSeen: this.nowMs(), liveCount: null, abort: new AbortController(), procs: new Set(), ended: false, env: prep.env,
      device: i.kind === "ios" ? (prep.simulator?.name ?? "iPhone") : i.kind === "android" ? (prep.avd ?? "Android") : "website",
      booted: false,
    };
    this.live.set(id, l);
    this.ensureSweeper();
    const stages = i.kind === "web" ? this.runWeb(l, prep, port!) : i.kind === "ios" ? this.runIos(l, prep) : this.runAndroid(l, prep);
    void stages.catch(() => this.fail(l, "start_failed", []));
    return { view: this.view(id), created: true };
  }

  /** The preview as recorded, with the build's own count while it builds. NotFoundError for an unknown id. */
  view(id: string): PreviewView {
    const rec = getPreview(this.deps.db, id);
    if (rec === null) throw new NotFoundError("preview", id);
    const { key: _key, startedBy: _by, endedAt: _end, ...view } = rec;
    return { ...view, liveCount: this.live.get(id)?.liveCount ?? null };
  }

  /** The Preview tab is still open on it: the idle clock starts again. */
  seen(id: string): void {
    if (getPreview(this.deps.db, id) === null) throw new NotFoundError("preview", id);
    const l = this.live.get(id);
    if (l !== undefined) l.lastSeen = this.nowMs();
  }

  /** Stops a preview for the person; nothing happens for one already ended. */
  async stop(actor: Actor, id: string, reason: "person" | "tab_closed"): Promise<void> {
    if (actor.kind !== "human") throw new HumanRequiredError();
    const rec = getPreview(this.deps.db, id);
    if (rec === null) throw new NotFoundError("preview", id);
    this.allowed(actor, rec.runId);
    const l = this.live.get(id);
    if (l !== undefined) {
      await this.end(l, { type: "preview.stopped", payload: { previewId: id, reason } }, actor);
      return;
    }
    if (rec.endedAt === null) this.record(rec.projectId, actor, "preview.stopped", { previewId: id, reason });
  }

  /**
   * Screenshots of a live preview, each stored by hash and recorded as `preview.screenshot`. A website needs the
   * desktop app's capture (else ScreenshotsUnavailableError); an app is captured from the simulator or emulator. An
   * image that is not a PNG within the limit is skipped and recorded nowhere.
   */
  async screenshot(actor: Actor, id: string): Promise<Screenshot[]> {
    if (actor.kind !== "human") throw new HumanRequiredError();
    const rec = getPreview(this.deps.db, id);
    if (rec === null) throw new NotFoundError("preview", id);
    this.allowed(actor, rec.runId);
    const l = this.live.get(id);
    if (l === undefined) throw new NotFoundError("preview", id);
    let shots: { device: string; png: Buffer }[];
    if (l.kind === "web") {
      if (this.deps.capture === undefined) throw new ScreenshotsUnavailableError();
      shots = await this.deps.capture(id);
    } else {
      const png = l.kind === "ios" ? await this.iosScreenshot(l) : (l.serial === undefined ? null : await this.binaryOutput(l, "adb", ["-s", l.serial, "exec-out", "screencap", "-p"]));
      shots = png === null ? [] : [{ device: l.device, png }];
    }
    const out: Screenshot[] = [];
    for (const shot of shots) {
      let stored: ReturnType<typeof storeScreenshot>;
      try {
        stored = storeScreenshot(this.deps.dataDir, l.projectId, shot.png);
      } catch (e) {
        if (e instanceof InvalidScreenshotError) continue;
        throw e;
      }
      const device = truncate(visibleControls(String(shot.device)), DEVICE_CHARS) || "device";
      const payload = {
        previewId: id, runId: l.runId, device, sha256: stored.sha256, bytes: stored.bytes, width: stored.width, height: stored.height,
      };
      const entry = commitEvent(this.deps.db, this.deps.ledger, () => ({
        event: { projectId: l.projectId, actor, type: "preview.screenshot", payload },
        result: (e) => e,
      }));
      out.push({
        sha256: stored.sha256, runId: l.runId, previewId: id, device, width: stored.width, height: stored.height, bytes: stored.bytes,
        at: entry?.ts ?? this.now().toISOString(),
      });
    }
    return out;
  }

  /** Every preview the ledger still has open, left by a previous process, is recorded as stopped (`restarted`). */
  recoverOnStartup(): void {
    if (this.deps.ledger.readOnly) return;
    for (const rec of livePreviews(this.deps.db)) {
      if (this.live.has(rec.id)) continue;
      this.record(rec.projectId, SYSTEM, "preview.stopped", { previewId: rec.id, reason: "restarted" });
    }
  }

  /** Stops every preview that has gone 30 minutes without `seen` (or its start). Runs every minute. */
  async sweepIdle(): Promise<void> {
    const now = this.nowMs();
    const idle = [...this.live.values()].filter((l) => now - l.lastSeen >= PREVIEW_LIMITS.idleMs);
    await Promise.all(idle.map((l) => this.end(l, { type: "preview.stopped", payload: { previewId: l.id, reason: "idle" } }, SYSTEM)));
  }

  /** Kills every preview's tree and records `shutdown`; nothing starts afterwards. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.sweeper);
    this.sweeper = undefined;
    await Promise.all(
      [...this.live.values()].map((l) => this.end(l, { type: "preview.stopped", payload: { previewId: l.id, reason: "shutdown" } }, SYSTEM)),
    );
  }

  // --- checks and plans ---

  /** Ruling 13: the Owner, or the person whose `agent.started` began the run. */
  private allowed(actor: Actor, runId: string): void {
    if (actor.kind !== "human") throw new HumanRequiredError();
    if (actor.id === OWNER_ID) return;
    if (runStarter(this.deps.db, runId) !== actor.id) throw new PreviewNotAllowedError();
  }

  /**
   * Ruling 19, synchronously: the live preview of this run and kind when its key is `key`; PreviewBusyError when it
   * has another key or the server holds its limit of that kind; else null (a new one may start).
   */
  private admit(runId: string, kind: PreviewKind, key: string): Live | null {
    const all = [...this.live.values()];
    const mine = all.find((l) => l.runId === runId && l.kind === kind);
    if (mine !== undefined) {
      if (mine.key === key) return mine;
      throw new PreviewBusyError();
    }
    const web = all.filter((l) => l.kind === "web").length;
    const native = all.length - web;
    if (kind === "web" ? web >= PREVIEW_LIMITS.webPreviews : native >= PREVIEW_LIMITS.nativeBuilds) throw new PreviewBusyError();
    return null;
  }

  private async prepare(actor: Actor, runId: string, kind: PreviewKind, target?: string): Promise<Prepared> {
    if (actor.kind !== "human") throw new HumanRequiredError();
    const { db, dataDir } = this.deps;
    const { run, abs } = runWorktree(this.deps, runId);
    this.allowed(actor, runId);
    if (run.machineId !== null) throw new RemoteRunError(runId);
    const base = baseChildEnv(dataDir);
    const shown = (cmds: string[][]) => cmds.map((c) => c.map((a) => this.deps.clean(runId, a, 1000) || "-"));

    if (kind === "web") {
      const offer = latestOffer(db, runId, "web");
      if (offer === null || offer.command === null) throw new NoPreviewOfferError();
      const wp = webPlan(abs, offer.command);
      const key = contentKey(abs, "web", wp.commands, wp.files);
      return {
        plan: {
          kind, commands: shown(wp.commands), display: wp.display.map((d) => this.deps.clean(runId, d, 1000)), key,
          confirmedEarlier: previewKeyConfirmed(db, runId, key), install: wp.install,
          target: { source: "marker", label: truncate(offer.command, TARGET_CHARS) },
        },
        commands: wp.commands, run, abs, env: base, script: wp.script, statedPort: offer.port,
      };
    }

    if (kind === "ios" ? this.platform !== "darwin" : this.platform === "win32") throw new PlatformUnsupportedError(kind);
    const chosen = this.appTarget(runId, abs, kind, target);
    const homedir = this.deps.homedir ?? osHomedir();
    const tools: NativeTools = await detectTools(this.tools, {
      platform: this.platform, env: base, homedir, worktree: kind === "android" ? abs : undefined,
    });
    let commands: string[][];
    let files: string[];
    let env = base;
    const extra: Partial<Prepared> = {};
    try {
      if (kind === "ios") {
        if (tools.ios.missing.length > 0) throw new NativeToolsMissingError(tools.ios.missing);
        const simulator = chooseSimulator(tools.ios.simulators);
        if (simulator === null) throw new NativeToolsMissingError(["simulator"]);
        const derivedData = join(dataDir, "projects", run.projectId, "builds", runId);
        ({ commands, files } = iosPlan({ worktree: abs, target: chosen.target, simulator, derivedData }));
        Object.assign(extra, { simulator, derivedData });
      } else {
        if (tools.android.missing.length > 0) throw new NativeToolsMissingError(tools.android.missing);
        const sdk = androidSdkDir({ platform: this.platform, env: base, homedir });
        const avd = tools.android.avds[0];
        if (sdk === null) throw new NativeToolsMissingError(["android_sdk"]);
        if (avd === undefined) throw new NativeToolsMissingError(["avd"]);
        ({ commands, files } = androidPlan({ worktree: abs, module: chosen.target, avd, sdk }));
        env = nativeEnv(base, { sdk, server: this.deps.serverEnv ?? process.env });
        Object.assign(extra, { module: chosen.target, avd });
      }
    } catch (e) {
      if (e instanceof TypeError) throw new NoPreviewOfferError(); // a target the plans refuse
      throw e;
    }
    const key = contentKey(abs, kind, commands, files);
    const cleaned = shown(commands);
    return {
      plan: {
        kind, commands: cleaned, display: cleaned.map((c) => c.join(" ")), key, confirmedEarlier: previewKeyConfirmed(db, runId, key),
        install: false, target: { source: chosen.source, label: truncate(chosen.target, TARGET_CHARS) },
      },
      commands, run, abs, env, script: null, statedPort: null, ...extra,
    };
  }

  /**
   * The app to build: the person's choice when it is the offered or the detected one, else the run's latest offer,
   * else the single app detection finds; NoPreviewOfferError otherwise.
   */
  private appTarget(runId: string, abs: string, kind: "ios" | "android", wanted?: string): { target: string; source: "marker" | "detected" } {
    const offered = latestOffer(this.deps.db, runId, kind)?.target ?? null;
    const detected = findAppTarget(abs, kind)?.target ?? null;
    if (wanted !== undefined) {
      if (wanted === offered) return { target: wanted, source: "marker" };
      if (wanted === detected) return { target: wanted, source: "detected" };
      throw new NoPreviewOfferError();
    }
    if (offered !== null) return { target: offered, source: "marker" };
    if (detected !== null) return { target: detected, source: "detected" };
    throw new NoPreviewOfferError();
  }

  // --- stages ---

  private async runWeb(l: Live, p: Prepared, port: number): Promise<void> {
    const env = { ...p.env, PORT: String(port), HOST: "127.0.0.1", BROWSER: "none" };
    const resolve = (cmd: string[], scriptText: string | null) => this.resolveWeb(cmd, port, { env, scriptText, platform: process.platform });
    if (p.plan.install) {
      let installArgv: { file: string; args: string[] };
      try {
        installArgv = resolve(p.commands[0]!, null);
      } catch {
        return this.fail(l, "install_failed", []);
      }
      const install = this.supervise(l, installArgv, p.abs, env);
      const r = await within(install.exited, PREVIEW_LIMITS.installTimeoutMs);
      if (l.ended) return;
      if (r === "timeout" || r.code !== 0) return this.fail(l, "install_failed", install.tail());
      l.procs.delete(install);
      this.progress(l);
    }
    // The agent's stated port counts only while it is free and not the server's own: a site already listening there
    // (the person's own dev server, another run's, any local service) is never taken for this preview's.
    const stated = p.statedPort;
    const extra: number[] =
      stated !== null && stated !== port && !(this.deps.ownPorts?.() ?? []).includes(stated) && !(await portInUse(stated)) ? [stated] : [];
    if (l.ended) return;
    let argv: { file: string; args: string[] };
    try {
      argv = resolve(p.commands.at(-1)!, p.script);
    } catch {
      return this.fail(l, "start_failed", []);
    }
    const site = this.supervise(l, argv, p.abs, env);
    this.progress(l);
    const ports = [port, ...extra];
    const ready = waitReady(ports, {
      deadline: this.nowMs() + PREVIEW_LIMITS.startTimeoutMs,
      signal: l.abort.signal,
      onStage: () => this.progress(l),
      now: this.nowMs,
      sleep: this.sleep,
    });
    const first = await Promise.race([ready.then((r) => ({ ready: r })), site.exited.then((e: Exit) => ({ exit: e }))]);
    if (l.ended) return;
    if ("exit" in first) return this.fail(l, "exited", site.tail());
    if (first.ready === null) return this.fail(l, "timed_out", site.tail());
    const { origin, headers } = first.ready;
    const readyPort = Number(new URL(origin).port);
    const addresses = await listeningAddresses(readyPort, { platform: process.platform, execFile: this.deps.execFile ?? nodeExecFile });
    if (l.ended) return;
    this.recordFor(l, "preview.ready", { previewId: l.id, origin, frameable: frameable(headers), exposed: isExposed(addresses) });
    void site.exited.then(() => {
      if (!l.ended) void this.fail(l, "exited", site.tail());
    });
  }

  private async runIos(l: Live, p: Prepared): Promise<void> {
    const sim = p.simulator!;
    l.udid = sim.udid;
    const find = (head: string) => p.commands.find((c) => c.slice(0, 3).join(" ").startsWith(head));
    this.progress(l); // the tools were checked by the plan
    if (!(await this.build(l, p))) return;
    let app: string;
    try {
      app = findIosApp(p.derivedData!);
    } catch {
      return this.fail(l, "build_failed", []);
    }
    this.progress(l);
    const boot = find("xcrun simctl boot");
    if (boot !== undefined) {
      if ((await this.step(l, boot, NATIVE_TIMEOUTS.bootMs, "boot_failed")) === null) return;
      l.booted = true;
    }
    if ((await this.step(l, find("open -a")!, NATIVE_TIMEOUTS.openMs, "boot_failed")) === null) return;
    this.progress(l);
    const plutil = await this.step(l, fillPlaceholders(find("plutil")!, { plist: join(app, "Info.plist") }), NATIVE_TIMEOUTS.openMs, "build_failed");
    if (plutil === null) return;
    try {
      l.bundleId = bundleIdFrom(plutil);
    } catch {
      return this.fail(l, "build_failed", []);
    }
    if ((await this.step(l, fillPlaceholders(find("xcrun simctl install")!, { app }), NATIVE_TIMEOUTS.installMs, "install_app_failed")) === null) return;
    this.progress(l);
    const launch = fillPlaceholders(find("xcrun simctl launch")!, { bundleId: l.bundleId });
    if ((await this.step(l, launch, NATIVE_TIMEOUTS.openMs, "launch_failed")) === null) return;
    this.progress(l);
    this.recordFor(l, "preview.ready", { previewId: l.id });
  }

  private async runAndroid(l: Live, p: Prepared): Promise<void> {
    this.progress(l);
    if (!(await this.build(l, p))) return;
    let out: { apk: string; applicationId: string };
    try {
      out = readAndroidOutput(p.abs, p.module!);
    } catch {
      return this.fail(l, "build_failed", []);
    }
    l.appPackage = out.applicationId;
    this.progress(l);
    // Only an emulator is ever used: a real phone plugged in over USB is never installed on.
    const listed = async (): Promise<{ serial: string; state: string }[] | null> => {
      const r = await this.tools("adb", ["devices"], { env: l.env, timeoutMs: NATIVE_TIMEOUTS.openMs });
      return r.code === 0 ? emulatorSerials(r.stdout) : null;
    };
    const before = await listed();
    if (l.ended) return;
    if (before === null) return this.fail(l, "boot_failed", []);
    const running = before.find((e) => e.state === "device");
    if (running !== undefined) {
      l.serial = running.serial;
    } else {
      const emulator = this.resolveNative("emulator", l.env);
      if (emulator === null) return this.fail(l, "boot_failed", []);
      this.supervise(l, { file: emulator.file, args: [...emulator.args, "-avd", p.avd!] }, p.abs, l.env);
      l.booted = true;
      const deadline = this.nowMs() + NATIVE_TIMEOUTS.bootMs;
      const known = new Set(before.map((e) => e.serial));
      while (l.serial === undefined) {
        const now = await listed();
        if (l.ended) return;
        const fresh = (now ?? []).find((e) => !known.has(e.serial));
        if (fresh !== undefined) l.serial = fresh.serial;
        else if (this.nowMs() >= deadline) return this.fail(l, "boot_failed", []);
        else await this.sleep(NATIVE_TIMEOUTS.bootPollMs);
      }
      const s = l.serial;
      if ((await this.step(l, ["adb", "-s", s, "wait-for-device"], NATIVE_TIMEOUTS.bootMs, "boot_failed")) === null) return;
      for (;;) {
        const r = await this.tools("adb", ["-s", s, "shell", "getprop", "sys.boot_completed"], { env: l.env, timeoutMs: NATIVE_TIMEOUTS.openMs });
        if (l.ended) return;
        if (r.code === 0 && r.stdout.trim() === "1") break;
        if (this.nowMs() >= deadline) return this.fail(l, "boot_failed", this.lines(l, r.stdout, r.stderr));
        await this.sleep(NATIVE_TIMEOUTS.bootPollMs);
      }
    }
    const serial = l.serial;
    this.progress(l);
    if ((await this.step(l, ["adb", "-s", serial, "install", "-r", out.apk], NATIVE_TIMEOUTS.installMs, "install_app_failed")) === null) return;
    this.progress(l);
    if ((await this.step(l, ["adb", "-s", serial, "shell", "monkey", "-p", out.applicationId, "1"], NATIVE_TIMEOUTS.openMs, "launch_failed")) === null) return;
    this.progress(l);
    this.recordFor(l, "preview.ready", { previewId: l.id });
  }

  /** The build (the plan's first command), supervised so it can be killed and its `[ N/M]` counts read. */
  private async build(l: Live, p: Prepared): Promise<boolean> {
    const [tool, ...args] = p.commands[0]!;
    const program = this.resolveNative(tool!, l.env);
    if (program === null) {
      await this.fail(l, "build_failed", []);
      return false;
    }
    const build = this.supervise(l, { file: program.file, args: [...program.args, ...args] }, p.abs, l.env);
    build.onLine((line) => {
      const count = buildCount(line);
      if (count !== null) l.liveCount = count;
    });
    const r = await within(build.exited, NATIVE_TIMEOUTS.buildMs);
    if (l.ended) return false;
    l.procs.delete(build);
    l.liveCount = null;
    if (r === "timeout" || r.code !== 0) {
      await build.kill();
      await this.fail(l, "build_failed", build.tail());
      return false;
    }
    return true;
  }

  /** One short native command; its stdout, or null once the preview failed with `failure` (or ended). */
  private async step(l: Live, cmd: string[], timeoutMs: number, failure: PreviewFailure): Promise<string | null> {
    if (l.ended) return null;
    const [tool, ...args] = cmd;
    const r = await this.tools(tool!, args, { env: l.env, timeoutMs, cwd: undefined });
    if (l.ended) return null;
    if (r.code !== 0) {
      await this.fail(l, failure, this.lines(l, r.stdout, r.stderr));
      return null;
    }
    return r.stdout;
  }

  /** A program's output as a failure's tail: the last lines, each cleaned, controls shown, then clipped. */
  private lines(l: Live, stdout: string, stderr: string): string[] {
    return `${stdout}\n${stderr}`
      .split(/\r?\n/)
      .filter((s) => s.trim() !== "")
      .slice(-PREVIEW_LIMITS.tailLines)
      .map((s) => truncate(visibleControls(this.deps.clean(l.runId, s, Infinity)), PREVIEW_LIMITS.tailLineChars));
  }

  private supervise(l: Live, argv: { file: string; args: string[] }, cwd: string, env: NodeJS.ProcessEnv): Supervised {
    const sup = startSupervised(argv, {
      cwd, env, clean: (s) => this.deps.clean(l.runId, s, Infinity), spawn: this.deps.spawn, execFile: this.deps.execFile,
      platform: process.platform,
    });
    l.procs.add(sup);
    if (l.ended) void sup.kill();
    return sup;
  }

  // --- recording ---

  /** The next stage is done (stages complete in order). */
  private progress(l: Live): void {
    if (l.ended || l.done >= l.steps.length) return;
    l.done += 1;
    const done = Array.from({ length: l.done }, (_, i) => i + 1);
    this.recordFor(l, "preview.progress", { previewId: l.id, steps: l.steps, done, current: l.done < l.steps.length ? l.done + 1 : null });
  }

  private recordFor(l: Live, type: PreviewEventType, payload: Record<string, unknown>): void {
    if (l.ended) return;
    this.record(l.projectId, l.actor, type, payload);
  }

  /** Commits one entry; a ledger that cannot take it (read-only, closed) is left to recoverOnStartup. */
  private record(projectId: string, actor: Actor, type: PreviewEventType, payload: Record<string, unknown>): void {
    try {
      commitEvent(this.deps.db, this.deps.ledger, () => ({ event: { projectId, actor, type, payload }, result: () => undefined }));
    } catch {
      console.error("The Terminal: a preview entry could not be recorded");
    }
  }

  private fail(l: Live, reason: PreviewFailure, tail: string[]): Promise<void> {
    return this.end(l, { type: "preview.failed", payload: { previewId: l.id, reason, tail: tail.slice(-PREVIEW_LIMITS.tailLines) } }, l.actor);
  }

  /**
   * Ends a preview exactly once: aborts its stages, kills every process it started, quits the app (and the device,
   * when The Terminal booted it), then records the ending entry.
   */
  private async end(
    l: Live,
    entry: { type: "preview.failed"; payload: { previewId: string; reason: PreviewFailure; tail: string[] } } | {
      type: "preview.stopped"; payload: { previewId: string; reason: StopReason };
    },
    actor: Actor,
  ): Promise<void> {
    if (l.ended) return;
    l.ended = true;
    l.abort.abort();
    await Promise.all([...l.procs].map((p) => p.kill()));
    await this.quitApp(l);
    this.live.delete(l.id);
    if (this.live.size === 0) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    this.record(l.projectId, actor, entry.type, entry.payload);
  }

  private async quitApp(l: Live): Promise<void> {
    const run = (tool: string, args: string[]) =>
      this.tools(tool, args, { env: l.env, timeoutMs: NATIVE_TIMEOUTS.openMs }).catch(() => undefined);
    if (l.kind === "ios" && l.udid !== undefined) {
      if (l.bundleId !== undefined) await run("xcrun", ["simctl", "terminate", l.udid, l.bundleId]);
      if (l.booted) await run("xcrun", ["simctl", "shutdown", l.udid]);
    } else if (l.kind === "android" && l.serial !== undefined) {
      if (l.appPackage !== undefined) await run("adb", ["-s", l.serial, "shell", "am", "force-stop", l.appPackage]);
      if (l.booted) await run("adb", ["-s", l.serial, "emu", "kill"]);
    }
  }

  private ensureSweeper(): void {
    if (this.sweeper !== undefined) return;
    this.sweeper = setInterval(() => void this.sweepIdle(), SWEEP_MS);
    this.sweeper.unref?.();
  }

  // --- native screenshots ---

  private async iosScreenshot(l: Live): Promise<Buffer | null> {
    const dir = join(this.deps.dataDir, "projects", l.projectId, "artifacts");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `.capture-${randomUUID()}.png`);
    try {
      const r = await this.tools("xcrun", ["simctl", "io", l.udid!, "screenshot", file], { env: l.env, timeoutMs: NATIVE_TIMEOUTS.openMs });
      if (r.code !== 0) return null;
      return readFileSync(file);
    } catch {
      return null;
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** A tool's binary stdout (at most the screenshot limit), or null. */
  private binaryOutput(l: Live, tool: string, args: string[]): Promise<Buffer | null> {
    const program = this.resolveNative(tool, l.env);
    if (program === null) return Promise.resolve(null);
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const done = (v: Buffer | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const child = (this.deps.spawn ?? nodeSpawn)(program.file, [...program.args, ...args], {
        env: l.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done(null);
      }, NATIVE_TIMEOUTS.openMs);
      child.stdout?.on("data", (c: Buffer) => {
        size += c.length;
        if (size > PREVIEW_LIMITS.screenshotBytes) {
          child.kill("SIGKILL");
          done(null);
          return;
        }
        chunks.push(c);
      });
      child.on("error", () => done(null));
      child.on("close", (code) => done(code === 0 ? Buffer.concat(chunks) : null));
    });
  }
}
