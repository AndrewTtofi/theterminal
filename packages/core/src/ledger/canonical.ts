/**
 * Deterministic JSON: object keys sorted recursively, no whitespace. Throws on undefined/functions/symbols/bigint.
 *
 * The text is built directly, never through an intermediate object: assigning `out[key] = …` would make an own
 * `__proto__` key (which JSON.parse creates, and agent-supplied JSON such as tool input can carry) set the
 * intermediate object's prototype instead of becoming a property, so the key vanished from the hashed bytes while
 * the value kept it. Every own enumerable key, `__proto__` included, is encoded as data, so the encoding is injective
 * over JSON values. For values with no own `__proto__` key the output is byte-identical to what existing ledgers
 * were hashed with: `JSON.stringify` of a key-sorted copy, whose member order is the engine's own-key order (see
 * `sortedKeys`).
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, "$");
}

function canonicalize(value: unknown, path: string): string {
  switch (typeof value) {
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(value);
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) return `[${value.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(",")}]`;
      const record = value as Record<string, unknown>;
      const members = sortedKeys(record).map(
        (key) => `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`)}`,
      );
      return `{${members.join(",")}}`;
    }
    default:
      // string | boolean
      return JSON.stringify(value);
  }
}

/** The largest array index (ECMA-262 OrdinaryOwnPropertyKeys): a canonical numeric string in [0, 2^32 - 2]. */
const MAX_ARRAY_INDEX = 4294967294;
const isArrayIndex = (key: string): boolean => /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) <= MAX_ARRAY_INDEX;

/**
 * The own enumerable string keys in the order the previous encoder serialised them: it inserted the keys sorted
 * into a fresh object and let JSON.stringify walk them, which puts array-index keys first in ascending numeric order
 * and the rest in insertion (here: code-unit sorted) order. Spelled out so the bytes do not depend on the engine.
 */
function sortedKeys(record: Record<string, unknown>): string[] {
  const indices: string[] = [];
  const names: string[] = [];
  for (const key of Object.keys(record)) (isArrayIndex(key) ? indices : names).push(key);
  indices.sort((a, b) => Number(a) - Number(b));
  names.sort();
  return indices.concat(names);
}
