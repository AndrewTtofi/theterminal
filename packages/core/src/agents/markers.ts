import { STAGES, visibleControls, type Stage } from "@theterminal/shared";
import { redact, truncate } from "./redact.js";

/**
 * The agent's marker lines: one grammar and one line reader for every `[[…]]` line The Terminal acts on. Markers are
 * untrusted agent output. A marker counts only as a whole (trimmed) line of the agent's own messages (the runner never
 * feeds tool output), it must match its exact pattern, and every text it carries is cleaned or bounded here before
 * anything else sees it.
 */

export type ProgressLine =
  | { kind: "plan"; steps: string[] }
  | { kind: "step"; n: number; of: number; state: "started" | "done" };

export type Marker =
  | ProgressLine
  | { kind: "card"; title: string }
  | { kind: "card-stage"; stage: Stage }
  | { kind: "card-done" }
  | { kind: "noted" }
  | { kind: "preview"; command: string; port: number }
  | { kind: "app"; platform: "ios" | "android"; target: string };

const PLAN = /^\[\[plan: (.+)\]\]$/;
const STEP = /^\[\[step ([1-9]\d?)\/([1-9]\d?) (started|done)\]\]$/;
const CARD = /^\[\[card: (.+)\]\]$/;
const CARD_STAGE = /^\[\[card-stage: (plan|design|build|ship|operate)\]\]$/i;
const CARD_DONE = /^\[\[card-done\]\]$/;
const NOTED = /^\[\[noted\]\]$/;
const PREVIEW = /^\[\[preview: (.+) \| port ([1-9]\d{0,4})\]\]$/;
const APP = /^\[\[app: (ios|android) (.+)\]\]$/;

/** The longest card title kept, and the longest app target accepted. */
const MAX_TITLE = 200;
const MAX_TARGET = 200;
const MAX_PORT = 65535;

/** Reads one line as a plan or a step marker; anything else, a marker mid-line included, is null. */
export function parseProgressLine(line: string): ProgressLine | null {
  const t = line.trim();
  const plan = PLAN.exec(t);
  if (plan) {
    const steps = plan[1]!.split("|").map((s) => s.trim());
    return steps.some((s) => s === "") ? null : { kind: "plan", steps };
  }
  const step = STEP.exec(t);
  if (step) return { kind: "step", n: Number(step[1]), of: Number(step[2]), state: step[3] as "started" | "done" };
  return null;
}

/**
 * Reads one trimmed whole line as a marker (Ruling 1), or null. A card title is trimmed, redacted, its controls made
 * visible and clipped to 200 characters; the runner cleans a preview command and an app target further before
 * recording them.
 */
export function parseMarkerLine(line: string): Marker | null {
  const progress = parseProgressLine(line);
  if (progress) return progress;
  const t = line.trim();
  const card = CARD.exec(t);
  if (card) {
    const title = truncate(visibleControls(redact(card[1]!.trim())), MAX_TITLE);
    return title === "" ? null : { kind: "card", title };
  }
  const stage = CARD_STAGE.exec(t);
  if (stage) {
    const s = stage[1]!.toLowerCase() as Stage;
    return STAGES.includes(s) ? { kind: "card-stage", stage: s } : null;
  }
  if (CARD_DONE.test(t)) return { kind: "card-done" };
  if (NOTED.test(t)) return { kind: "noted" };
  const preview = PREVIEW.exec(t);
  if (preview) {
    const command = preview[1]!.trim();
    const port = Number(preview[2]);
    return command === "" || port > MAX_PORT ? null : { kind: "preview", command, port };
  }
  const app = APP.exec(t);
  if (app) {
    const target = app[2]!.trim();
    if (target === "" || target.length > MAX_TARGET) return null;
    return { kind: "app", platform: app[1] as "ios" | "android", target };
  }
  return null;
}

/** The longest unfinished line kept between chunks, to join a marker a streaming adapter split. */
const MAX_CARRY = 400;
/** How every marker of Ruling 1 starts, lower case (`card-stage` is matched without regard to case). */
const MARKER_STARTS = ["[[plan: ", "[[step ", "[[card: ", "[[card-stage: ", "[[card-done]]", "[[noted]]", "[[preview: ", "[[app: "];

/** Whether an unfinished line could still become a marker: a prefix of a marker's start, or a line that starts like one. */
function couldBeMarker(partial: string): boolean {
  const t = partial.trimStart().toLowerCase();
  return t !== "" && MARKER_STARTS.some((m) => m.startsWith(t) || t.startsWith(m));
}

/**
 * Splits one run's message text into whole lines. A message's last line without a newline is returned at once when
 * it is a whole marker (an adapter that sends whole messages); otherwise it is kept, at most 400 characters and only
 * while it could still start a marker, and joined to the start of the next chunk (an adapter that streams a message
 * in pieces). Anything else unfinished is dropped, so a finished message is never joined to the next one.
 */
export class LineReader {
  private carry = "";

  feed(text: string): string[] {
    const lines = (this.carry + text).split("\n");
    const last = lines.pop()!;
    this.carry = "";
    if (parseMarkerLine(last)) lines.push(last);
    else if (last.length <= MAX_CARRY && couldBeMarker(last)) this.carry = last;
    return lines;
  }
}
