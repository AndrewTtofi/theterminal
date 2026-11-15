import { LEARN_TOPICS } from "@theterminal/shared";

export const LEARN_READ_KEY = "tt.learn.read.v1";
const KNOWN = new Set(LEARN_TOPICS.map((t) => t.id));

/** The topic ids read so far. Anything stored that is not a catalog id is dropped; storage trouble reads as nothing. */
export function readTopics(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LEARN_READ_KEY) ?? "[]");
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((x): x is string => typeof x === "string" && KNOWN.has(x)));
  } catch {
    return new Set();
  }
}

/** Remembers that the topic was opened. Unknown ids are ignored, so the stored list never outgrows the catalog. */
export function markRead(id: string): void {
  if (!KNOWN.has(id)) return;
  try {
    const read = readTopics();
    if (read.has(id)) return;
    read.add(id);
    localStorage.setItem(LEARN_READ_KEY, JSON.stringify([...read]));
  } catch {
    /* storage is optional */
  }
}
