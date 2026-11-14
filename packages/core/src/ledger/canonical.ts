/** Deterministic JSON: object keys sorted recursively, no whitespace. Throws on undefined/functions/symbols/bigint. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, "$"));
}

function canonicalize(value: unknown, path: string): unknown {
  switch (typeof value) {
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return value;
    case "object": {
      if (value === null) return null;
      if (Array.isArray(value)) return value.map((v, i) => canonicalize(v, `${path}[${i}]`));
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        out[key] = canonicalize((value as Record<string, unknown>)[key], `${path}.${key}`);
      }
      return out;
    }
    default:
      return value;
  }
}
