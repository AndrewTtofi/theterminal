export const REDACTED = "[REDACTED]";

const SECRET_KEY = /(api[_-]?key|secret|token|password|passwd|private[_-]?key)/i;

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
];

const BEARER = /\b(Bearer\s+)(?!\[REDACTED\])[A-Za-z0-9._~+/=-]+/g;
// KEY=value where the key name looks secret; value runs to whitespace or a quote.
const KEY_VALUE =
  /([A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)[A-Za-z0-9_-]*\s*=\s*)(?!\[REDACTED\])[^\s'"&]+/gi;

function redactString(s: string, extra: string[]): string {
  let out = s;
  for (const secret of extra) out = out.split(secret).join(REDACTED);
  for (const p of PATTERNS) out = out.replace(p, REDACTED);
  out = out.replace(BEARER, `$1${REDACTED}`);
  out = out.replace(KEY_VALUE, `$1${REDACTED}`);
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, extra: string[]): unknown {
  if (typeof value === "string") return redactString(value, extra);
  if (Array.isArray(value)) return value.map((v) => walk(v, extra));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) && typeof v === "string" ? REDACTED : walk(v, extra);
    }
    return out;
  }
  return value;
}

/** Returns a redacted deep copy; never mutates `value`. Empty extra secrets are ignored. */
export function redact<T>(value: T, extraSecrets: string[] = []): T {
  return walk(value, extraSecrets.filter((s) => s.length > 0)) as T;
}

const MARKER = "…[truncated]";

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - MARKER.length)) + MARKER;
}
