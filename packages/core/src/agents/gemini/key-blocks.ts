import { PRIVATE_KEY_LABEL } from "../redact.js";

/**
 * Where private key blocks lie in streamed text. A block starts at the beginning of the line that holds a private key
 * BEGIN marker (whatever precedes the marker on that line: a quote prefix, a line number, JSON) and is closed just
 * after the next private key END marker; until that arrives it is open and runs to the end of the text. Nothing
 * in between is judged: prose, blank lines or overlong lines inside a block stay inside it. Redaction matches the
 * same markers, so a block kept whole is always redacted whole. Certificates and other non-private blocks are not
 * tracked.
 */

const KEY_BEGIN = new RegExp(`-----BEGIN ${PRIVATE_KEY_LABEL}-----`, "g");
const KEY_END = new RegExp(`-----END ${PRIVATE_KEY_LABEL}-----`, "g");

interface KeyBlock {
  start: number;
  /** Just after the END marker, or the end of the text for an open block. */
  end: number;
  closed: boolean;
}

function* keyBlocks(text: string): Generator<KeyBlock> {
  let from = 0;
  for (;;) {
    KEY_BEGIN.lastIndex = from;
    const begin = KEY_BEGIN.exec(text);
    if (begin === null) return;
    // The marker's line start, but never inside the block before it (two keys flattened onto one line).
    const start = Math.max(from, text.lastIndexOf("\n", begin.index) + 1);
    KEY_END.lastIndex = begin.index + begin[0].length;
    const end = KEY_END.exec(text);
    if (end === null) {
      yield { start, end: text.length, closed: false };
      return;
    }
    yield { start, end: end.index + end[0].length, closed: true };
    from = end.index + end[0].length;
  }
}

/** The start of the key block that `pos` falls strictly inside (an open block runs past the end), else -1. */
export function keyBlockAround(text: string, pos: number): number {
  for (const b of keyBlocks(text)) {
    if (b.start >= pos) return -1;
    if (!b.closed || b.end > pos) return b.start;
  }
  return -1;
}

/** The start of the open key block in `text`, else -1. */
export function openKeyBlock(text: string): number {
  for (const b of keyBlocks(text)) if (!b.closed) return b.start;
  return -1;
}
