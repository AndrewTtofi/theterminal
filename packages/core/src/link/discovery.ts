import { isIPv4 } from "node:net";
import { Bonjour } from "bonjour-service";
import { MACHINE_ID, machineAddressSchema, machineNameSchema, visibleControls } from "@theterminal/shared";

/**
 * Finding other Terminals on the local network. A machine with linking on advertises a DNS-SD service
 * `_theterminal._tcp` whose TXT record holds only its machine id, the Owner's name for it and the record version;
 * the instance and host names are derived from the machine id, never from this computer's host name or user.
 *
 * Discovery is a convenience: it is never trusted. Every record heard is validated and anything odd is dropped,
 * and a discovered address is only a suggestion for the pairing form, which checks the code against the
 * certificate the machine at that address presents. Multicast can be blocked, so a typed address always works.
 */

export type Discovered = { machineId: string; name: string; address: string; seenAt: string };
export type PublishInfo = { machineId: string; name: string; port: number };
export interface Discovery {
  publish(info: PublishInfo): void;
  unpublish(): void;
  /** Calls `onChange` with the current list at once and after every change; returns the stop function. */
  browse(onChange: (list: Discovered[]) => void): () => void;
  destroy(): void;
}

const SERVICE_TYPE = "theterminal";
const RECORD_VERSION = "1";
/** At most this many machines are listed, however many the network announces. */
const MAX_DISCOVERED = 32;
const CONTROL = /[\u0000-\u001f\u007f]/;
const NAME_MAX = 40;

function checkPublish(info: PublishInfo): void {
  if (typeof info.machineId !== "string" || !MACHINE_ID.test(info.machineId)) throw new TypeError("machineId must be a machine id");
  if (!machineNameSchema.safeParse(info.name).success || CONTROL.test(info.name)) throw new TypeError("name must be a machine name");
  if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535) throw new TypeError("port must be 1..65535");
}

/** A name heard on the network, as shown: hidden characters escaped, then cut to 40 code points. */
function shownName(heard: string): string {
  return [...visibleControls(heard)].slice(0, NAME_MAX).join("");
}

function byName(a: Discovered, b: Discovered): number {
  return a.name.localeCompare(b.name) || a.machineId.localeCompare(b.machineId);
}

// --- mDNS ---------------------------------------------------------------------------------------------------------

/** The slice of bonjour-service this module uses, so tests inject a double and never touch multicast. */
export type BonjourServiceConfig = {
  name: string;
  type: string;
  protocol: "tcp";
  port: number;
  host: string;
  txt: { id: string; name: string; v: string };
  disableIPv6: boolean;
};
export type BonjourLike = {
  publish(config: BonjourServiceConfig): { stop?: (cb?: () => void) => void; on?: (event: "error", fn: (err: Error) => void) => unknown };
  find(config: { type: string; protocol: "tcp" }): {
    on(event: "up" | "down" | "txt-update" | "srv-update", fn: () => void): unknown;
    stop(): void;
    readonly services: unknown[];
  };
  destroy(cb?: () => void): void;
  /**
   * The multicast socket's emitter. multicast-dns emits `error` on it when it cannot bind (EADDRINUSE, EACCES), and
   * bonjour-service attaches no listener, so without one that error is thrown as an uncaught exception.
   */
  errors?: { on(event: "error", fn: (err: Error) => void): unknown };
};
export type MdnsDeps = {
  /** Builds the Bonjour instance on first use; `onError` receives respond errors. Default: bonjour-service. */
  createBonjour?: (onError: (err: Error) => void) => BonjourLike;
  now?: () => Date;
};

/** A bonjour-service instance as a BonjourLike: its own methods plus its inner multicast emitter as `errors`. */
export function adaptBonjour(raw: object): BonjourLike {
  const b = raw as Omit<BonjourLike, "errors"> & { server?: { mdns?: unknown } };
  const mdns = b.server?.mdns;
  const errors =
    typeof mdns === "object" && mdns !== null && typeof (mdns as { on?: unknown }).on === "function"
      ? (mdns as NonNullable<BonjourLike["errors"]>)
      : undefined;
  return {
    publish: (config) => b.publish(config),
    find: (config) => b.find(config),
    destroy: (cb) => b.destroy(cb),
    errors,
  };
}

const realBonjour = (onError: (err: Error) => void): BonjourLike => adaptBonjour(new Bonjour({}, onError));

/** Validates one service record heard on the network; null when anything about it is off. */
function readRecord(service: unknown, now: Date): Discovered | null {
  if (typeof service !== "object" || service === null) return null;
  const s = service as { txt?: unknown; referer?: unknown; port?: unknown; lastSeen?: unknown };
  if (typeof s.txt !== "object" || s.txt === null) return null;
  const txt = s.txt as Record<string, unknown>;
  if (txt.v !== RECORD_VERSION) return null;
  if (typeof txt.id !== "string" || !MACHINE_ID.test(txt.id)) return null;
  if (typeof txt.name !== "string" || !machineNameSchema.safeParse(txt.name).success) return null;
  if (typeof s.referer !== "object" || s.referer === null) return null;
  const address = (s.referer as { address?: unknown }).address;
  if (typeof address !== "string" || !isIPv4(address)) return null;
  if (typeof s.port !== "number" || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return null;
  const hostPort = `${address}:${s.port}`;
  if (!machineAddressSchema.safeParse(hostPort).success) return null;
  const seen = typeof s.lastSeen === "number" && Number.isFinite(s.lastSeen) ? new Date(s.lastSeen) : now;
  return { machineId: txt.id, name: shownName(txt.name), address: hostPort, seenAt: seen.toISOString() };
}

/**
 * Discovery over mDNS/DNS-SD with bonjour-service. No socket is opened until the first publish or browse.
 *
 * When the multicast socket fails (another responder holds the port, or the OS refuses it), discovery stops,
 * reports itself unavailable and lists nothing; publish and browse do nothing until `destroy` resets it. The typed
 * address keeps working. A name conflict found while probing is handled inside bonjour-service, which stops the
 * service and writes one line with `console.log`; the instance name carries the machine id, so it needs a second
 * machine with the same id prefix.
 */
export function mdnsDiscovery(deps: MdnsDeps = {}): Discovery & { readonly kind: "mdns"; available(): boolean } {
  const createBonjour = deps.createBonjour ?? realBonjour;
  const now = deps.now ?? (() => new Date());
  let bonjour: BonjourLike | null = null;
  let published: ReturnType<BonjourLike["publish"]> | null = null;
  let selfId: string | null = null;
  let failed = false;
  const browsers = new Map<ReturnType<BonjourLike["find"]>, (list: Discovered[]) => void>();

  // A respond error or a service error is not fatal: the next announcement or query tries again.
  const ignore = () => {};

  const unpublish = () => {
    try {
      published?.stop?.();
    } catch {
      // The socket may already be gone.
    }
    published = null;
    selfId = null;
  };

  const shutDown = () => {
    unpublish();
    for (const b of browsers.keys()) {
      try {
        b.stop();
      } catch {
        // As above.
      }
    }
    browsers.clear();
    const b = bonjour;
    bonjour = null;
    try {
      b?.destroy();
    } catch {
      // As above.
    }
  };

  const fail = () => {
    if (failed) return;
    failed = true;
    const listeners = [...browsers.values()];
    shutDown();
    for (const onChange of listeners) onChange([]);
  };

  const instance = (): BonjourLike => {
    if (!bonjour) {
      bonjour = createBonjour(ignore);
      bonjour.errors?.on("error", fail);
    }
    return bonjour;
  };

  return {
    kind: "mdns",
    available: () => !failed,
    publish(info) {
      checkPublish(info);
      unpublish();
      if (failed) return;
      const id8 = info.machineId.slice(0, 8);
      published = instance().publish({
        name: `TheTerminal ${id8}`,
        type: SERVICE_TYPE,
        protocol: "tcp",
        port: info.port,
        host: `TheTerminal-${id8}.local`,
        txt: { id: info.machineId, name: info.name, v: RECORD_VERSION },
        disableIPv6: true,
      });
      published.on?.("error", ignore);
      selfId = info.machineId;
    },
    unpublish,
    browse(onChange) {
      if (failed) {
        onChange([]);
        return () => {};
      }
      const browser = instance().find({ type: SERVICE_TYPE, protocol: "tcp" });
      browsers.set(browser, onChange);
      const report = () => {
        if (!browsers.has(browser)) return;
        const at = now();
        const latest = new Map<string, Discovered>();
        for (const service of browser.services ?? []) {
          const row = readRecord(service, at);
          if (!row || row.machineId === selfId) continue;
          const earlier = latest.get(row.machineId);
          if (earlier) {
            if (row.seenAt >= earlier.seenAt) latest.set(row.machineId, row);
          } else if (latest.size < MAX_DISCOVERED) {
            latest.set(row.machineId, row);
          }
        }
        onChange([...latest.values()].sort(byName));
      };
      for (const event of ["up", "down", "txt-update", "srv-update"] as const) browser.on(event, report);
      report();
      return () => {
        if (!browsers.delete(browser)) return;
        browser.stop();
      };
    },
    destroy() {
      shutDown();
      failed = false;
    },
  };
}

// --- In-process fake ----------------------------------------------------------------------------------------------

type FakeRecord = { machineId: string; name: string; port: number; seenAt: string };
/** One registry per process, so two servers in one test process find each other. */
const FAKE_REGISTRY = new Map<string, FakeRecord>();
const FAKE_LISTENERS = new Set<() => void>();
function fakeChanged() {
  for (const l of [...FAKE_LISTENERS]) l();
}

/** Test double (THETERMINAL_FAKE_AGENT=1 with THETERMINAL_FAKE_DISCOVERY=1): every record is at 127.0.0.1. */
export function fakeDiscovery(deps: { now?: () => Date } = {}): Discovery & { readonly kind: "fake" } {
  const now = deps.now ?? (() => new Date());
  let selfId: string | null = null;
  const stops = new Set<() => void>();

  const unpublish = () => {
    if (selfId === null) return;
    FAKE_REGISTRY.delete(selfId);
    selfId = null;
    fakeChanged();
  };

  return {
    kind: "fake",
    publish(info) {
      checkPublish(info);
      if (selfId !== null && selfId !== info.machineId) FAKE_REGISTRY.delete(selfId);
      selfId = info.machineId;
      FAKE_REGISTRY.set(info.machineId, { machineId: info.machineId, name: info.name, port: info.port, seenAt: now().toISOString() });
      fakeChanged();
    },
    unpublish,
    browse(onChange) {
      const report = () =>
        onChange(
          [...FAKE_REGISTRY.values()]
            .filter((r) => r.machineId !== selfId)
            .map((r) => ({ machineId: r.machineId, name: r.name, address: `127.0.0.1:${r.port}`, seenAt: r.seenAt }))
            .sort(byName),
        );
      FAKE_LISTENERS.add(report);
      const stop = () => {
        FAKE_LISTENERS.delete(report);
        stops.delete(stop);
      };
      stops.add(stop);
      report();
      return stop;
    },
    destroy() {
      for (const stop of [...stops]) stop();
      unpublish();
    },
  };
}

/** The injected discovery, else the fake under THETERMINAL_FAKE_AGENT=1 with THETERMINAL_FAKE_DISCOVERY=1, else mDNS. */
export function selectDiscovery(env: NodeJS.ProcessEnv = process.env, injected?: Discovery): Discovery {
  if (injected) return injected;
  if (env.THETERMINAL_FAKE_AGENT === "1" && env.THETERMINAL_FAKE_DISCOVERY === "1") return fakeDiscovery();
  // Test-time guard (vitest sets VITEST): a test server that names no discovery never opens a multicast socket.
  if (env.VITEST) throw new Error("Refusing to browse multicast under vitest: inject `discovery` or set the test flags");
  return mdnsDiscovery();
}
