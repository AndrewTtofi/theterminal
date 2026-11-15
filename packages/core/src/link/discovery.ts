import { isIPv4 } from "node:net";
import { Bonjour } from "bonjour-service";
import { MACHINE_ID, machineAddressSchema, machineNameSchema } from "@theterminal/shared";

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

function checkPublish(info: PublishInfo): void {
  if (typeof info.machineId !== "string" || !MACHINE_ID.test(info.machineId)) throw new TypeError("machineId must be a machine id");
  if (!machineNameSchema.safeParse(info.name).success || CONTROL.test(info.name)) throw new TypeError("name must be a machine name");
  if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535) throw new TypeError("port must be 1..65535");
}

function validName(v: unknown): v is string {
  return typeof v === "string" && machineNameSchema.safeParse(v).success && !CONTROL.test(v);
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
};
export type MdnsDeps = {
  /** Builds the Bonjour instance on first use; `onError` receives socket errors. Default: bonjour-service. */
  createBonjour?: (onError: (err: Error) => void) => BonjourLike;
  now?: () => Date;
};

const realBonjour = (onError: (err: Error) => void): BonjourLike => new Bonjour({}, onError) as unknown as BonjourLike;

/** Validates one service record heard on the network; null when anything about it is off. */
function readRecord(service: unknown, now: Date): Discovered | null {
  if (typeof service !== "object" || service === null) return null;
  const s = service as { txt?: unknown; referer?: unknown; port?: unknown; lastSeen?: unknown };
  if (typeof s.txt !== "object" || s.txt === null) return null;
  const txt = s.txt as Record<string, unknown>;
  if (txt.v !== RECORD_VERSION) return null;
  if (typeof txt.id !== "string" || !MACHINE_ID.test(txt.id)) return null;
  if (!validName(txt.name)) return null;
  if (typeof s.referer !== "object" || s.referer === null) return null;
  const address = (s.referer as { address?: unknown }).address;
  if (typeof address !== "string" || !isIPv4(address)) return null;
  if (typeof s.port !== "number" || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return null;
  const hostPort = `${address}:${s.port}`;
  if (!machineAddressSchema.safeParse(hostPort).success) return null;
  const seen = typeof s.lastSeen === "number" && Number.isFinite(s.lastSeen) ? new Date(s.lastSeen) : now;
  return { machineId: txt.id, name: txt.name, address: hostPort, seenAt: seen.toISOString() };
}

/** Discovery over mDNS/DNS-SD with bonjour-service. No socket is opened until the first publish or browse. */
export function mdnsDiscovery(deps: MdnsDeps = {}): Discovery & { readonly kind: "mdns" } {
  const createBonjour = deps.createBonjour ?? realBonjour;
  const now = deps.now ?? (() => new Date());
  let bonjour: BonjourLike | null = null;
  let published: ReturnType<BonjourLike["publish"]> | null = null;
  let selfId: string | null = null;
  const browsers = new Set<ReturnType<BonjourLike["find"]>>();

  // Discovery is best effort (a blocked port or a name conflict leaves the typed address), so errors are dropped.
  const ignore = () => {};
  const instance = (): BonjourLike => (bonjour ??= createBonjour(ignore));

  const unpublish = () => {
    published?.stop?.();
    published = null;
    selfId = null;
  };

  return {
    kind: "mdns",
    publish(info) {
      checkPublish(info);
      unpublish();
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
      const browser = instance().find({ type: SERVICE_TYPE, protocol: "tcp" });
      browsers.add(browser);
      const report = () => {
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
      unpublish();
      for (const b of browsers) b.stop();
      browsers.clear();
      bonjour?.destroy();
      bonjour = null;
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
  return mdnsDiscovery();
}
