import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { visibleControls } from "@theterminal/shared";
import { basename, stripAnsi } from "../src/components/text";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

describe("stripAnsi", () => {
  it("removes colour (CSI) sequences", () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red");
    expect(stripAnsi(`a${ESC}[1;32;40mb${ESC}[2Kc${ESC}[?25hd`)).toBe("abcd");
  });

  it("removes OSC sequences ended by BEL or ST", () => {
    expect(stripAnsi(`${ESC}]0;window title${BEL}after`)).toBe("after");
    expect(stripAnsi(`before${ESC}]8;;https://example.invalid/${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe("beforelink");
  });

  it("handles an unterminated CSI with 100,000 parameter digits in linear time", () => {
    const input = `${ESC}[${"1".repeat(100_000)}`;
    const started = performance.now();
    expect(stripAnsi(input)).toBe(input);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("leaves plain text alone", () => {
    expect(stripAnsi("plain [31m text")).toBe("plain [31m text");
  });
});

describe("basename", () => {
  it("is the last path segment", () => {
    expect(basename("src/a b.ts")).toBe("a b.ts");
    expect(basename("README.md")).toBe("README.md");
    expect(basename("src/dir/")).toBe("dir");
  });
});

describe("visibleControls (shared)", () => {
  it("shows a bidi override as its escape", () => {
    expect(visibleControls(String.fromCharCode(0x202e))).toBe("\\u202e");
    render(<p>{visibleControls(String.fromCharCode(0x202e))}</p>);
    expect(screen.getByText("\\u202e")).toBeTruthy();
  });
});
