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
// YAML block header: indicator, optional chomping/indentation digit (either order), optional comment.
// The comment runs to the line end, so a match never backtracks across a line.
const BLOCK_SCALAR = /[|>](?:[+-][1-9]?|[1-9][+-]?)?[ \t]*(?:#[^\r\n]*)?(?=[\r\n]|$)/y;

/**
 * End of a quoted value starting at `start` (a quote char): closing quote, else end of string.
 * In escaped mode the value sits inside an outer JSON string: each `\X` pair stands for one
 * inner char, and only an inner quote that is not itself escaped (`\"` but not `\\\"`) closes.
 */
function quotedEnd(s: string, start: number, escaped: boolean): { end: number; closed: boolean } {
  if (!escaped) {
    const q = s[start];
    for (let i = start + 1; i < s.length; i++) {
      if (s[i] === "\\") i++;
      else if (s[i] === q) return { end: i + 1, closed: true };
    }
    return { end: s.length, closed: false };
  }
  const q = s[start + 1];
  let innerEscape = false;
  for (let i = start + 2; i < s.length; i++) {
    const pair = s[i] === "\\";
    const c = pair ? s[++i] : s[i];
    if (innerEscape) innerEscape = false;
    else if (pair && c === "\\") innerEscape = true;
    else if (pair && c === q) return { end: i + 1, closed: true };
  }
  return { end: s.length, closed: false };
}

function lineEnd(s: string, from: number): number {
  let end = from;
  while (end < s.length && s[end] !== "\n" && s[end] !== "\r") end++;
  return end;
}

const isBreak = (c: string | undefined) => c === "\n" || c === "\r";
const isBlank = (c: string | undefined) => c === " " || c === "\t";

/**
 * End of a YAML block scalar body: the following lines indented deeper than the key's line.
 * `\n`, `\r\n` and a lone `\r` all break lines. The key's indentation is read by scanning back
 * only to the start of its own line, and the body forward from the header, so the cost is linear
 * in the lines visited (a header always ends its line, so each line is scanned back at most once).
 */
function blockScalarEnd(s: string, keyIndex: number, from: number): number {
  let lineStart = keyIndex;
  while (lineStart > 0 && !isBreak(s[lineStart - 1])) lineStart--;
  let indent = 0;
  while (isBlank(s[lineStart + indent])) indent++;
  let end = from;
  let pos = from; // at a line break or the end of the string
  while (pos < s.length) {
    const next = pos + (s[pos] === "\r" && s[pos + 1] === "\n" ? 2 : 1);
    let i = next;
    while (isBlank(s[i])) i++;
    if (i < s.length && !isBreak(s[i])) {
      if (i - next <= indent) break;
      while (i < s.length && !isBreak(s[i])) i++;
      end = i;
    }
    pos = i;
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
    let pos = m.index + m[0].length;
    // URL userinfo already redacted by URL_USERINFO (scheme://token:[REDACTED]@host): keep the host.
    if (m.index >= 3 && s.startsWith("://", m.index - 3) && s.startsWith(REDACTED + "@", pos)) continue;
    const header = HEADER_KEY.test(key) && m[2]!.includes(":");
    // A quoted key ("Cookie": or \"Cookie\":) is JSON; an unquoted one is a raw header line.
    const rawHeader = header && !/^[\\"']/.test(m[2]!);
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
      if (rawHeader) {
        // The rest of a header line is secret too: keep the quotes only if nothing else follows.
        const eol = lineEnd(s, end);
        if (s.slice(end, eol).trim() !== "") {
          replacement = REDACTED;
          end = eol;
        }
      }
    } else {
      BLOCK_SCALAR.lastIndex = pos;
      const block = BLOCK_SCALAR.exec(s);
      if (block) {
        end = blockScalarEnd(s, m.index, pos + block[0].length);
      } else if (header) {
        end = lineEnd(s, pos);
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
