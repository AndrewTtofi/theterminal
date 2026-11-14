import { realpathSync } from "node:fs";

export type Scrub = (s: string) => string;

// Separators as written raw, and as they appear inside JSON text (`\\` and `\/`).
const SEPARATORS = ["/", "\\", "\\\\", "\\/"];
// Characters that continue a path component (the right side treats "." separately).
const NAME = String.raw`A-Za-z0-9_\-\p{L}\p{N}\p{M}`;
const SEP = String.raw`/\\`;
// ESC as a raw character, or as written in JSON, JS, C or shell text.
const ESC = String.raw`(?:\x1b|\\u001b|\\x1b|\\033|\\e)`;

// Both boundaries are denylists: a match is refused only when it would split a longer path.
// Every lookbehind is bounded, so the scan stays linear.
const LEFT = [
  // The start of the text, or any character that is neither a path character nor a separator.
  String.raw`(?<![${NAME}.${SEP}])`,
  // A doubled separator (//Users/a, file:///Users/a): a fresh absolute path, not a longer one.
  String.raw`(?<=[${SEP}])(?=[${SEP}])`,
  // After //, after a JSON-escaped \\ (x\\C:\\Users), or after the long-path prefix \\?\.
  String.raw`(?<=//|\\\\|\\\\\?\\)`,
  // Escape sequences that end in a path character: the JSON escapes \b \f \n \r \t and \uXXXX,
  // any ANSI CSI sequence (ESC[2K, ESC[?25h, ESC[32m) and ESC( or ESC) charset selections, with ESC
  // raw or written as \u001b, \x1b, \033 or \e.
  String.raw`(?<=\\[bfnrt]|\\u[0-9A-Fa-f]{4}|${ESC}(?:\[[0-9;?]{0,32}[@-~]|[()].))`,
  // A drive-rooted spelling (C:\, C:/, C:\\): a drive can never continue a longer path, so any
  // preceding character is a boundary (cl /IC:\x, 1C:\x). The match still starts at the drive letter.
  String.raw`(?=[A-Za-z]:[${SEP}])`,
  // A command-line flag glued to the path: -v/Users/a, -I/Users/a, --prefix/Users/a.
  String.raw`(?<=(?:^|[^${NAME}.${SEP}])--?[A-Za-z0-9][A-Za-z0-9_\-]{0,63})`,
].join("|");
// The match ends unless the next character continues the component; "." does only when a path
// character follows it, so /Users/a.bak is kept while /Users/a. and /Users/a... are scrubbed.
const RIGHT = String.raw`(?![${NAME}]|\.[${NAME}])`;

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
  // Cheap first-character check before the lookbehinds, so most positions are rejected at once.
  const firsts = [...new Set(entries.map(([s]) => escapeRegExp(s[0]!)))].join("");
  const re = new RegExp(`(?=[${firsts}])(?:${LEFT})(?:${alternatives})${RIGHT}`, caseless ? "giu" : "gu");
  return (s) =>
    s.replace(re, (match: string, ...groups: unknown[]) => {
      const i = groups.findIndex((g, j) => j < entries.length && g !== undefined);
      return i === -1 ? match : entries[i]![1];
    });
}

/** Characters that continue a name: a username next to one of these is part of a longer word. */
const WORD = "A-Za-z0-9_.\\-";
const MIN_USERNAME = 3;

/**
 * Replaces the OS username with `<user>` wherever it stands as a whole word (`ls -l` owners, `whoami`, an email
 * local part). Names shorter than three characters are left alone: they would match too much ordinary text.
 */
export function usernameScrubber(username: string, opts: { caseless?: boolean } = {}): Scrub {
  if (username.length < MIN_USERNAME) return (s) => s;
  const caseless = opts.caseless ?? (process.platform === "darwin" || process.platform === "win32");
  const re = new RegExp(`(?<![${WORD}])${escapeRegExp(username)}(?![${WORD}])`, caseless ? "giu" : "gu");
  return (s) => s.replace(re, "<user>");
}
