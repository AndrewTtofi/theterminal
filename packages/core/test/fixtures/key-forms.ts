/**
 * Fake private keys, and the decorated forms an agent may show one in. The bodies are obvious filler
 * (`MIIEFAKEKEYBODY0000…`), never key material; only their shape (base64 alphabet, line widths) is realistic.
 */

export interface FakeKey {
  label: string;
  /** The base64 body with no line breaks. */
  body: string;
  /** The line width the key's tool would write. */
  width: number;
}

function filler(tag: string, chars: number): string {
  let s = "";
  for (let i = 0; s.length < chars; i++) s += `${tag}FAKEKEYBODY${String(i).padStart(4, "0")}`;
  return s.slice(0, chars);
}

/** 25 lines of 64 characters, as `openssl genrsa` writes them. */
export const RSA_KEY: FakeKey = { label: "RSA PRIVATE KEY", body: filler("MIIE", 1600), width: 64 };
/** 18 lines of 70 characters, as `ssh-keygen` writes them. */
export const OPENSSH_KEY: FakeKey = { label: "OPENSSH PRIVATE KEY", body: filler("b3Bl", 1260), width: 70 };

export const wrap = (s: string, width: number): string[] => s.match(new RegExp(`.{1,${width}}`, "g")) ?? [];
export const beginLine = (k: FakeKey): string => `-----BEGIN ${k.label}-----`;
export const endLine = (k: FakeKey): string => `-----END ${k.label}-----`;
/** The key's lines: BEGIN, the body wrapped at `width`, END. */
export const keyLines = (k: FakeKey, width = k.width): string[] => [beginLine(k), ...wrap(k.body, width), endLine(k)];

/** The key as an agent may show it, each form ending in a line break. */
export const KEY_FORMS: Record<string, (k: FakeKey) => string> = {
  plain: (k) => `${keyLines(k).join("\n")}\n`,
  quoted: (k) => `${keyLines(k).map((l) => `> ${l}`).join("\n")}\n`,
  diff: (k) => `${keyLines(k).map((l) => `-${l}`).join("\n")}\n`,
  "line-numbered": (k) => `${keyLines(k).map((l, i) => `${i + 1}: ${l}`).join("\n")}\n`,
  "markdown table": (k) => `${["| key |", "| --- |", ...keyLines(k).map((l) => `| ${l} |`)].join("\n")}\n`,
  indented: (k) => `${keyLines(k).map((l) => `    ${l}`).join("\n")}\n`,
  "flattened with spaces": (k) => `${keyLines(k).join(" ")}\n`,
  "escaped in JSON": (k) => `{"pem":"${keyLines(k).join("\\n")}\\n","n":1}\n`,
  "120-char lines": (k) => `${keyLines(k, 120).join("\n")}\n`,
};

/** How much of a key body in one piece counts as a leak. */
export const LEAK_WINDOW = 20;

/** The first `LEAK_WINDOW`-character stretch of the key's body found in `text`, or null when none is. */
export function leakedKeyBody(text: string, key: FakeKey): string | null {
  for (let i = 0; i + LEAK_WINDOW <= key.body.length; i++) {
    const window = key.body.slice(i, i + LEAK_WINDOW);
    if (text.includes(window)) return window;
  }
  return null;
}

/** Every `LEAK_WINDOW`-character stretch of the key's body, for `not.toContain` checks on a record. */
export const keyBodyWindows = (key: FakeKey): string[] => Array.from({ length: key.body.length - LEAK_WINDOW + 1 }, (_, i) => key.body.slice(i, i + LEAK_WINDOW));
