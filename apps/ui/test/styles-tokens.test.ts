import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

describe("styles.css tokens", () => {
  it("has no colour literals outside :root except the share frame", () => {
    const cleaned = rest.replace(/\.share-frame\s*\{[^}]*\}/g, "");
    expect(cleaned.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? []).toEqual([]);
    expect(rest).toMatch(/\.share-frame\s*\{[^}]*#ffffff/);
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
  it("glows live things and sets output in mono", () => {
    for (const sel of [".activity-bar button.active", ".dot.active", ".runs button.selected"]) {
      const re = new RegExp(`${sel.replace(/[.[\]]/g, "\\$&")}[^{]*\\{[^}]*box-shadow: 0 0 6px var\\(--glow\\)`);
      expect(re.test(css), sel).toBe(true);
    }
    for (const sel of [".status-bar", ".start-run textarea", ".conversation blockquote", ".conversation .agent-says"]) {
      const re = new RegExp(`${sel.replace(/[.[\]]/g, "\\$&")}[^{]*\\{[^}]*var\\(--font-mono\\)`);
      expect(re.test(css), sel).toBe(true);
    }
  });
});
