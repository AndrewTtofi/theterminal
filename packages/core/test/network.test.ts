import { describe, it, expect } from "vitest";
import { NetworkObserver, OFFLINE_CODES, observedFetch, saysNothingAboutTheInternet } from "../src/network.js";

/** A clock the test moves by hand. */
function clock(start = "2026-11-15T10:00:00.000Z") {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** An error shaped like undici's fetch failure: a TypeError whose cause carries the system code. */
function fetchFailed(code: string): Error {
  const cause = Object.assign(new Error(`getaddrinfo ${code} example.com`), { code });
  return new TypeError("fetch failed", { cause });
}

describe("OFFLINE_CODES", () => {
  it("holds exactly the codes that mean the internet was not reachable", () => {
    expect([...OFFLINE_CODES].sort()).toEqual(["EAI_AGAIN", "EHOSTUNREACH", "ENETDOWN", "ENETUNREACH", "ENOTFOUND"]);
  });
});

describe("NetworkObserver", () => {
  it("starts unknown, inferred, with nothing recorded", () => {
    expect(new NetworkObserver().state()).toEqual({ state: "unknown", basis: "inferred", since: null, lastError: null });
  });

  it("walks unknown → offline → online → offline, setting since at each change", () => {
    const c = clock();
    const o = new NetworkObserver(c.now);
    o.report({ ok: false, code: "ENOTFOUND" });
    expect(o.state()).toEqual({
      state: "offline",
      basis: "inferred",
      since: "2026-11-15T10:00:00.000Z",
      lastError: "ENOTFOUND",
    });

    c.advance(60_000);
    o.report({ ok: true });
    expect(o.state()).toEqual({ state: "online", basis: "inferred", since: "2026-11-15T10:01:00.000Z", lastError: null });

    c.advance(60_000);
    o.report({ ok: false, code: "EAI_AGAIN" });
    expect(o.state()).toEqual({
      state: "offline",
      basis: "inferred",
      since: "2026-11-15T10:02:00.000Z",
      lastError: "EAI_AGAIN",
    });
  });

  it("sets since once while offline; a later offline failure updates only lastError", () => {
    const c = clock();
    const o = new NetworkObserver(c.now);
    o.report({ ok: false, code: "ENOTFOUND" });
    c.advance(5_000);
    o.report({ ok: false, code: "ENETUNREACH" });
    expect(o.state()).toMatchObject({ state: "offline", since: "2026-11-15T10:00:00.000Z", lastError: "ENETUNREACH" });
  });

  it("keeps since while online across further responses", () => {
    const c = clock();
    const o = new NetworkObserver(c.now);
    o.report({ ok: true });
    c.advance(5_000);
    o.report({ ok: true });
    expect(o.state()).toMatchObject({ state: "online", since: "2026-11-15T10:00:00.000Z" });
  });

  it("leaves the state when the failure says nothing about the internet", () => {
    const c = clock();
    const o = new NetworkObserver(c.now);
    o.report({ ok: true });
    const before = o.state();
    c.advance(1_000);
    o.report({ ok: false, code: "ECONNREFUSED" });
    o.report({ ok: false, code: "ETIMEDOUT" });
    o.report({ ok: false, code: undefined });
    expect(o.state()).toEqual(before);

    const fresh = new NetworkObserver(c.now);
    fresh.report({ ok: false, code: "ECONNREFUSED" });
    expect(fresh.state()).toEqual({ state: "unknown", basis: "inferred", since: null, lastError: null });
  });

  it("returns a copy, so callers cannot change the observer's state", () => {
    const o = new NetworkObserver();
    const s = o.state() as { state: string };
    s.state = "online";
    expect(o.state().state).toBe("unknown");
  });
});

describe("observedFetch", () => {
  it("reports ok on any response, including an error status, and returns it unchanged", async () => {
    const c = clock();
    const o = new NetworkObserver(c.now);
    const res = new Response("nope", { status: 503 });
    const f = observedFetch(async () => res, o);
    expect(await f("https://api.anthropic.com/v1/models")).toBe(res);
    expect(o.state().state).toBe("online");
  });

  it("reports the code from err.cause and rethrows the same error", async () => {
    const o = new NetworkObserver(clock().now);
    const err = fetchFailed("ENOTFOUND");
    const f = observedFetch(async () => Promise.reject(err), o);
    await expect(f("https://api.anthropic.com/v1/models")).rejects.toBe(err);
    expect(o.state()).toMatchObject({ state: "offline", lastError: "ENOTFOUND" });
  });

  it("falls back to err.code when there is no cause", async () => {
    const o = new NetworkObserver(clock().now);
    const err = Object.assign(new Error("down"), { code: "ENETDOWN" });
    const f = observedFetch(async () => Promise.reject(err), o);
    await expect(f("https://example.com/")).rejects.toBe(err);
    expect(o.state().state).toBe("offline");
  });

  it("treats a rejection without a string code (an abort, a non-error) as saying nothing", async () => {
    const o = new NetworkObserver(clock().now);
    const abort = new DOMException("The operation was aborted.", "AbortError");
    await expect(observedFetch(async () => Promise.reject(abort), o)("https://example.com/")).rejects.toBe(abort);
    await expect(observedFetch(async () => Promise.reject("boom"), o)("https://example.com/")).rejects.toBe("boom");
    await expect(observedFetch(async () => Promise.reject(null), o)("https://example.com/")).rejects.toBeNull();
    const numeric = Object.assign(new Error("x"), { code: 42 });
    await expect(observedFetch(async () => Promise.reject(numeric), o)("https://example.com/")).rejects.toBe(numeric);
    expect(o.state().state).toBe("unknown");
  });

  it("passes the arguments through unchanged", async () => {
    const o = new NetworkObserver();
    const seen: unknown[][] = [];
    const f = observedFetch(async (...args: unknown[]) => {
      seen.push(args);
      return new Response("ok");
    }, o);
    const init = { method: "POST", body: "x" };
    await f("https://example.com/a", init);
    expect(seen).toEqual([["https://example.com/a", init]]);
  });

  it("does not report for loopback or RFC 1918 hosts, whatever happens", async () => {
    for (const url of ["http://127.0.0.1:1/", "http://192.168.0.5/"]) {
      const ok = new NetworkObserver();
      await observedFetch(async () => new Response("ok"), ok)(url);
      expect(ok.state().state).toBe("unknown");
      const failed = new NetworkObserver();
      const err = fetchFailed("EHOSTUNREACH");
      await expect(observedFetch(async () => Promise.reject(err), failed)(url)).rejects.toBe(err);
      expect(failed.state().state).toBe("unknown");
    }
  });

  it("reads the host from a URL object and from a Request", async () => {
    const o = new NetworkObserver();
    const f = observedFetch(async () => new Response("ok"), o);
    await f(new URL("http://10.0.0.2/x"));
    await f(new Request("http://localhost:11434/v1/models"));
    expect(o.state().state).toBe("unknown");
    await f(new Request("https://api.github.com/"));
    expect(o.state().state).toBe("online");
  });

  it("reports a failure for a URL it cannot parse, by its code (none: the state stays)", async () => {
    const o = new NetworkObserver();
    const err = new TypeError("Invalid URL");
    await expect(observedFetch(async () => Promise.reject(err), o)("not a url")).rejects.toBe(err);
    expect(o.state().state).toBe("unknown");
  });
});

describe("saysNothingAboutTheInternet", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "localhost.",
    "theterminal.localhost",
    "127.0.0.1",
    "127.255.0.9",
    "[::1]",
    "::1",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.5",
    "169.254.10.20",
    "[fe80::1]",
    "[FEBF::1]",
    "[fd12:3456::1]",
    "[fc00::1]",
    "[::ffff:192.168.1.1]",
    "[::ffff:7f00:1]",
    "gpu-desktop.local",
    "Mac.LOCAL.",
  ])("%s is local", (host) => {
    expect(saysNothingAboutTheInternet(host)).toBe(true);
  });

  it.each([
    "api.anthropic.com",
    "api.github.com",
    "8.8.8.8",
    "172.15.0.1",
    "172.32.0.1",
    "192.169.0.1",
    "11.0.0.1",
    "[2606:4700::1111]",
    "[fec0::1]",
    "[::ffff:8.8.8.8]",
    "localhost.example.com",
    "local",
    "example.localdomain",
  ])("%s is the internet", (host) => {
    expect(saysNothingAboutTheInternet(host)).toBe(false);
  });
});
