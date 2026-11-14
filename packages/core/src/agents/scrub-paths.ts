import { realpathSync } from "node:fs";

export type Scrub = (s: string) => string;

// Separators as written raw, and as they appear inside JSON text (`\\` and `\/`).
const SEPARATORS = ["/", "\\", "\\\\", "\\/"];
// A match starts at the start of the string, after a character that cannot be part of a path,
// or right after the `//` of a URL such as file:///Users/... (also JSON-escaped: file:\/\/\/...).
const LEFT = /(?<=^|[\s"'`=:(,[{;|&<>]|\/\/|\\\/\\\/)/.source;
// A match ends where the path component ends: at a separator, the end of the string, a delimiter,
// or sentence punctuation followed by whitespace. Anything else (letters, digits, non-ASCII,
// `.bak`) continues the directory name, so `/Users/ab` and `/Users/aé` are not `/Users/a`.
const RIGHT = /(?=$|[\\/\s"'`,;:)\]}|&<>=]|[.!?](?:\s|$))/.source;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Every spelling of `dir`, as written and as resolved, with each separator form; never a root. */
function spellings(dir: string): string[] {
  const out = new Set<string>();
  const add = (p: string) => {
    const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
    const named = parts.filter((x, i) => x !== "" && !(i === 0 && /^[A-Za-z]:$/.test(x)));
    if (named.length === 0) return;
    for (const sep of SEPARATORS) out.add(parts.join(sep));
  };
  add(dir);
  try {
    add(realpathSync.native(dir));
  } catch {
    // Not resolvable: the raw spelling is still scrubbed.
  }
  return [...out];
}

/**
 * Replaces absolute directories in text with placeholders (e.g. the home directory with `~`), longest
 * first. Placeholders contain no separators, so JSON-escaped text stays valid JSON. Matching ignores
 * case by default on macOS and Windows, whose filesystems usually do.
 */
export function pathScrubber(
  dirs: [dir: string, placeholder: string][],
  opts: { caseless?: boolean } = {},
): Scrub {
  const caseless = opts.caseless ?? (process.platform === "darwin" || process.platform === "win32");
  const seen = new Set<string>();
  const entries: [spelling: string, placeholder: string][] = [];
  for (const [dir, placeholder] of dirs) {
    for (const s of spellings(dir)) {
      const key = caseless ? s.toLowerCase() : s;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push([s, placeholder]);
    }
  }
  if (entries.length === 0) return (s) => s;
  entries.sort((a, b) => b[0].length - a[0].length);
  // One capture group per spelling, so the placeholder never depends on how case folding works.
  const alternatives = entries.map(([s]) => `(${escapeRegExp(s)})`).join("|");
  const re = new RegExp(`${LEFT}(?:${alternatives})${RIGHT}`, caseless ? "giu" : "gu");
  return (s) =>
    s.replace(re, (match: string, ...groups: unknown[]) => {
      const i = groups.findIndex((g, j) => j < entries.length && g !== undefined);
      return i === -1 ? match : entries[i]![1];
    });
}
