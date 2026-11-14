export const REDACTED = "[REDACTED]";

// Strong words match anywhere in a key; weak words only as a whole snake/kebab segment.
const SECRET_KEY =
  /(api[_-]?key|secret|token|password|passwd|pwd|private[_-]?key|authorization|cookie|credentials?)|(?:^|[_-])(?:auth|pass|session)(?:$|[_-])/i;
// Counters such as max_tokens are not secrets.
const NOT_SECRET_KEY = /tokens$/i;
const HEADER_KEY = /^(?:proxy-)?authorization$|^(?:set-)?cookie$/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) && !NOT_SECRET_KEY.test(key);
}

const TOKEN_PATTERNS: RegExp[] = [
  // PEM/PGP private keys; an unterminated block is redacted to the end of the string.
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g,
  /[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ASIA[0-9A-Z]{16}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /npm_[A-Za-z0-9]{20,}/g,
  /xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
];

const BEARER = /\b(Bearer\s+)(?!\[REDACTED\])[A-Za-z0-9._~+/=-]+/gi;
const BASIC = /\b(Basic\s+)(?!\[REDACTED\])[A-Za-z0-9+/]{8,}={0,2}/g;
// scheme://user:pass@host -> keep scheme and user. The lookbehind keeps the scan linear.
const URL_USERINFO = /((?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/]*:)[^\s@/]+(@)/g;

const QUOTED_OR_BARE = `"(?:[^"\\\\\\n]|\\\\.){0,4096}"?|'(?:[^'\\\\\\n]|\\\\.){0,4096}'?`;
// Authorization / Cookie headers: the value runs to the end of the line; an auth scheme is kept.
const HEADER = new RegExp(
  `(?<![A-Za-z0-9_-])((?:proxy-)?authorization|set-cookie|cookie)(["']?\\s*:\\s*)(?:(Bearer|Basic|Token|Digest)(\\s+))?(${QUOTED_OR_BARE}|[^\\r\\n"']+)`,
  "gi",
);
// key=value, key: value, "key": "value". The key is tested in the replacer, so the scan is linear.
const KEY_VALUE = new RegExp(
  `(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)(["']?\\s*[=:]\\s*)(${QUOTED_OR_BARE}|[^\\s'",;&}]+)`,
  "g",
);

function redactValue(v: string): string {
  const q = v[0];
  if (q === '"' || q === "'") return q + REDACTED + (v.length > 1 && v.endsWith(q) ? q : "");
  return REDACTED;
}

function redactString(s: string, extra: string[]): string {
  let out = s;
  for (const secret of extra) out = out.split(secret).join(REDACTED);
  for (const p of TOKEN_PATTERNS) out = out.replace(p, REDACTED);
  out = out.replace(URL_USERINFO, `$1${REDACTED}$2`);
  out = out.replace(BEARER, `$1${REDACTED}`);
  out = out.replace(BASIC, `$1${REDACTED}`);
  out = out.replace(
    HEADER,
    (_m, key: string, sep: string, scheme: string | undefined, ws: string | undefined, val: string) =>
      key + sep + (scheme ? scheme + ws : "") + redactValue(val),
  );
  out = out.replace(KEY_VALUE, (m, key: string, sep: string, val: string) => {
    if (!isSecretKey(key)) return m;
    if (HEADER_KEY.test(key) && sep.includes(":")) return m; // handled by HEADER
    return key + sep + redactValue(val);
  });
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
      const sensitive = isSecretKey(k) && v !== null && v !== undefined && typeof v !== "boolean";
      out[k] = sensitive ? REDACTED : walk(v, extra);
    }
    return out;
  }
  return value;
}

/**
 * Returns a redacted deep copy; never mutates `value`. Empty extra secrets are ignored.
 * Callers MUST redact before truncating: truncating first can cut a secret in half so
 * that no pattern matches the remaining fragment.
 */
export function redact<T>(value: T, extraSecrets: string[] = []): T {
  return walk(value, extraSecrets.filter((s) => s.length > 0)) as T;
}

const MARKER = "…[truncated]";

/** Result is at most `max` long (exactly `max` when cut). Call AFTER `redact`, never before. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= MARKER.length) return MARKER.slice(0, Math.max(0, max));
  return s.slice(0, max - MARKER.length) + MARKER;
}
