import { isIPv4, isIPv6 } from "node:net";

/**
 * The inferred network state. The Terminal never probes a third party to find out whether the internet is reachable:
 * the state comes only from the outcome of calls the Owner caused (connection tests, cloud grants, GitHub), so it is
 * labelled `inferred` and it never blocks anything local.
 */
export type NetworkState = {
  state: "online" | "offline" | "unknown";
  basis: "inferred";
  /** When the current `state` began (ISO 8601); null while `unknown`. */
  since: string | null;
  /** The code of the failure that made the state `offline`; null otherwise. */
  lastError: string | null;
};

/** System error codes that mean the internet (or name resolution) was not reachable at all. */
export const OFFLINE_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
]);

export type NetworkOutcome = { ok: true } | { ok: false; code: string | undefined };

export class NetworkObserver {
  private current: NetworkState = { state: "unknown", basis: "inferred", since: null, lastError: null };

  constructor(private readonly now: () => Date = () => new Date()) {}

  /**
   * Any response means the internet answered: `online`. A failure with a code in `OFFLINE_CODES` means it did not:
   * `offline`, with `since` set when the state changes and kept while it stays. Any other failure (a refused
   * connection, a timeout, an abort, no code) says nothing about the internet and leaves the state as it is.
   */
  report(outcome: NetworkOutcome): void {
    if (outcome.ok) {
      if (this.current.state !== "online") {
        this.current = { state: "online", basis: "inferred", since: this.now().toISOString(), lastError: null };
      }
      return;
    }
    if (outcome.code === undefined || !OFFLINE_CODES.has(outcome.code)) return;
    const since = this.current.state === "offline" ? this.current.since : this.now().toISOString();
    this.current = { state: "offline", basis: "inferred", since, lastError: outcome.code };
  }

  state(): NetworkState {
    return { ...this.current };
  }
}

/** The system error code of a fetch rejection: undici puts it on `cause`; other fetches on the error itself. */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const source = (err as { cause?: unknown }).cause ?? err;
  if (typeof source !== "object" || source === null) return undefined;
  const code = (source as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** The hostname a fetch call targets, or null when it cannot be read (fetch itself then rejects). */
function hostOf(input: Parameters<typeof fetch>[0]): string | null {
  try {
    if (input instanceof URL) return input.hostname;
    if (typeof input === "string") return new URL(input).hostname;
    return new URL(input.url).hostname;
  } catch {
    return null;
  }
}

/** Splits an IPv6 address into its eight 16-bit groups, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  if (!isIPv6(address)) return null;
  let text = address;
  const lastColon = text.lastIndexOf(":");
  const last = text.slice(lastColon + 1);
  if (isIPv4(last)) {
    // An embedded IPv4 tail (::ffff:192.168.1.1) is two groups.
    const [a, b, c, d] = last.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parse = (s: string): number[] => (s === "" ? [] : s.split(":").map((g) => parseInt(g, 16)));
  const gap = text.indexOf("::");
  if (gap === -1) return parse(text);
  const front = parse(text.slice(0, gap));
  const back = parse(text.slice(gap + 2));
  return [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
}

function ipv4IsLocal(address: string): boolean {
  const [a, b] = address.split(".").map(Number) as [number, number];
  return (
    a === 127 || // loopback
    a === 0 || // "this network" (0.0.0.0 reaches this machine)
    a === 10 || // RFC 1918
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 168) || // RFC 1918
    (a === 169 && b === 254) // link-local
  );
}

/**
 * True for hosts whose reachability says nothing about the internet: loopback, `localhost` and `*.localhost`,
 * RFC 1918 and link-local IPv4, IPv6 loopback, link-local (`fe80::/10`) and unique-local (`fc00::/7`) addresses,
 * IPv4-mapped forms of those, and mDNS `.local` names.
 */
export function saysNothingAboutTheInternet(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (isIPv4(host)) return ipv4IsLocal(host);
  const groups = ipv6Groups(host);
  if (groups) {
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
    const zeroHead = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
    if (zeroHead && g5 === 0 && g6 === 0 && g7 <= 1) return true; // :: and ::1
    if (zeroHead && g5 === 0xffff) return ipv4IsLocal(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
    return (g0 & 0xffc0) === 0xfe80 || (g0 & 0xfe00) === 0xfc00;
  }
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
}

/**
 * Wraps a fetch so that every call the Owner causes tells `observer` what it learned about the internet: any response
 * reports ok; a rejection reports its code and is rethrown unchanged. Calls to local hosts (see
 * `saysNothingAboutTheInternet`) are passed through without a report.
 */
export function observedFetch(f: typeof fetch, observer: NetworkObserver): typeof fetch {
  return async (input, init) => {
    const host = hostOf(input);
    const observe = host === null || !saysNothingAboutTheInternet(host);
    let res: Response;
    try {
      res = await f(input, init);
    } catch (err) {
      if (observe) observer.report({ ok: false, code: errorCode(err) });
      throw err;
    }
    if (observe) observer.report({ ok: true });
    return res;
  };
}
