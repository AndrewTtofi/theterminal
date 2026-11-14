import { PRIVATE_KEY_LABEL, REDACTED } from "../redact.js";

/**
 * Private key blocks in streamed text. A block starts at a private key BEGIN line and ends at its END line
 * (`closed`) or at the first line after BEGIN that cannot be key body (`ended`): so a BEGIN line merely mentioned in
 * prose holds back nothing after it. Until either is seen the block is `open`. A key escaped onto one line (inside a
 * JSON string, `-----BEGIN …-----\nMII…`) ends at its END marker or at the end of that line.
 */

const KEY_BEGIN = new RegExp(`-----BEGIN ${PRIVATE_KEY_LABEL}-----`, "g");
const KEY_END = new RegExp(`-----END ${PRIVATE_KEY_LABEL}-----`, "g");
const KEY_END_LINE = new RegExp(`^[ \\t]*-----END ${PRIVATE_KEY_LABEL}-----`);
/** Base64 of at most 80 characters, or a blank line. */
const BODY_LINE = /^[ \t]*[A-Za-z0-9+/=]{0,80}[ \t]*$/;
/** PEM encryption headers and PGP armor headers. */
const HEADER_LINE = /^[ \t]*(?:Proc-Type|DEK-Info|Version|Comment|MessageID|Hash|Charset):/;
const HEADER_NAMES = ["Proc-Type:", "DEK-Info:", "Version:", "Comment:", "MessageID:", "Hash:", "Charset:"];
/** A line still arriving is judged undecided only up to this length. */
const MAX_OPEN_LINE = 128;
/** A line break escaped inside a string: `\n`, `\r\n`, or the same escaped again. */
const ESCAPED_BREAK = /^(?:\\+r)?\\+n/;
const PARTIAL_ESCAPED_BREAK = /^\\+r?\\*$/;
/** Kept from an escaped block's text, so an END marker split across chunks is still found. */
const END_CARRY = 64;

/**
 * `closed`: `at` is just after the END marker. `ended`: `at` is where the released text starts (the line break
 * before the first non-body line, or the end of an inline BEGIN marker). `open`: `at` is where scanning resumes once
 * more text arrives.
 */
export interface BodyScan {
  state: "closed" | "ended" | "open";
  at: number;
}

export interface KeyBlock extends BodyScan {
  start: number;
  /** Escaped onto one line. */
  escaped: boolean;
}

function mayContinue(line: string): boolean {
  if (line.length > MAX_OPEN_LINE) return false;
  const t = line.trimStart();
  return BODY_LINE.test(line) || HEADER_LINE.test(line) || HEADER_NAMES.some((h) => h.startsWith(t)) || /^-[-A-Z ]*$/.test(t);
}

/** Scans key body from `from`: a line start, or for an escaped block the text after its BEGIN marker. */
export function scanKeyBody(text: string, from: number, escaped: boolean): BodyScan {
  if (escaped) {
    const nl = text.indexOf("\n", from);
    const limit = nl < 0 ? text.length : nl;
    KEY_END.lastIndex = from;
    const end = KEY_END.exec(text);
    if (end !== null && end.index + end[0].length <= limit) return { state: "closed", at: end.index + end[0].length };
    return nl < 0 ? { state: "open", at: Math.max(from, text.length - END_CARRY) } : { state: "ended", at: nl };
  }
  let ls = from;
  for (;;) {
    const nl = text.indexOf("\n", ls);
    const line = text.slice(ls, nl < 0 ? text.length : nl).replace(/\r$/, "");
    const end = KEY_END_LINE.exec(line);
    if (end !== null) return { state: "closed", at: ls + end[0].length };
    if (nl < 0 ? !mayContinue(line) : !BODY_LINE.test(line) && !HEADER_LINE.test(line)) {
      return { state: "ended", at: ls > 0 && text[ls - 1] === "\n" ? ls - 1 : ls };
    }
    if (nl < 0) return { state: "open", at: ls };
    ls = nl + 1;
  }
}

function scanBlock(text: string, start: number, markerEnd: number): KeyBlock {
  const nl = text.indexOf("\n", markerEnd);
  const rest = text.slice(markerEnd, nl < 0 ? text.length : nl).replace(/\r$/, "");
  if (ESCAPED_BREAK.test(rest)) return { start, escaped: true, ...scanKeyBody(text, markerEnd, true) };
  if (rest.trim() === "") {
    return nl < 0 ? { start, escaped: false, state: "open", at: markerEnd } : { start, escaped: false, ...scanKeyBody(text, nl + 1, false) };
  }
  if (nl < 0 && PARTIAL_ESCAPED_BREAK.test(rest)) return { start, escaped: false, state: "open", at: markerEnd };
  return { start, escaped: false, state: "ended", at: markerEnd }; // prose follows the marker on its line
}

function* keyBlocks(text: string): Generator<KeyBlock> {
  let from = 0;
  for (;;) {
    KEY_BEGIN.lastIndex = from;
    const begin = KEY_BEGIN.exec(text);
    if (begin === null) return;
    const block = scanBlock(text, begin.index, begin.index + begin[0].length);
    yield block;
    if (block.state === "open") return;
    from = block.at;
  }
}

/** The start of the key block that `pos` falls strictly inside (an open block runs past the end), else -1. */
export function keyBlockAround(text: string, pos: number): number {
  for (const b of keyBlocks(text)) {
    if (b.start >= pos) return -1;
    if (b.state === "open" || b.at > pos) return b.start;
  }
  return -1;
}

/** The open key block in `text`, if any. */
export function openKeyBlock(text: string): KeyBlock | null {
  for (const b of keyBlocks(text)) if (b.state === "open") return b;
  return null;
}

/**
 * `text` up to `upto`, with each ended or open key block replaced by REDACTED. A closed block is left whole for
 * redaction, which matches BEGIN to END. `upto` must not fall inside a closed or ended block.
 */
export function sealKeyBlocks(text: string, upto = text.length): string {
  let out = "";
  let last = 0;
  for (const b of keyBlocks(text)) {
    if (b.start >= upto) break;
    if (b.state === "closed") continue;
    out += text.slice(last, b.start) + REDACTED;
    last = b.state === "open" ? upto : Math.min(b.at, upto);
  }
  return out + text.slice(last, upto);
}
