/** English pluralisation for counts in plain-language copy: `1 card`, `5 cards`, `2 entries`. */
export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** `a`, `a and b`, `a, b and c`. */
export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Dollars with two decimals and thousands separators, without depending on the runtime's locale data. */
export function formatUsd(n: number): string {
  const cents = Math.round(Math.abs(n) * 100);
  const whole = Math.floor(cents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${n < 0 && cents > 0 ? "-" : ""}$${whole}.${(cents % 100).toString().padStart(2, "0")}`;
}

/** Lower-cases the first character only, so a label keeps acronyms such as "API" in the middle of a sentence. */
export function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** C0 and C1 controls other than a line break and a tab, and bidi and zero-width characters. */
const HIDDEN_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;
const SHORT_ESCAPES: Record<string, string> = { "\b": "\\b", "\f": "\\f", "\r": "\\r" };

/** Characters that could hide, reorder or restyle what is shown, as JSON escapes (`\r`, `\u001b`, `‮`). */
export function visibleControls(s: string): string {
  return s.replace(HIDDEN_CHARS, (c) => SHORT_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
