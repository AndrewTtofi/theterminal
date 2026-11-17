import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_THEMES, THEME_KEYS } from "@theterminal/shared";
import { describe, expect, it } from "vitest";
import { applyTheme } from "../src/theme/apply";

const css = readFileSync(join(__dirname, "..", "src", "styles.css"), "utf8");
const rootMatch = /:root\s*\{([^}]*)\}/.exec(css);
const rootBlock = rootMatch?.[1] ?? "";
const rest = css.replace(/:root\s*\{[^}]*\}/, "");

const ICE: Record<string, string> = {
  bg: "#0d1016", fg: "#cdd3df", "fg-strong": "#e8ecf3", muted: "#8a93a6", line: "#1f2533", "line-strong": "#2b3344", panel: "#121620",
  input: "#1a1f2b", activity: "#090b10", "activity-fg": "#6f7a8f", "activity-active": "#e8ecf3",
  accent: "#4fc3d9", "accent-hover": "#6fd0e2", "on-accent": "#041217", focus: "#4fc3d9", hover: "#171c27", selected: "#1d2433", glow: "#4fc3d966",
  status: "#12303a", "status-fg": "#d7f3f9", "status-hover": "#ffffff1f", badge: "#4fc3d9", "badge-fg": "#041217",
  attention: "#e3a33b", "on-attention": "#1a1000", danger: "#e5534b", "danger-hover": "#f06b63", ok: "#3fb97f", override: "#ff5c5c", idle: "#5c6578", running: "#4fc3d9",
  "error-bg": "#3a1519", "error-fg": "#f5c6cb", "warning-bg": "#33290f", "warning-fg": "#f1deb0", "warning-line": "#7a6320",
  "diff-add": "#3fb97f26", "diff-del": "#e5534b26", "diff-hunk": "#4fc3d914",
};

/** Colour literals (hex or rgb/rgba) found in a stylesheet's text; `:root` is exempt only for styles.css. */
export function checkCss(text: string): string[] {
  return text.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [];
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? cssFiles(join(dir, d.name)) : d.name.endsWith(".css") ? [join(dir, d.name)] : []);
}

describe("every stylesheet", () => {
  it("flags a colour literal", () => {
    expect(checkCss(".x { color: #fff; }")).toEqual(["#fff"]);
    expect(checkCss(".x { color: rgba(0,0,0,.5); }")).toEqual(["rgba("]);
    expect(checkCss(".x { color: var(--fg); }")).toEqual([]);
  });
  it("has no colour literals in any src css except styles.css's :root", () => {
    const files = cssFiles(join(__dirname, "..", "src"));
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const body = f === join(__dirname, "..", "src", "styles.css") ? text.replace(/:root\s*\{[^}]*\}/, "") : text;
      expect(checkCss(body), f).toEqual([]);
    }
  });
});

describe("styles.css tokens", () => {
  it("has no colour literals outside :root", () => {
    expect(checkCss(rest)).toEqual([]);
    expect(rest).toMatch(/\.share-frame\s*\{[^}]*background: var\(--bg\)/);
  });
  it("defines every key in Ice's values", () => {
    for (const [k, v] of Object.entries(ICE)) {
      const m = new RegExp(`--${k}:\\s*([^;]+);`).exec(rootBlock);
      expect(m?.[1]?.trim().toLowerCase(), `--${k}`).toBe(v);
    }
  });
  it("puts on-attention text on every attention background", () => {
    const rule = (sel: string) => new RegExp(`${sel.replace(/[.[\]"()]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    for (const sel of [".status-item.attention", ".status-item .attention", '.layout-item .layout-save [role="alert"]']) {
      expect(rule(sel), sel).toMatch(/background: var\(--attention\)/);
      expect(rule(sel), sel).toMatch(/color: var\(--on-attention\)/);
    }
  });
  it("uses font properties", () => {
    expect(rootBlock).toMatch(/--font-ui:\s*system-ui/);
    expect(rootBlock).toMatch(/--font-mono:\s*ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace/);
    expect(/\nbody\s*\{[^}]*var\(--font-ui\)/.test(css)).toBe(true);
  });

  it("stops the cursor blinking under reduced motion", () => {
    expect(/\.cursor\s*\{[^}]*animation:[^;}]*1\.1s steps\(1\)/.test(css)).toBe(true);
    expect(/@media \(prefers-reduced-motion: reduce\)\s*\{[^{}]*\.cursor\s*\{[^}]*animation:\s*none/.test(css)).toBe(true);
  });
  it("does not glow live things, and sets output in mono", () => {
    for (const sel of [".activity-bar button.active", ".dot.active", ".runs button.selected"]) {
      const re = new RegExp(`${sel.replace(/[.[\]]/g, "\\$&")}[^{]*\\{[^}]*box-shadow:[^;}]*var\\(--glow\\)`);
      expect(re.test(css), sel).toBe(false);
    }
    for (const sel of [".status-bar", ".start-run textarea", ".conversation blockquote", ".conversation .agent-says"]) {
      const re = new RegExp(`${sel.replace(/[.[\]]/g, "\\$&")}[^{]*\\{[^}]*var\\(--font-mono\\)`);
      expect(re.test(css), sel).toBe(true);
    }
  });
});

const decls = (text: string, prop: string): string[] =>
  [...text.matchAll(new RegExp(`(?<![-\\w])${prop}\\s*:\\s*([^;}]+)`, "g"))].map((m) => `${prop}:${m[1]!.trim()}`);
const valueOf = (d: string): string => d.slice(d.indexOf(":") + 1);

/** `border-radius` declarations holding a px number (only var(--radius-…), 0 and 50% pass). */
export function checkRadii(text: string): string[] {
  return decls(text, "border-radius").filter((d) => /\d+(\.\d+)?px/.test(valueOf(d)));
}
/** Spacing declarations with a px number that is not a multiple of 4. */
export function checkGrid(text: string): string[] {
  return ["padding", "margin", "gap", "row-gap", "column-gap"].flatMap((p) => decls(text, p)).filter((d) =>
    [...valueOf(d).matchAll(/(-?\d+(?:\.\d+)?)px/g)].some((m) => Number(m[1]) % 4 !== 0));
}
/** `font-size` that is not var(--text-…), inherit or an em value, outside the selectors in `allow`. */
export function checkFontSizes(text: string, allow: string[]): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1]!.split(",").map((x) => x.trim());
    if (sels.some((x) => allow.includes(x))) continue;
    for (const d of decls(m[2]!, "font-size")) {
      const v = valueOf(d).trim();
      if (!(/^var\(--text-/.test(v) || v === "inherit" || /^[\d.]+em$/.test(v))) out.push(d);
    }
  }
  return out;
}
/** `box-shadow` other than none or `0 0 0 1px var(--…)`. */
export function checkShadows(text: string): string[] {
  return decls(text, "box-shadow").filter((d) => !/^(none|0 0 0 1px var\(--[\w-]+\))$/.test(valueOf(d)));
}
/** `transition` or `animation` durations that are not var(--motion-…), except .cursor's blink. */
export function checkTransitions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(",").some((x) => x.trim() === ".cursor")) continue;
    for (const p of ["transition", "animation"]) {
      for (const d of decls(m[2]!, p)) {
        const v = valueOf(d);
        if (/\b\d*\.?\d+m?s\b/.test(v)) out.push(d);
      }
    }
  }
  return out;
}

describe("shape checkers", () => {
  it("flags a px radius only", () => {
    expect(checkRadii(".a{border-radius:2px}")).toEqual(["border-radius:2px"]);
    expect(checkRadii(".a{border-radius:var(--radius-m)}")).toEqual([]);
    expect(checkRadii(".a{border-radius:0}.b{border-radius:50%}")).toEqual([]);
  });
  it("flags spacing off the 4px grid", () => {
    expect(checkGrid(".a{padding:6px 8px}")).toEqual(["padding:6px 8px"]);
    expect(checkGrid(".a{margin:0 4px 8px}")).toEqual([]);
  });
  it("flags font sizes outside the tokens", () => {
    expect(checkFontSizes(".a{font-size:14px}", ["h1"])).toEqual(["font-size:14px"]);
    expect(checkFontSizes("h1{font-size:18px}", ["h1"])).toEqual([]);
    expect(checkFontSizes(".a{font-size:var(--text-m)}.b{font-size:inherit}.c{font-size:1.2em}", [])).toEqual([]);
  });
  it("flags shadows other than a 1px ring", () => {
    expect(checkShadows(".a{box-shadow:0 0 6px var(--glow)}")).toEqual(["box-shadow:0 0 6px var(--glow)"]);
    expect(checkShadows(".a{box-shadow:0 0 0 1px var(--accent)}.b{box-shadow:none}")).toEqual([]);
  });
  it("flags transitions outside the motion tokens", () => {
    expect(checkTransitions(".a{transition:width 200ms linear}")).toEqual(["transition:width 200ms linear"]);
    expect(checkTransitions(".a{transition:width var(--motion-progress) linear}")).toEqual([]);
    expect(checkTransitions(".cursor{animation:cursor-blink 1.1s steps(1) infinite}")).toEqual([]);
  });
});

describe("shape tokens", () => {
  const blocks = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]!);
  const shape = blocks.find((b) => /--radius-m:/.test(b)) ?? "";
  const tok = (k: string, from = shape) => new RegExp(`--${k}:\\s*([^;]+);`).exec(from)?.[1]?.trim();
  it("keeps the colours in the first :root block and the shape in a block of its own", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(rootBlock).not.toMatch(/--radius-/);
    expect(shape).not.toMatch(/--bg:/);
  });
  it("defines exactly the ruled values", () => {
    const want: Record<string, string> = {
      "radius-s": "4px", "radius-m": "8px", "radius-l": "10px", "radius-pill": "999px",
      "space-1": "4px", "space-2": "8px", "space-3": "12px", "space-4": "16px", "space-5": "24px", "space-6": "32px",
      "text-s": "11px", "text-m": "12px", "text-l": "13px", "motion-fast": "80ms", "motion-progress": "200ms",
    };
    for (const [k, v] of Object.entries(want)) expect(tok(k), `--${k}`).toBe(v);
  });
  it("zeroes the motion tokens under reduced motion", () => {
    const m = /@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css);
    expect(m?.[1]).toBeDefined();
    expect(tok("motion-fast", m![1]!)).toBe("0ms");
    expect(tok("motion-progress", m![1]!)).toBe("0ms");
  });
  it("uses them in the base rules", () => {
    const rule = (sel: string) => new RegExp(`(?:^|\\n)${sel.replace(/[.[\]"():]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    expect(rule("input, select, textarea")).toMatch(/border-radius: var\(--radius-m\)/);
    expect(rule("button")).toMatch(/border-radius: var\(--radius-pill\)/);
    expect(rule("button")).toMatch(/font-size: var\(--text-m\)/);
    expect(rule("fieldset")).toMatch(/border-radius: var\(--radius-m\)/);
    expect(rule(":focus-visible")).toMatch(/outline: 2px solid var\(--focus\)/);
    expect(rule(".num")).toMatch(/font-family: var\(--font-mono\)/);
    expect(rule(".num")).toMatch(/font-variant-numeric: tabular-nums/);
  });
  it("is never set by a theme", () => {
    for (const k of THEME_KEYS) expect(k).not.toMatch(/^(radius|space|text|motion)/);
    const root = document.documentElement;
    root.removeAttribute("style");
    for (const t of BUILTIN_THEMES) {
      applyTheme(t);
      for (const p of ["radius-m", "space-2", "text-m", "motion-fast"]) expect(root.style.getPropertyValue(`--${p}`), `${t.id} ${p}`).toBe("");
    }
  });
  it("has no px radius and no glow or heavy shadow in styles.css", () => {
    expect(checkRadii(css)).toEqual([]);
    expect(checkShadows(css)).toEqual([]);
  });
});

describe("the approved style across every stylesheet", () => {
  const files = cssFiles(join(__dirname, "..", "src"));
  it("keeps radii, grid, type sizes, shadows and motion on the tokens in every src css", () => {
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(checkRadii(text), `${f} radii`).toEqual([]);
      expect(checkGrid(text), `${f} grid`).toEqual([]);
      expect(checkFontSizes(text, ["h1", ".wordmark"]), `${f} font sizes`).toEqual([]);
      expect(checkShadows(text), `${f} shadows`).toEqual([]);
      expect(checkTransitions(text), `${f} transitions`).toEqual([]);
    }
  });
  const rule = (sel: string) => new RegExp(`(?:^|\\n|\\})\\s*${sel.replace(/[.[\]"():]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  it("floats the shell's panels with gaps between them", () => {
    expect(rule(".workbench-body")).toMatch(/gap: var\(--space-2\)/);
    expect(rule(".workbench-body")).toMatch(/padding: var\(--space-2\)/);
    expect(rule(".workbench-body")).toMatch(/background: var\(--activity\)/);
    for (const sel of [".activity-bar", ".side-bar", ".main-column"]) {
      expect(rule(sel), sel).toMatch(/border-radius: var\(--radius-l\)/);
      expect(rule(sel), sel).toMatch(/border: 1px solid var\(--line\)/);
      expect(rule(sel), sel).toMatch(/overflow: hidden/);
    }
  });
  it("rounds dialogs and the active tab", () => {
    const sources = readFileSync(join(__dirname, "..", "src", "components", "sources.css"), "utf8");
    expect(/(?:^|\n|\})\s*\.modal\s*\{[^}]*border-radius: var\(--radius-l\)/.test(sources)).toBe(true);
    expect(/\.dv-tab\.dv-active-tab[^{]*\{[^}]*border-radius: var\(--radius-m\) var\(--radius-m\) 0 0/.test(css)).toBe(true);
  });
});
