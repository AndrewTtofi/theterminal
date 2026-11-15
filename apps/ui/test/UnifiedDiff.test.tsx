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
});
