export const REDACTED = "[REDACTED]";

// Strong words match anywhere in a key; weak words only as a whole snake/kebab segment.
const SECRET_KEY =
  /(api[_-]?key|secret|token|password|passwd|pwd|private[_-]?key|authorization|cookie|credentials?)|(?:^|[_-])(?:auth|pass|session)(?:$|[_-])/i;
// Counters such as max_tokens are not secrets.
const NOT_SECRET_KEY =
  /^(?:(?:max|min|num|total|input|output|prompt|completion|reasoning|max[_-]?output|cache[_-]?read[_-]?input|cache[_-]?creation[_-]?input)[_-]?)?tokens$/i;
// Header names whose value is redacted to the end of the line.
const HEADER_KEY = /^(?:proxy-)?authorization$|^(?:set-)?cookie$|^(?:[a-z]+-)?api-key$/i;

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

// Finds "key" + separator only (the key may sit inside escaped JSON, \"key\":). The value is
// parsed by hand in redactPairs, so a non-secret pair never swallows a secret pair inside its
// value, and every scan stays linear.
const KEY_SEP = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)(\\?["']?\s*[=:]\s*)/g;
const AUTH_SCHEME = /(?:Bearer|Basic|Token|Digest)[ \t]+/iy;
const BARE_END = /[\s'",;&}]/;
const BLOCK_SCALAR = /[|>][+-]?[ \t]*(?=\r?\n|$)/y;

/** End of a quoted value starting at `start` (a quote char): closing quote, else end of string. */
function quotedEnd(s: string, start: number, escaped: boolean): { end: number; closed: boolean } {
  const q = s[start + (escaped ? 1 : 0)];
  for (let i = start + (escaped ? 2 : 1); i < s.length; i++) {
    if (s[i] === "\\") {
      if (escaped && s[i + 1] === q) return { end: i + 2, closed: true };
      i++;
    } else if (!escaped && s[i] === q) return { end: i + 1, closed: true };
  }
  return { end: s.length, closed: false };
}

/** End of a YAML block scalar body: the following lines indented deeper than the key's line. */
function blockScalarEnd(s: string, keyIndex: number, from: number): number {
  const lineStart = s.lastIndexOf("\n", keyIndex - 1) + 1;
  let indent = 0;
  while (s[lineStart + indent] === " " || s[lineStart + indent] === "\t") indent++;
  let end = from;
  let pos = s.indexOf("\n", from);
  while (pos !== -1) {
    const next = pos + 1;
    let eol = s.indexOf("\n", next);
    if (eol === -1) eol = s.length;
    let ind = 0;
    while (next + ind < eol && (s[next + ind] === " " || s[next + ind] === "\t")) ind++;
    const blank = next + ind >= eol || s[next + ind] === "\r";
    if (!blank) {
      if (ind <= indent) break;
      end = eol;
    }
    pos = eol >= s.length ? -1 : eol;
  }
  return end;
}

function redactPairs(s: string): string {
  let out = "";
  let last = 0;
  KEY_SEP.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KEY_SEP.exec(s)) !== null) {
    const key = m[1]!;
    if (!isSecretKey(key)) continue; // resume scanning inside the value
    if (m.index >= 3 && s.startsWith("://", m.index - 3)) continue; // URL userinfo: handled separately
    let pos = m.index + m[0].length;
    const header = HEADER_KEY.test(key) && m[2]!.includes(":");
    if (header) {
      AUTH_SCHEME.lastIndex = pos;
      const scheme = AUTH_SCHEME.exec(s);
      if (scheme) pos += scheme[0].length;
    }
    const escaped = s[pos] === "\\" && (s[pos + 1] === '"' || s[pos + 1] === "'");
    const q = escaped ? s[pos + 1]! : s[pos];
    let end: number;
    let replacement = REDACTED;
    if (q === '"' || q === "'") {
      const r = quotedEnd(s, pos, escaped);
      end = r.end;
      const qs = escaped ? "\\" + q : q;
      replacement = qs + REDACTED + (r.closed ? qs : "");
    } else {
      BLOCK_SCALAR.lastIndex = pos;
      const block = BLOCK_SCALAR.exec(s);
      if (block) {
        end = blockScalarEnd(s, m.index, pos + block[0].length);
      } else if (header) {
        end = pos;
        while (end < s.length && s[end] !== "\n" && s[end] !== "\r") end++;
      } else {
        end = pos;
        while (end < s.length && !BARE_END.test(s[end]!)) end++;
      }
      if (end === pos) continue;
    }
    out += s.slice(last, pos) + replacement;
    last = end;
    KEY_SEP.lastIndex = end;
  }
  return out + s.slice(last);
}

function redactString(s: string, extra: string[]): string {
  let out = s;
  for (const secret of extra) out = out.split(secret).join(REDACTED);
  for (const p of TOKEN_PATTERNS) out = out.replace(p, REDACTED);
  out = out.replace(URL_USERINFO, `$1${REDACTED}$2`);
  out = out.replace(BEARER, `$1${REDACTED}`);
  out = out.replace(BASIC, `$1${REDACTED}`);
  out = redactPairs(out);
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
