import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  adaptBonjour,
  fakeDiscovery,
  mdnsDiscovery,
  selectDiscovery,
  type BonjourLike,
  type Discovered,
  type Discovery,
} from "../../src/link/discovery.js";

const MAC = "0123456789abcdef0123456789abcdef";
const GPU = "fedcba9876543210fedcba9876543210";
const NOW = new Date("2026-11-15T12:00:00.000Z");

const created: Discovery[] = [];
afterEach(() => {
  for (const d of created.splice(0)) d.destroy();
});
function track<T extends Discovery>(d: T): T {
  created.push(d);
  return d;
}

describe("fakeDiscovery", () => {
  it("lets two instances in one process see each other, and not themselves", () => {
    const mac = track(fakeDiscovery({ now: () => NOW }));
    const gpu = track(fakeDiscovery({ now: () => NOW }));
    const seenByMac: Discovered[][] = [];
    const stop = mac.browse((list) => seenByMac.push(list));
    expect(seenByMac.at(-1)).toEqual([]);

    mac.publish({ machineId: MAC, name: "Mac", port: 4418 });
    expect(seenByMac.at(-1)).toEqual([]);
    gpu.publish({ machineId: GPU, name: "GPU box", port: 4419 });
    expect(seenByMac.at(-1)).toEqual([{ machineId: GPU, name: "GPU box", address: "127.0.0.1:4419", seenAt: NOW.toISOString() }]);

    const seenByGpu: Discovered[][] = [];
    const stopGpu = gpu.browse((list) => seenByGpu.push(list));
    expect(seenByGpu.at(-1)).toEqual([{ machineId: MAC, name: "Mac", address: "127.0.0.1:4418", seenAt: NOW.toISOString() }]);

    gpu.unpublish();
    expect(seenByMac.at(-1)).toEqual([]);

    stop();
    const count = seenByMac.length;
    gpu.publish({ machineId: GPU, name: "GPU box", port: 4419 });
    expect(seenByMac.length).toBe(count);
    stopGpu();
  });

  it("republishing replaces the earlier record (a rename)", () => {
    const mac = track(fakeDiscovery({ now: () => NOW }));
    const gpu = track(fakeDiscovery({ now: () => NOW }));
    const seen: Discovered[][] = [];
    mac.browse((list) => seen.push(list));
    gpu.publish({ machineId: GPU, name: "GPU box", port: 4419 });
    gpu.publish({ machineId: GPU, name: "Desktop", port: 4420 });
    expect(seen.at(-1)).toEqual([{ machineId: GPU, name: "Desktop", address: "127.0.0.1:4420", seenAt: NOW.toISOString() }]);
  });

  it("destroy withdraws the record and stops browsing", () => {
    const mac = track(fakeDiscovery());
    const gpu = fakeDiscovery();
    const seen: Discovered[][] = [];
    mac.browse((list) => seen.push(list));
    const gpuSeen: Discovered[][] = [];
    gpu.browse((list) => gpuSeen.push(list));
    gpu.publish({ machineId: GPU, name: "GPU box", port: 4419 });
    expect(seen.at(-1)).toHaveLength(1);
    gpu.destroy();
    expect(seen.at(-1)).toEqual([]);
    const n = gpuSeen.length;
    mac.publish({ machineId: MAC, name: "Mac", port: 4418 });
    expect(gpuSeen.length).toBe(n);
  });

  it("refuses to advertise anything but a machine id, a valid name and a port", () => {
    const d = track(fakeDiscovery());
    expect(() => d.publish({ machineId: "not-an-id", name: "Mac", port: 4418 })).toThrow(TypeError);
    expect(() => d.publish({ machineId: MAC, name: "", port: 4418 })).toThrow(TypeError);
    expect(() => d.publish({ machineId: MAC, name: "x".repeat(41), port: 4418 })).toThrow(TypeError);
    expect(() => d.publish({ machineId: MAC, name: "Mac", port: 0 })).toThrow(TypeError);
    expect(() => d.publish({ machineId: MAC, name: "Mac", port: 70000 })).toThrow(TypeError);
  });
});

describe("selectDiscovery", () => {
  it("returns the injected discovery first", () => {
    const injected = track(fakeDiscovery());
    expect(selectDiscovery({}, injected)).toBe(injected);
  });

  it("returns the fake only under THETERMINAL_FAKE_AGENT=1 with THETERMINAL_FAKE_DISCOVERY=1", () => {
    const fakeOf = (env: NodeJS.ProcessEnv) => {
      const d = track(selectDiscovery(env));
      return (d as { kind?: string }).kind;
    };
    expect(fakeOf({ THETERMINAL_FAKE_AGENT: "1", THETERMINAL_FAKE_DISCOVERY: "1" })).toBe("fake");
    expect(fakeOf({ THETERMINAL_FAKE_DISCOVERY: "1" })).toBe("mdns");
    expect(fakeOf({ THETERMINAL_FAKE_AGENT: "1" })).toBe("mdns");
    expect(fakeOf({ THETERMINAL_FAKE_AGENT: "true", THETERMINAL_FAKE_DISCOVERY: "1" })).toBe("mdns");
    expect(fakeOf({})).toBe("mdns");
  });

  it("refuses to fall back to multicast under vitest: a test server must inject its discovery or set the flags", () => {
    expect(() => selectDiscovery({ VITEST: "true" })).toThrow(/multicast/);
    expect(() => selectDiscovery({ VITEST: "true", THETERMINAL_FAKE_DISCOVERY: "1" })).toThrow(/multicast/);
    expect((track(selectDiscovery({ VITEST: "true", THETERMINAL_FAKE_AGENT: "1", THETERMINAL_FAKE_DISCOVERY: "1" })) as { kind?: string }).kind).toBe("fake");
    const injected = track(fakeDiscovery());
    expect(selectDiscovery({ VITEST: "true" }, injected)).toBe(injected);
  });
});

/** A Bonjour double: records what is published and lets the test play browser events. No socket is opened. */
class FakeBrowser extends EventEmitter {
  services: unknown[] = [];
  stopped = false;
  constructor(readonly config: unknown) {
    super();
  }
  stop() {
    this.stopped = true;
  }
  /** Replace what the browser currently knows and announce it the way bonjour-service does. */
  show(services: unknown[], event: "up" | "down" = "up") {
    this.services = services;
    this.emit(event, services[0] ?? {});
  }
}
class FakeService extends EventEmitter {
  stopped = false;
  constructor(readonly config: Record<string, unknown>) {
    super();
  }
  stop(cb?: () => void) {
    this.stopped = true;
    cb?.();
  }
}
function fakeBonjour() {
  const state = {
    constructed: 0,
    onError: undefined as unknown,
    published: [] as FakeService[],
    browsers: [] as FakeBrowser[],
    destroyed: 0,
    /** The multicast socket's emitter, with no listener of its own, as multicast-dns has it. */
    errors: new EventEmitter(),
  };
  const create = (onError: (err: Error) => void): BonjourLike => {
    state.constructed++;
    state.onError = onError;
    return {
      errors: state.errors,
      publish(config) {
        const s = new FakeService(config as unknown as Record<string, unknown>);
        state.published.push(s);
        return s;
      },
      find(config) {
        const b = new FakeBrowser(config);
        state.browsers.push(b);
        return b;
      },
      destroy() {
        state.destroyed++;
      },
    };
  };
  return { state, create };
}

function remote(over: { txt?: unknown; address?: string; family?: string; port?: number; lastSeen?: number } = {}) {
  return {
    name: "TheTerminal fedcba98",
    port: over.port ?? 4418,
    txt: "txt" in over ? over.txt : { id: GPU, name: "GPU box", v: "1" },
    referer: { address: over.address ?? "192.168.1.20", family: over.family ?? "IPv4", port: 5353, size: 100 },
    lastSeen: over.lastSeen,
  };
}

describe("mdnsDiscovery", () => {
  it("opens no socket until it publishes or browses", () => {
    const b = fakeBonjour();
    track(mdnsDiscovery({ createBonjour: b.create }));
    expect(b.state.constructed).toBe(0);
  });

  it("publishes type theterminal over tcp with txt { id, name, v: 1 } and the instance name TheTerminal <id8>", () => {
    const b = fakeBonjour();
    const d = track(mdnsDiscovery({ createBonjour: b.create }));
    d.publish({ machineId: MAC, name: "Mac", port: 4418 });
    expect(b.state.constructed).toBe(1);
    expect(typeof b.state.onError).toBe("function");
    expect(b.state.published).toHaveLength(1);
    const config = b.state.published[0]!.config;
    expect(config).toMatchObject({
      name: "TheTerminal 01234567",
      type: "theterminal",
      protocol: "tcp",
      port: 4418,
      txt: { id: MAC, name: "Mac", v: "1" },
      disableIPv6: true,
    });
    expect(Object.keys(config.txt as object).sort()).toEqual(["id", "name", "v"]);
    // The SRV target is The Terminal's own name, never this computer's host name.
    expect(config.host).toBe("TheTerminal-01234567.local");
  });

  it("republishing stops the earlier service; unpublish stops it; destroy closes the instance", () => {
    const b = fakeBonjour();
    const d = mdnsDiscovery({ createBonjour: b.create });
    d.publish({ machineId: MAC, name: "Mac", port: 4418 });
    d.publish({ machineId: MAC, name: "Mac mini", port: 4418 });
    expect(b.state.published.map((s) => s.stopped)).toEqual([true, false]);
    expect(b.state.published[1]!.config.txt).toEqual({ id: MAC, name: "Mac mini", v: "1" });
    d.unpublish();
    expect(b.state.published[1]!.stopped).toBe(true);
    d.browse(() => {});
    d.destroy();
    expect(b.state.browsers[0]!.stopped).toBe(true);
    expect(b.state.destroyed).toBe(1);
    expect(b.state.constructed).toBe(1);
  });

  it("survives a service error (a name conflict) without throwing", () => {
    const b = fakeBonjour();
    const d = track(mdnsDiscovery({ createBonjour: b.create }));
    d.publish({ machineId: MAC, name: "Mac", port: 4418 });
    expect(() => b.state.published[0]!.emit("error", new Error("conflict"))).not.toThrow();
  });

  it("refuses to advertise invalid data", () => {
    const b = fakeBonjour();
    const d = track(mdnsDiscovery({ createBonjour: b.create }));
    expect(() => d.publish({ machineId: "ABC", name: "Mac", port: 4418 })).toThrow(TypeError);
    expect(() => d.publish({ machineId: MAC, name: "", port: 4418 })).toThrow(TypeError);
    expect(() => d.publish({ machineId: MAC, name: "Mac", port: 1.5 })).toThrow(TypeError);
    expect(b.state.published).toHaveLength(0);
  });

  it("browses for type theterminal and maps referer.address with the advertised port", () => {
    const b = fakeBonjour();
    const d = track(mdnsDiscovery({ createBonjour: b.create, now: () => NOW }));
    const seen: Discovered[][] = [];
    const stop = d.browse((list) => seen.push(list));
    expect(seen.at(-1)).toEqual([]);
    const browser = b.state.browsers[0]!;
    expect(browser.config).toEqual({ type: "theterminal", protocol: "tcp" });
    browser.show([remote({ port: 4419, lastSeen: NOW.getTime() - 5_000 })]);
    expect(seen.at(-1)).toEqual([
      { machineId: GPU, name: "GPU box", address: "192.168.1.20:4419", seenAt: new Date(NOW.getTime() - 5_000).toISOString() },
    ]);
    browser.show([], "down");
    expect(seen.at(-1)).toEqual([]);
    stop();
    expect(browser.stopped).toBe(true);
  });

  it("treats what it hears as untrusted: drops every record that does not validate", () => {
    const b = fakeBonjour();
    const d = track(mdnsDiscovery({ createBonjour: b.create, now: () => NOW }));
    d.publish({ machineId: MAC, name: "Mac", port: 4418 });
    const seen: Discovered[][] = [];
    d.browse((list) => seen.push(list));
    const good = remote();
    b.state.browsers[0]!.show([
      remote({ txt: { id: GPU.toUpperCase(), name: "GPU box", v: "1" } }),
      remote({ txt: { id: "x", name: "GPU box", v: "1" } }),
      remote({ txt: { id: GPU, name: "GPU box", v: "2" } }),
      remote({ txt: { id: GPU, name: "GPU box" } }),
      remote({ txt: { id: GPU, name: "", v: "1" } }),
      remote({ txt: { id: GPU, name: "x".repeat(41), v: "1" } }),
      remote({ txt: { id: GPU, name: Buffer.from("GPU box"), v: "1" } }),
      remote({ txt: null }),
      remote({ txt: "id=x" }),
      remote({ address: "fe80::1", family: "IPv6" }),
      remote({ address: "not an address" }),
      remote({ port: 0 }),
      remote({ port: 65536 }),
      { name: "no referer", port: 4418, txt: { id: GPU, name: "GPU box", v: "1" } },
      null,
      // Its own record, heard back from the network.
      remote({ txt: { id: MAC, name: "Mac", v: "1" } }),
      good,
    ]);
    expect(seen.at(-1)).toEqual([{ machineId: GPU, name: "GPU box", address: "192.168.1.20:4418", seenAt: NOW.toISOString() }]);
  });

  it("shows a heard name with its hidden characters escaped and capped at 40 characters", () => {
    const b = fakeBonjour();
    const d = track(mdnsDiscovery({ createBonjour: b.create, now: () => NOW }));
    const seen: Discovered[][] = [];
    d.browse((list) => seen.push(list));
    const id2 = "1".repeat(32);
    const id3 = "2".repeat(32);
    b.state.browsers[0]!.show([
      remote({ txt: { id: GPU, name: "GPU\u0000box", v: "1" } }),
      remote({ txt: { id: id2, name: "Mac\u202etxt.exe", v: "1" } }),
      remote({ txt: { id: id3, name: "\u202e".repeat(40), v: "1" } }),
    ]);
    const byId = new Map(seen.at(-1)!.map((r) => [r.machineId, r.name]));
    expect(byId.get(GPU)).toBe("GPU\\u0000box");
    expect(byId.get(id2)).toBe("Mac\\u202etxt.exe");
    expect(byId.get(id3)).toBe("\\u202e".repeat(40).slice(0, 40));
    for (const name of byId.values()) expect(name.length).toBeLessThanOrEqual(40);
  });

  it("lists one row per machine (the latest heard) and caps the list", () => {
    const b = fakeBonjour();
    const d = track(mdnsDiscovery({ createBonjour: b.create, now: () => NOW }));
    const seen: Discovered[][] = [];
    d.browse((list) => seen.push(list));
    const many = Array.from({ length: 100 }, (_, i) => remote({ txt: { id: i.toString(16).padStart(32, "0"), name: `M${i}`, v: "1" } }));
    b.state.browsers[0]!.show([
      remote({ address: "192.168.1.20", lastSeen: NOW.getTime() - 10_000 }),
      remote({ address: "192.168.1.21", lastSeen: NOW.getTime() - 1_000 }),
      ...many,
    ]);
    const list = seen.at(-1)!;
    expect(list.filter((r) => r.machineId === GPU)).toEqual([
      { machineId: GPU, name: "GPU box", address: "192.168.1.21:4418", seenAt: new Date(NOW.getTime() - 1_000).toISOString() },
    ]);
    expect(list.length).toBe(32);
  });

  it("ignores a respond error passed to the error callback", () => {
    const b = fakeBonjour();
    const d = track(mdnsDiscovery({ createBonjour: b.create }));
    d.browse(() => {});
    expect(() => (b.state.onError as (e: Error) => void)(new Error("send failed"))).not.toThrow();
    expect(d.available()).toBe(true);
  });

  it("a multicast socket error (EADDRINUSE, EACCES) never throws: discovery stops and reports itself unavailable", () => {
    const b = fakeBonjour();
    const d = track(mdnsDiscovery({ createBonjour: b.create, now: () => NOW }));
    d.publish({ machineId: MAC, name: "Mac", port: 4418 });
    const seen: Discovered[][] = [];
    d.browse((list) => seen.push(list));
    b.state.browsers[0]!.show([remote()]);
    expect(seen.at(-1)).toHaveLength(1);
    expect(d.available()).toBe(true);

    const err = Object.assign(new Error("bind EADDRINUSE 0.0.0.0:5353"), { code: "EADDRINUSE" });
    expect(() => b.state.errors.emit("error", err)).not.toThrow();
    expect(d.available()).toBe(false);
    expect(seen.at(-1)).toEqual([]);
    expect(b.state.published[0]!.stopped).toBe(true);
    expect(b.state.browsers[0]!.stopped).toBe(true);
    expect(b.state.destroyed).toBe(1);
    // A second error from the dying socket is absorbed too.
    expect(() => b.state.errors.emit("error", Object.assign(new Error("EACCES"), { code: "EACCES" }))).not.toThrow();

    // While unavailable it opens nothing new; browsing reports an empty list.
    d.publish({ machineId: MAC, name: "Mac", port: 4418 });
    const later: Discovered[][] = [];
    d.browse((list) => later.push(list));
    expect(later).toEqual([[]]);
    expect(b.state.constructed).toBe(1);
    expect(b.state.published).toHaveLength(1);

    // destroy resets it, so a later start tries the network again.
    d.destroy();
    expect(d.available()).toBe(true);
    d.browse(() => {});
    expect(b.state.constructed).toBe(2);
  });
});

describe("adaptBonjour", () => {
  it("exposes bonjour-service's inner multicast emitter, so a socket error has a listener", () => {
    const mdns = new EventEmitter();
    const raw = { server: { mdns }, publish: () => ({}), find: () => ({}), destroy: () => {} };
    const adapted = adaptBonjour(raw);
    expect(adapted.errors).toBe(mdns);
    const d = track(mdnsDiscovery({ createBonjour: () => adapted }));
    expect(() => d.publish({ machineId: MAC, name: "Mac", port: 4418 })).not.toThrow();
    expect(() => mdns.emit("error", new Error("EACCES"))).not.toThrow();
    expect(d.available()).toBe(false);
  });

  it("tolerates a Bonjour without the inner emitter", () => {
    const adapted = adaptBonjour({ publish: () => ({}), find: () => ({}), destroy: () => {} });
    expect(adapted.errors).toBeUndefined();
  });
});
