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
