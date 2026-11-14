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

/** Shorter values (flags such as "1" or "true") would redact ordinary text everywhere. */
const MIN_ENV_SECRET = 8;

/** The values of environment variables whose name looks secret, to pass to `redact` as extra secrets. */
export function secretEnvValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([k, v]) => isSecretKey(k) && typeof v === "string" && v.length >= MIN_ENV_SECRET)
    .map(([, v]) => v!);
}

/** The label of a PEM/PGP private key's BEGIN and END lines (`RSA PRIVATE KEY`, `PGP PRIVATE KEY BLOCK`). */
export const PRIVATE_KEY_LABEL = String.raw`[A-Z ]*PRIVATE KEY(?: BLOCK)?`;

const TOKEN_PATTERNS: RegExp[] = [
  // PEM/PGP private keys, from BEGIN to END inclusive whatever lies between: body lines of any length, each with any
  // prefix (`> `, `-`, `| `, `3: `, indentation), a key flattened onto one line with spaces or `\n` escapes, prose. An
  // unterminated block is redacted to the end of the string. The lazy middle tries the END marker once per position.
  new RegExp(`-----BEGIN ${PRIVATE_KEY_LABEL}-----[\\s\\S]*?(?:-----END ${PRIVATE_KEY_LABEL}-----|$)`, "g"),
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
const KEY_NAME = String.raw`(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)`;
const KEY_QUOTE = String.raw`\\?["']?\s*`;
const SEP = String.raw`[=:]\s*`;
const KEY_SEP = new RegExp(`${KEY_NAME}(${KEY_QUOTE}${SEP})`, "g");
const SCHEMES = "Bearer|Basic|Token|Digest";
const AUTH_SCHEME = new RegExp(`(?:${SCHEMES})[ \\t]+`, "iy");
const BARE_END = /[\s'",;&}]/;
// YAML block header: indicator, optional chomping/indentation digit (either order), optional comment.
// The comment runs to the line end, so a match never backtracks across a line.
const BLOCK_SCALAR_SOURCE = String.raw`[|>](?:[+-][1-9]?|[1-9][+-]?)?[ \t]*(?:#[^\r\n]*)?(?=[\r\n]|$)`;
const BLOCK_SCALAR = new RegExp(BLOCK_SCALAR_SOURCE, "y");
// The end of a text that a cut would separate from the secret value after it: an auth-scheme word and its
// whitespace, or a key (its separator and block-scalar header may not have arrived yet).
const TRAILING_SCHEME = new RegExp(`(?<![A-Za-z0-9])(?:${SCHEMES})\\s+$`, "i");
const TRAILING_KEY = new RegExp(`${KEY_NAME}${KEY_QUOTE}(?:${SEP}(?:${BLOCK_SCALAR_SOURCE}\\s*)?)?$`);
// A key, its separator and a quoted value that has not closed yet (`"password":"abc`).
const TRAILING_OPEN_VALUE = new RegExp(`${KEY_NAME}${KEY_QUOTE}${SEP}\\\\?["'][^"'\\\\\\r\\n]*$`);
// A YAML block-scalar header ending a line (`  password: |`, `{"x":1}password: |`): the key and what follows it. Only
// one can end a line, so the leftmost match is the one.
const BLOCK_HEADER = new RegExp(`${KEY_NAME}${KEY_QUOTE}${SEP.replace(String.raw`\s*`, String.raw`[ \t]*`)}${BLOCK_SCALAR_SOURCE}`);
/** What may precede a header that is its whole line: indentation and a list-item dash. */
const HEADER_ONLY_PREFIX = /^[ \t]*(?:-[ \t]+)?$/;
/** How much of the end of a text `trailingSecretContext` looks at: longer than any key, header or open value it needs. */
const TRAILING_WINDOW = 512;

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

/** One environment-variable reference: $VAR, ${VAR}, %VAR% or $env:VAR, optionally preceded by a (JSON-escaped) quote. */
const ENV_REFERENCE = /^(\\?["'])?(?:\$\{[A-Za-z_]\w*\}|\$env:[A-Za-z_]\w*|\$[A-Za-z_]\w*|%[A-Za-z_]\w*%)/i;
const SHELL_SEPARATOR = /[;|&\r\n]/;

/**
 * Whether the value at `pos` is exactly one environment-variable reference, which is a name and not a secret.
 * Nothing literal may be attached to it:
 * - quoted: the matching closing quote must follow the reference immediately;
 * - header value: the reference ends the line, or a shell separator follows, or a quote closes the string the
 *   header sits in (`-H "Authorization: Bearer $TOKEN" url`); whitespace or a comma may not follow;
 * - other value: the reference ends the string or is followed by whitespace or a shell separator.
 */
function isEnvReference(s: string, pos: number, header: boolean, structured: boolean): boolean {
  const m = ENV_REFERENCE.exec(s.slice(pos, pos + 128));
  if (!m) return false;
  const next = s[pos + m[0].length];
  const closesValue = (c: string | undefined) => c === '"' || c === "'" || c === "\\" || c === "," || c === "}";
  if (m[1] !== undefined) {
    // The matching quote must follow at once, and the value must end there: end of string, whitespace, a
    // separator, or (in a header or JSON) the end of the enclosing string, field or object.
    if (!s.startsWith(m[1], pos + m[0].length)) return false;
    const after = s[pos + m[0].length + m[1].length];
    return after === undefined || isBlank(after) || SHELL_SEPARATOR.test(after) || (structured && closesValue(after));
  }
  if (next === undefined || SHELL_SEPARATOR.test(next)) return true;
  if (header) return next === '"' || next === "'" || next === "\\";
  return isBlank(next);
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
    if (isEnvReference(s, pos, header, header || /^[\\"']/.test(m[2]!))) continue;
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
  // Longest first, so a secret that contains a shorter one is never left with a tail.
  const ordered = [...extra].sort((a, b) => b.length - a.length);
  for (const secret of ordered) out = out.split(secret).join(REDACTED);
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

/** `key`, or `key#2`, `key#3`, … when taken, so keys that redact to the same string never drop a value. */
function uniqueKey(out: Record<string, unknown>, key: string): string {
  if (!Object.hasOwn(out, key)) return key;
  let n = 2;
  while (Object.hasOwn(out, `${key}#${n}`)) n++;
  return `${key}#${n}`;
}

function walk(value: unknown, extra: string[]): unknown {
  if (typeof value === "string") return redactString(value, extra);
  if (Array.isArray(value)) return value.map((v) => walk(v, extra));
  if (isPlainObject(value)) {
    // Built without a prototype, so an own "__proto__" key stays data instead of setting the prototype; the spread
    // copies it as an own property of an ordinary object.
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
      const sensitive = isSecretKey(k) && v !== null && v !== undefined && typeof v !== "boolean";
      out[uniqueKey(out, redactString(k, extra))] = sensitive ? REDACTED : walk(v, extra); // a key can be a secret too
    }
    return { ...out };
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

/**
 * Where the context that redaction needs to find a secret value starts, when `head` ends with it: a trailing
 * auth-scheme word (`Bearer `) or a secret key with or without its separator (`api_key = `, `password:\n`).
 * A text cut there would leave the value without its context in the next piece. Otherwise -1.
 * `atLineStart` says that `head` begins at a line boundary, so a block-scalar header on its first line counts;
 * otherwise that line may be the tail of a longer one and is not judged.
 */
export function trailingSecretContext(head: string, atLineStart: boolean): number {
  const from = Math.max(0, head.length - TRAILING_WINDOW);
  const tail = head.slice(from);
  const scheme = TRAILING_SCHEME.exec(tail);
  if (scheme) return from + scheme.index;
  for (const re of [TRAILING_KEY, TRAILING_OPEN_VALUE]) {
    const key = re.exec(tail);
    if (key && isSecretKey(key[1]!)) return from + key.index;
  }
  const block = openBlockScalar(tail, from === 0 && atLineStart);
  return block < 0 ? -1 : from + block;
}

/**
 * Where a secret key's YAML block-scalar header whose body runs to the end of `text` (every non-blank line after it
 * indented deeper than its line) starts, else -1: the start of its line when the header is the whole line, otherwise
 * the key itself (`{"x":1}password: |`). The first line of `text` is judged only when `firstLineWhole` says it
 * starts at a line boundary.
 */
function openBlockScalar(text: string, firstLineWhole: boolean): number {
  let deepest = Infinity; // the least indentation of the non-blank lines after the candidate header
  let end = text.length;
  while (end > 0) {
    const start = text.lastIndexOf("\n", end - 1) + 1;
    if (start === 0 && !firstLineWhole) return -1;
    const line = text.slice(start, end).replace(/[\r\n]+$/, "");
    let indent = 0;
    while (isBlank(line[indent])) indent++;
    const header = BLOCK_HEADER.exec(line);
    if (header && isSecretKey(header[1]!) && indent < deepest) {
      return HEADER_ONLY_PREFIX.test(line.slice(0, header.index)) ? start : start + header.index;
    }
    if (indent < line.length) {
      deepest = Math.min(deepest, indent);
      if (deepest === 0) return -1;
    }
    if (start === 0) return -1;
    end = start - 1;
  }
  return -1;
}

/** The most raw text `heldTailStart` holds back from a stream: an unfinished line (or key block) longer than this is cleaned whole. */
export const HELD_TAIL_BYTES = 8 * 1024;
const BEGIN_PRIVATE_KEY = new RegExp(`-----BEGIN ${PRIVATE_KEY_LABEL}-----`, "y");
const END_PRIVATE_KEY = new RegExp(`-----END ${PRIVATE_KEY_LABEL}-----`);

/**
 * For text read from a stream that may go on: where the tail to keep raw until more arrives starts, so that what is
 * cleaned before it never ends inside a secret whose rest (or whose context) is still to come. That is the unfinished
 * last line, or earlier: a private key block not yet closed, or a secret key whose value may follow on the next lines
 * (`password:` or a block-scalar header). `text.length` (hold nothing) when that tail is over HELD_TAIL_BYTES.
 */
export function heldTailStart(text: string): number {
  let start = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1;
  const context = trailingSecretContext(text.slice(0, start), false);
  if (context >= 0) start = Math.min(start, context);
  const begin = text.lastIndexOf("-----BEGIN ");
  if (begin >= 0 && begin < start) {
    BEGIN_PRIVATE_KEY.lastIndex = begin;
    if (BEGIN_PRIVATE_KEY.test(text) && !END_PRIVATE_KEY.test(text.slice(begin))) start = begin;
  }
  // A UTF-16 unit is at most 3 bytes, so the byte count is only measured when it could pass the cap.
  const held = text.length - start;
  if (held * 3 > HELD_TAIL_BYTES && Buffer.byteLength(text.slice(start), "utf8") > HELD_TAIL_BYTES) return text.length;
  return start;
}

const MARKER = "…[truncated]";

/** Result is at most `max` long (exactly `max` when cut). Call AFTER `redact`, never before. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= MARKER.length) return MARKER.slice(0, Math.max(0, max));
  return s.slice(0, max - MARKER.length) + MARKER;
}
