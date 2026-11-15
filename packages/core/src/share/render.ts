import { createHash } from "node:crypto";
import {
  SHARE_SECTION_TITLES,
  SHARE_SECTIONS,
  STAGES,
  formatUsd,
  plural,
  visibleControls,
  type Evidence,
  type Figure,
  type ReadinessRow,
  type ShareSection,
  type ShareSnapshot,
  type Stage,
} from "@theterminal/shared";

/**
 * The share page: one self-contained HTML file built from a (cleaned) share snapshot. It carries no script, loads
 * nothing from anywhere, and every string from the snapshot is escaped. The renderer is pure: the same snapshot
 * gives the same bytes, and every time on the page comes from the snapshot.
 */

/** The page's Content-Security-Policy, in its meta tag. */
export const SHARE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
/** The policy sent as a header wherever the page is served, plus the one directive a meta tag cannot carry: no one may frame the page. */
export const SHARE_HEADER_CSP = `${SHARE_CSP}; frame-ancestors 'none'`;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text for an HTML text node or a quoted attribute value. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** The sha256 hex digest of the page's UTF-8 bytes. */
export function contentHashOf(html: string): string {
  return createHash("sha256").update(Buffer.from(html, "utf8")).digest("hex");
}

/** Every snapshot string: bidi, zero-width and control characters made visible as escapes, then HTML-escaped. */
const e = (s: string) => escapeHtml(visibleControls(s));

const ESTIMATE =
  '<abbr title="Not a figure from the provider. Computed by The Terminal from recorded usage.">estimate</abbr>';

const STAGE_LABELS: Record<Stage, string> = { plan: "Plan", design: "Design", build: "Build", ship: "Ship", operate: "Operate" };

const STATE_WORDS: Record<ReadinessRow["state"], string> = {
  signed_off: "Signed off",
  waived: "Waived",
  open: "Open",
  not_reached: "Not reached",
};

const CSS = [
  ":root { color-scheme: dark; --bg: #16181b; --panel: #1f2226; --line: #33373d; --text: #e6e7e9; --muted: #9aa0a8; --accent: #8fb3d9 }",
  "* { box-sizing: border-box }",
  "html { background: var(--bg) }",
  'body { margin: 0 auto; max-width: 960px; padding: 24px 16px 48px; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif }',
  "h1 { font-size: 1.9rem; margin: 0 0 8px }",
  "h2 { font-size: 1.15rem; margin: 0 0 12px; color: var(--accent) }",
  "h3 { font-size: 1rem; margin: 16px 0 6px }",
  "section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px 20px; margin: 16px 0 }",
  "a { color: var(--accent) }",
  ".controls { display: flex; gap: 16px; align-items: center; font-size: 0.9rem; color: var(--muted) }",
  ".muted, .note { color: var(--muted) }",
  ".stages { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; padding: 0; margin: 0 }",
  ".stages li { border: 1px solid var(--line); border-radius: 6px; padding: 6px 12px }",
  ".stages .current { border-color: var(--accent); color: var(--accent) }",
  ".figures { list-style: none; padding: 0; margin: 0 }",
  ".figures li { padding: 4px 0 }",
  "table { width: 100%; border-collapse: collapse; font-size: 0.9rem }",
  ".scroll { overflow-x: auto }",
  "th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--line) }",
  "th { color: var(--muted); font-weight: 600 }",
  ".reason { margin: 2px 0 8px 16px; color: var(--muted) }",
  "abbr { text-decoration: underline dotted; cursor: help }",
  "time { font-variant-numeric: tabular-nums; color: var(--muted); margin-right: 8px }",
  "footer { color: var(--muted); font-size: 0.85rem; margin-top: 24px }",
  "#present:target ~ section { min-height: 100vh; scroll-snap-align: start; font-size: 1.2rem }",
  "html:has(#present:target) { scroll-snap-type: y mandatory }",
  "@media print { .controls { display: none } section { break-inside: avoid } }",
].join("\n");

/** `2026-11-15` from an ISO timestamp. */
const day = (iso: string) => iso.slice(0, 10);
/** `2026-11-15 12:00` from an ISO timestamp, in UTC as recorded. */
const minute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
/** `1,200`: digits grouped without relying on the host's locale. */
const count = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const evidence = (ev: Evidence | null) => (ev ? `#${ev.seq} · ${e(ev.hash12)}` : "—");
const opt = (s: string | null) => (s === null || s === "" ? "—" : e(s));
const empty = (line: string) => `<p class="muted">${line}</p>`;
const table = (cols: string[], rows: string[][]) =>
  `<div class="scroll"><table><thead><tr>${cols.map((c) => `<th>${e(c)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;

/** A money figure with its basis: `$0.10 (estimate)`, or `not reported` when there is no value. */
function money(f: Figure, suffix = ""): string {
  if (f.value === null) return "not reported";
  const basis = f.basis === "estimate" ? ` (${ESTIMATE})` : f.basis === "reported" ? " (reported)" : "";
  return `${formatUsd(f.value)}${suffix}${basis}`;
}

function overview(s: ShareSnapshot): string {
  return [
    `<h1>${e(s.project.name)}</h1>`,
    `<p>${e(s.project.pitch)}</p>`,
    `<p class="muted">${e(s.owner)} · Started ${e(day(s.project.createdAt))} · Generated ${e(minute(s.generatedAt))} (UTC)</p>`,
  ].join("");
}

function progress(s: ShareSnapshot): string {
  const cells = STAGES.map((stage) => {
    const { total, done } = s.progress[stage];
    const label = STAGE_LABELS[stage];
    if (stage === s.currentStage) {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      return `<li class="current">● ${label} · ${pct}%</li>`;
    }
    if (total > 0 && done === total) return `<li class="done">✓ ${label}</li>`;
    return `<li>${label}</li>`;
  });
  return `<ul class="stages">${cells.join("")}</ul>`;
}

function numbers(s: ShareSnapshot): string {
  const n = s.numbers;
  const spend =
    n.spendUsd.value === null
      ? "Spend to date: not reported"
      : `Spend to date: ${money(n.spendUsd, n.budgetUsd === null ? "" : ` of $${n.budgetUsd}`)}`;
  const perDay = n.costPerDayUsd.value === null ? "Cost per day to run: not reported" : `~${money(n.costPerDayUsd, "/day to run")}`;
  const figures = [
    `Work done by agents: ${n.runsCompleted} of ${plural(n.runsTotal, "run")} · ${n.overrides} by hand`,
    spend,
    perDay,
    `Human decisions: ${n.decisionsMade} made · ${n.decisionsWaiting} waiting`,
    n.ci === null ? "Checks: not connected" : `Checks: ${e(n.ci)}`,
  ];
  return `<ul class="figures">${figures.map((f) => `<li>${f}</li>`).join("")}</ul>`;
}

function whatAndWhy(s: ShareSnapshot): string {
  if (s.summary === null && s.idea === null) return empty("No plan has been approved yet.");
  return [s.summary === null ? "" : `<p>${e(s.summary)}</p>`, s.idea === null ? "" : `<p class="muted">The idea: ${e(s.idea)}</p>`].join("");
}

function stack(s: ShareSnapshot): string {
  const parts: string[] = [];
  if (s.stack.length === 0) parts.push(empty("No choices recorded yet."));
  else {
    parts.push(
      table(
        ["Layer", "Choice", "Why (plain words)", "Licence or terms", "Decided"],
        s.stack.map((r) => [e(r.layer), e(r.choice), e(r.why), opt(r.licence), evidence(r.evidence)]),
      ),
    );
  }
  // Second line of defence: the footer's "Not included" must stay true even if a snapshot carries hardware anyway.
  if (s.options.includeHardware && s.hardware) {
    const h = s.hardware;
    const bits = [h.cpu === null ? null : e(h.cpu), h.memoryGb === null ? null : `${h.memoryGb} GB`, h.gpu === null ? null : e(h.gpu)];
    const known = bits.filter((b): b is string => b !== null);
    parts.push(`<p>This computer: ${known.length > 0 ? known.join(" · ") : "not detected"}</p>`);
  }
  return parts.join("");
}

function workforce(s: ShareSnapshot): string {
  if (s.workforce.length === 0) return empty("No agent has run yet.");
  const tokens = (n: number | null) => (n === null ? "—" : count(n));
  return table(
    ["Agent", "Runs", "Completed", "Failed", "Stopped", "Cost", "Tokens (in / out)"],
    s.workforce.map((w) => [
      e(w.label),
      count(w.runs),
      count(w.completed),
      count(w.failed),
      count(w.stopped),
      money(w.costUsd),
      `${tokens(w.inputTokens)} / ${tokens(w.outputTokens)}`,
    ]),
  );
}

function waiting(s: ShareSnapshot): string {
  if (s.waiting.length === 0) return empty("Nothing is waiting on a human.");
  const items = s.waiting.map((w) => {
    const since = w.since === null ? "" : ` · since ${e(day(w.since))}`;
    const card = w.cardTitle === null ? "" : ` · pauses "${e(w.cardTitle)}"`;
    return `<li>${e(w.headline)} · assigned to ${e(w.assignee)}${since}${card}</li>`;
  });
  return `<ul>${items.join("")}</ul>`;
}

function decisions(s: ShareSnapshot): string {
  if (s.decisions.length === 0 && s.decisionsOmitted === 0) return empty("No decisions recorded yet.");
  const items = s.decisions.map((d) => {
    const reason = d.reason === null || d.reason === "" ? "" : `<p class="reason">“${e(d.reason)}”</p>`;
    return `<li>${e(d.headline)} · ${e(d.by)} · ${e(day(d.at))} · ${evidence(d.evidence)}${reason}</li>`;
  });
  const more = s.decisionsOmitted > 0 ? `<p class="muted">and ${plural(s.decisionsOmitted, "earlier decision")}</p>` : "";
  return `<ul>${items.join("")}</ul>${more}`;
}

function readiness(s: ShareSnapshot): string {
  if (s.readiness.every((r) => r.state === "not_reached")) return empty("No readiness gate has been reached yet.");
  return table(
    ["Gate", "State", "Detail", "Card", "Date", "Evidence"],
    s.readiness.map((r) => [
      e(r.title),
      STATE_WORDS[r.state],
      opt(r.detail),
      opt(r.cardTitle),
      r.at === null ? "—" : e(day(r.at)),
      evidence(r.evidence),
    ]),
  );
}

function digests(s: ShareSnapshot): string {
  if (s.digests.length === 0) return empty(`No ledger entries in the last ${s.options.digestDays} days.`);
  return s.digests
    .map((d) => {
      const items = d.items.map((i) => `<li><time>${e(i.time)}</time> ${e(i.headline)}</li>`).join("");
      const more = d.more > 0 ? `<p class="muted">and ${d.more} more</p>` : "";
      const asks = s.options.includePrompts ? s.asks.filter((a) => a.day === d.day) : [];
      const askList =
        asks.length === 0
          ? ""
          : `<h4>Asks</h4><ul>${asks
              .map((a) => {
                const card = a.cardTitle === null ? "" : ` on "${e(a.cardTitle)}"`;
                return `<li><time>${e(a.time)}</time> · ${e(a.adapterLabel)}${card}: ${e(a.prompt)}</li>`;
              })
              .join("")}</ul>`;
      return `<article id="day-${e(d.day)}"><h3>${e(d.day)} (UTC)</h3><p>${e(d.summary)}</p>${
        items === "" ? "" : `<ul>${items}</ul>`
      }${more}${askList}</article>`;
    })
    .join("");
}

function history(s: ShareSnapshot): string {
  if (s.history.length === 0) return empty("No earlier days.");
  return table(
    ["Day (UTC)", "Entries", "Agent actions", "Decisions", "Cards moved"],
    s.history.map((h) => [e(h.day), count(h.entries), count(h.actions), count(h.decisions), count(h.cardsMoved)]),
  );
}

function audit(s: ShareSnapshot): string {
  const a = s.audit;
  const state = a.ok
    ? `Ledger intact: ${a.entries} entries, head #${a.headSeq} · ${a.headHash12 === null ? "—" : e(a.headHash12)}`
    : `Ledger chain broken at #${a.brokenAtSeq ?? a.headSeq + 1}: entries after it are not shown`;
  return [
    `<p>${state}</p>`,
    `<p class="muted">${e(
      "Every #<seq> · <hash> on this page names an entry of the project's append-only ledger; compare them with the audit export (theterminal-ledger-<id>.ndjson) to verify.",
    )}</p>`,
  ].join("");
}

const SECTION_BODIES: Record<ShareSection, (s: ShareSnapshot) => string> = {
  overview,
  progress,
  numbers,
  what_and_why: whatAndWhy,
  stack,
  workforce,
  waiting,
  decisions,
  readiness,
  digests,
  history,
  audit,
};

/** Render a share snapshot as one self-contained HTML page. The snapshot must already be cleaned. */
export function renderShareHtml(s: ShareSnapshot): string {
  const sections = SHARE_SECTIONS.map(
    (id) => `<section id="${id}"><h2>${e(SHARE_SECTION_TITLES[id])}</h2>${SECTION_BODIES[id](s)}</section>`,
  ).join("\n");
  const hidden = s.hidden.map((h) => `<li>${e(h)}</li>`).join("");
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${SHARE_CSP}">`,
    `<title>${e(s.project.name)} · The Terminal</title>`,
    `<style>\n${CSS}\n</style></head>`,
    "<body>\n",
    '<nav class="controls"><a href="#present">Present</a><a href="#">Exit</a><span class="note">Print this page to save it as a PDF.</span></nav>\n',
    '<span id="present"></span>\n',
    sections,
    "\n<footer>",
    `<p>Generated by The Terminal on ${e(minute(s.generatedAt))} UTC. Secrets, file contents, raw agent output and anything from other projects are not on this page.</p>`,
    `<p>Not included:</p><ul>${hidden}</ul>`,
    "</footer>\n</body></html>\n",
  ].join("");
}
