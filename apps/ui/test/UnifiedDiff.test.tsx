import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { UnifiedDiff } from "../src/components/UnifiedDiff";
import { NOTES_DIFF } from "./changes-fixtures";


const lines = (c: HTMLElement) => [...c.querySelectorAll("pre.diff > div.line")] as HTMLElement[];
const nums = (line: HTMLElement) => [...line.querySelectorAll("span.ln")].map((s) => s.textContent);

describe("UnifiedDiff", () => {
  it("paints one line per diff line with old and new numbers, and hunk headers", () => {
    const { container } = render(<UnifiedDiff text={NOTES_DIFF} />);
    const all = lines(container);
    const add = all.find((l) => l.classList.contains("add"))!;
    expect(nums(add)).toEqual(["", "2"]);
    expect(add.querySelector("span.text")?.textContent).toBe("+added");
    const del = all.find((l) => l.classList.contains("del"))!;
    expect(nums(del)).toEqual(["2", ""]);
    const context = all.find((l) => l.classList.contains("context"))!;
    expect(nums(context)).toEqual(["1", "1"]);
    expect(all.filter((l) => l.classList.contains("hunk")).map((l) => l.textContent)).toEqual(["@@ -1,2 +1,2 @@"]);
    expect(all.filter((l) => l.classList.contains("meta"))).toHaveLength(4);
  });

  it("shows terminal escapes stripped and other control characters as visible escapes, never as markup", () => {
    const text = "@@ -0,0 +1,2 @@\n+\u001b[31mred\u001b[0m\n+<b>x</b>\u202e\n";
    const { container } = render(<UnifiedDiff text={text} />);
    const texts = lines(container).map((l) => l.querySelector("span.text")?.textContent);
    expect(texts).toContain("+red");
    expect(texts).toContain("+<b>x</b>\\u202e");
    expect(container.querySelector("b")).toBeNull();
  });

  it("paints nothing but an empty block for an empty diff", () => {
    const { container } = render(<UnifiedDiff text="" />);
    expect(container.querySelector("pre.diff")).not.toBeNull();
    expect(lines(container)).toHaveLength(0);
  });

  // Painting 20,000 lines in jsdom takes about a second alone and several when the other packages' suites load the
  // same machine (CI runs them in parallel); the default 5 s has cut it off. The cap is what is tested, not the speed.
  it("paints at most 20,000 lines and says how many there are", { timeout: 30_000 }, () => {
    const text = `@@ -0,0 +1,25000 @@\n${Array.from({ length: 25_000 }, (_, i) => `+line ${i + 1}`).join("\n")}\n`;
    const { container } = render(<UnifiedDiff text={text} />);
    expect(lines(container)).toHaveLength(20_000);
    expect(container.textContent).toContain("Showing the first 20,000 lines of 25,001");
  });

  it("says nothing about a cap when the diff fits", () => {
    const { container } = render(<UnifiedDiff text={NOTES_DIFF} />);
    expect(container.textContent).not.toContain("Showing the first");
  });

  it("tells screen readers what each row is, and keeps the line numbers out of the read text", () => {
    const { container } = render(<UnifiedDiff text={NOTES_DIFF} />);
    const all = lines(container);
    const add = all.find((l) => l.classList.contains("add"))!;
    const del = all.find((l) => l.classList.contains("del"))!;
    const context = all.find((l) => l.classList.contains("context"))!;
    expect(add.querySelector(".visually-hidden")?.textContent).toBe("Added: ");
    expect(del.querySelector(".visually-hidden")?.textContent).toBe("Removed: ");
    expect(context.querySelector(".visually-hidden")).toBeNull();
    for (const ln of container.querySelectorAll("span.ln")) expect(ln.getAttribute("aria-hidden")).toBe("true");
    expect(add.getAttribute("title")).toBe("New line 2");
    expect(del.getAttribute("title")).toBe("Old line 2");
    expect(context.getAttribute("title")).toBe("Old line 1, new line 1");
  });
});
