import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HIDDEN_BY_DEFAULT, SHARE_SECTION_TITLES, SHARE_SECTIONS, type ShareSnapshot } from "@theterminal/shared";
import { SHARE_CSP, contentHashOf, escapeHtml, renderShareHtml } from "../../src/share/render.js";
import { WAIVER_EVIDENCE, bookClubSnapshot } from "./fixture.js";

const ABBR = '<abbr title="Not a figure from the provider. Computed by The Terminal from recorded usage.">estimate</abbr>';

/** The page with markup removed and entities decoded, so assertions read as the viewer would. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function sectionHtml(html: string, id: string): string {
  const start = html.indexOf(`<section id="${id}">`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
}

function render(change: (s: ShareSnapshot) => void = () => {}): string {
  const s = bookClubSnapshot();
  change(s);
  return renderShareHtml(s);
}

describe("escapeHtml", () => {
  it("escapes the five characters that matter in text and attributes", () => {
    expect(escapeHtml(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &#39; f");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("renderShareHtml", () => {
  it("opens with the fixed head: charset, viewport, the CSP and the project's title", () => {
    const html = render();
    expect(html.startsWith('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport"')).toBe(true);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${SHARE_CSP}">`);
    expect(html).toContain("<title>Book Club · The Terminal</title>");
    expect(SHARE_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'");
  });

  it("renders the twelve sections in order, each with its title", () => {
    const html = render();
    const ids = [...html.matchAll(/<section id="([a-z_]+)">/g)].map((m) => m[1]);
    expect(ids).toEqual([...SHARE_SECTIONS]);
    for (const id of SHARE_SECTIONS) expect(sectionHtml(html, id)).toContain(`<h2>${SHARE_SECTION_TITLES[id]}</h2>`);
  });

  it("has the presentation controls and the empty target before the sections", () => {
    const html = render();
    expect(html).toContain('<nav class="controls">');
    expect(html).toContain('<a href="#present">Present</a>');
    expect(html).toContain('<a href="#">Exit</a>');
    expect(html).toContain("Print this page to save it as a PDF.");
    const target = html.indexOf('<span id="present"></span>');
    expect(target).toBeGreaterThan(-1);
    expect(target).toBeLessThan(html.indexOf("<section"));
    expect(html).toContain("#present:target ~ section { min-height: 100vh; scroll-snap-align: start; font-size: 1.2rem }");
    expect(html).toContain("html:has(#present:target) { scroll-snap-type: y mandatory }");
    expect(html).toContain("@media print { .controls { display: none } section { break-inside: avoid } }");
  });

  it("carries no script, no external resource and no frame, and escapes a hostile pitch", () => {
    const html = render((s) => {
      s.project.pitch = "<script>alert(1)</script> https://example.test";
    });
    for (const banned of ["<script", "<link", "<img", "<iframe", "src=", "url(", "http://"]) {
      expect(html.toLowerCase()).not.toContain(banned);
    }
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; https://example.test");
    // The only https:// is the snapshot's own escaped text.
    expect(html.split("https://").length - 1).toBe(1);
  });

  it("escapes every snapshot string, not only the pitch", () => {
    const evil = `<img src=x onerror="a">'`;
    const html = render((s) => {
      s.project.name = evil;
      s.summary = evil;
      s.stack[0]!.why = evil;
      s.workforce[0]!.label = evil;
      s.waiting[0]!.headline = evil;
      s.waiting[0]!.cardTitle = evil;
      s.decisions[0]!.reason = evil;
      s.readiness[1]!.detail = evil;
      s.digests[0]!.summary = evil;
      s.digests[0]!.items[0]!.headline = evil;
      s.hidden = [evil];
      s.options.includePrompts = true;
      s.asks = [{ day: "2026-11-15", time: "10:00", adapterLabel: evil, cardTitle: evil, prompt: evil }];
      s.options.includeHardware = true;
      s.hardware = {
        cpu: evil,
        cores: 8,
        memoryGb: 16,
        gpu: evil,
        gpuMemoryGb: null,
        platform: "linux",
        wsl: false,
        detectedAt: "2026-11-15T09:00:00.000Z",
      };
    });
    expect(html.toLowerCase()).not.toContain("<img");
    expect(html).not.toContain(`onerror="`);
    expect(html).toContain("&lt;img src=x onerror=&quot;a&quot;&gt;&#39;");
  });

  it("shows bidi overrides, isolates and zero-width characters as escapes, never raw", () => {
    const sneaky = (word: string) => `${word}\u202Eevil\u2066x\u200By`;
    const html = render((s) => {
      s.waiting[0]!.cardTitle = sneaky("card");
      s.waiting[0]!.headline = sneaky("headline");
      s.decisions[0]!.reason = sneaky("reason");
      s.digests[0]!.summary = sneaky("summary");
    });
    expect(html).not.toMatch(/[\u202E\u2066\u200B]/u);
    for (const word of ["card", "headline", "reason", "summary"]) {
      expect(html).toContain(`${word}\\u202eevil\\u2066x\\u200by`);
    }
    // The exported escapeHtml keeps its contract: only the five HTML characters.
    expect(escapeHtml("a\u202Eb")).toBe("a\u202Eb");
  });

  it("leaves out hardware and asks unless the snapshot's options include them", () => {
    const hardware = {
      cpu: "Test CPU",
      cores: 8,
      memoryGb: 16,
      gpu: "Test GPU",
      gpuMemoryGb: 8,
      platform: "linux" as const,
      wsl: false,
      detectedAt: "2026-11-15T09:00:00.000Z",
    };
    const asks = [{ day: "2026-11-15", time: "10:00", adapterLabel: "Fake agent", cardTitle: "Login", prompt: "Build the login page" }];
    const off = render((s) => {
      s.hardware = hardware;
      s.asks = asks;
    });
    expect(off).not.toContain("This computer:");
    expect(off).not.toContain("Test CPU");
    expect(off).not.toContain("Build the login page");
    expect(text(sectionHtml(off, "digests"))).not.toContain("Asks");
    const on = render((s) => {
      s.options.includeHardware = true;
      s.options.includePrompts = true;
      s.hardware = hardware;
      s.asks = asks;
    });
    expect(text(on)).toContain("This computer: Test CPU · 16 GB · Test GPU");
    expect(text(on)).toContain("Build the login page");
  });

  it("shows the overview: name, pitch and dates", () => {
    const overview = text(sectionHtml(render(), "overview"));
    expect(overview).toContain("Book Club");
    expect(overview).toContain("Reading lists for a club, [email]");
    expect(overview).toContain("Owner · Started 2026-11-14 · Generated 2026-11-15 12:00 (UTC)");
    expect(sectionHtml(render(), "overview")).toContain("<h1>Book Club</h1>");
  });

  it("marks done stages, the current stage with its percentage, and plain cells for the rest", () => {
    const progress = text(sectionHtml(render(), "progress"));
    expect(progress).toContain("✓ Plan");
    expect(progress).toContain("● Build · 0%");
    expect(progress).toContain("Design");
    expect(progress).not.toContain("✓ Design");
    const seventy = text(
      sectionHtml(
        render((s) => {
          s.progress.build = { total: 10, done: 7 };
        }),
        "progress",
      ),
    );
    expect(seventy).toContain("● Build · 70%");
  });

  it("shows the headline numbers, each estimate marked as one", () => {
    const html = sectionHtml(render(), "numbers");
    const t = text(html);
    expect(t).toContain("Work done by agents: 1 of 2 runs · 0 by hand");
    expect(t).toContain("Spend to date: $0.10 of $25 (estimate)");
    expect(t).toContain("~$0.10/day to run (estimate)");
    expect(t).toContain("Human decisions: 4 made · 1 waiting");
    expect(t).toContain("Checks: not connected");
    expect(html).toContain(`$0.10 of $25 (${ABBR})`);
    expect(html.split(ABBR).length - 1).toBe(2);

    const other = text(
      sectionHtml(
        render((s) => {
          s.numbers.runsTotal = 1;
          s.numbers.spendUsd = { value: null, basis: "not_reported" };
          s.numbers.costPerDayUsd = { value: null, basis: "not_reported" };
          s.numbers.ci = "passing";
        }),
        "numbers",
      ),
    );
    expect(other).toContain("Work done by agents: 1 of 1 run · 0 by hand");
    expect(other).toContain("Spend to date: not reported");
    expect(other).toContain("Checks: passing");
  });

  it("shows the tech stack table with its evidence, and the hardware line only when present", () => {
    const html = sectionHtml(render(), "stack");
    for (const col of ["Layer", "Choice", "Why (plain words)", "Licence or terms", "Decided"]) expect(html).toContain(`<th>${col}</th>`);
    expect(text(html)).toContain("#8 · 0123456789ab");
    expect(html).not.toContain("This computer:");
    const withHw = render((s) => {
      s.options.includeHardware = true;
      s.hardware = {
        cpu: "Test CPU",
        cores: 8,
        memoryGb: 16,
        gpu: "Test GPU",
        gpuMemoryGb: 8,
        platform: "linux",
        wsl: false,
        detectedAt: "2026-11-15T09:00:00.000Z",
      };
    });
    expect(text(sectionHtml(withHw, "stack"))).toContain("This computer: Test CPU · 16 GB · Test GPU");
  });

  it("shows the workforce table", () => {
    const html = sectionHtml(render(), "workforce");
    for (const col of ["Agent", "Runs", "Completed", "Failed", "Stopped", "Cost", "Tokens (in / out)"]) {
      expect(html).toContain(`<th>${col}</th>`);
    }
    expect(text(html)).toContain("Fake agent");
    expect(text(html)).toContain("1,200 / 340");
    expect(html).toContain(ABBR);
  });

  it("shows what is waiting and the decisions with their evidence and reasons", () => {
    const html = render();
    expect(text(sectionHtml(html, "waiting"))).toContain(
      'A Fake agent wants to run the command "nvidia-smi" · assigned to Owner · since 2026-11-15 · pauses "Search"',
    );
    const decisions = text(sectionHtml(html, "decisions"));
    const ev = `#${WAIVER_EVIDENCE.seq} · ${WAIVER_EVIDENCE.hash12}`;
    expect(decisions).toContain(`Owner waived "Ready to ship" for "Login" · Owner · 2026-11-15 · ${ev}`);
    expect(decisions).toContain("“We are only testing this”");
    expect(decisions).toContain("and 2 earlier decisions");
    const readiness = text(sectionHtml(html, "readiness"));
    expect(readiness).toContain(ev);
    for (const word of ["Waived", "Open", "Not reached"]) expect(readiness).toContain(word);
    expect(readiness).toContain("We are only testing this");
    expect(readiness).toContain("Login");
  });

  it("shows each digest day with its items, and the day's asks only when present", () => {
    const html = render();
    const day = html.slice(html.indexOf('<article id="day-2026-11-15">'));
    expect(day).toContain("<h3>2026-11-15 (UTC)</h3>");
    expect(day).toContain('<time>10:00</time> Owner started a Fake agent on &quot;Login&quot;');
    expect(text(sectionHtml(html, "digests"))).not.toContain("Asks");
    const withAsks = render((s) => {
      s.options.includePrompts = true;
      s.digests[0]!.more = 5;
      s.asks = [
        { day: "2026-11-15", time: "10:00", adapterLabel: "Fake agent", cardTitle: "Login", prompt: "Build the login page" },
        { day: "2026-11-15", time: "10:30", adapterLabel: "Fake agent", cardTitle: null, prompt: "Tidy up" },
        { day: "2026-11-14", time: "09:00", adapterLabel: "Fake agent", cardTitle: null, prompt: "Other day" },
      ];
    });
    const digests = text(sectionHtml(withAsks, "digests"));
    expect(digests).toContain("and 5 more");
    expect(digests).toContain("Asks");
    expect(digests).toContain('10:00 · Fake agent on "Login": Build the login page');
    expect(digests).toContain("10:30 · Fake agent: Tidy up");
    expect(digests).not.toContain("Other day");
  });

  it("shows earlier history as a table", () => {
    const html = sectionHtml(render(), "history");
    for (const col of ["Day (UTC)", "Entries", "Agent actions", "Decisions", "Cards moved"]) expect(html).toContain(`<th>${col}</th>`);
    expect(html).toContain("<td>2026-11-01</td>");
  });

  it("states the audit result and how to verify it", () => {
    const html = render();
    const audit = text(sectionHtml(html, "audit"));
    expect(audit).toContain("Ledger intact: 40 entries, head #40 · 9f8e7d6c5b4a");
    expect(audit).toContain(
      "Every #<seq> · <hash> on this page names an entry of the project's append-only ledger; compare them with the audit export (theterminal-ledger-<id>.ndjson) to verify.",
    );
    const broken = text(
      sectionHtml(
        render((s) => {
          s.audit = { ok: false, entries: 12, brokenAtSeq: 13, headSeq: 12, headHash12: "9f8e7d6c5b4a" };
        }),
        "audit",
      ),
    );
    expect(broken).toContain("Ledger chain broken at #13: entries after it are not shown");
  });

  it("renders one line for each section with nothing to show", () => {
    const t = text(
      render((s) => {
        s.summary = null;
        s.idea = null;
        s.waiting = [];
        s.decisions = [];
        s.decisionsOmitted = 0;
        s.workforce = [];
        s.readiness = s.readiness.map((r) => ({ ...r, state: "not_reached", detail: null, cardTitle: null, at: null, evidence: null }));
        s.history = [];
      }),
    );
    for (const line of [
      "No plan has been approved yet.",
      "Nothing is waiting on a human.",
      "No decisions recorded yet.",
      "No agent has run yet.",
      "No readiness gate has been reached yet.",
      "No earlier days.",
    ]) {
      expect(t).toContain(line);
    }
  });

  it("ends with the footer and the nine things not included", () => {
    const html = render();
    const footer = html.slice(html.indexOf("<footer>"));
    expect(text(footer)).toContain(
      "Generated by The Terminal on 2026-11-15 12:00 UTC. Secrets, file contents, raw agent output and anything from other projects are not on this page.",
    );
    expect(footer).toContain("Not included:");
    const items = [...footer.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
    expect(items).toHaveLength(9);
    expect(items).toEqual(HIDDEN_BY_DEFAULT.map(escapeHtml));
  });

  it("renders identical bytes for the same snapshot: no clock in the renderer", () => {
    expect(renderShareHtml(bookClubSnapshot())).toBe(renderShareHtml(bookClubSnapshot()));
    const src = readFileSync(fileURLToPath(new URL("../../src/share/render.ts", import.meta.url)), "utf8");
    for (const banned of ["new Date", "Date.now", "Math.random", "process."]) expect(src).not.toContain(banned);
  });
});

describe("contentHashOf", () => {
  it("is the sha256 of the UTF-8 bytes and changes with one character", () => {
    const html = render();
    expect(contentHashOf(html)).toBe(createHash("sha256").update(Buffer.from(html, "utf8")).digest("hex"));
    expect(contentHashOf(html)).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHashOf(`${html.slice(0, -1)}x`)).not.toBe(contentHashOf(html));
    expect(contentHashOf("·")).toBe(createHash("sha256").update(Buffer.from([0xc2, 0xb7])).digest("hex"));
  });
});
