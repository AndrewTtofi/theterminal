import { describe, expect, it } from "vitest";
import { visibleControls } from "@theterminal/shared";
import { LineReader, parseMarkerLine } from "../../src/agents/markers.js";

const FAKE_KEY = "sk-ant-TESTKEY0123456789abcdef";

describe("parseMarkerLine", () => {
  it("reads a card, its stage, done and noted", () => {
    expect(parseMarkerLine("[[card: Fix the form]]")).toEqual({ kind: "card", title: "Fix the form" });
    expect(parseMarkerLine("[[card-stage: Ship]]")).toEqual({ kind: "card-stage", stage: "ship" });
    expect(parseMarkerLine("[[card-stage: design]]")).toEqual({ kind: "card-stage", stage: "design" });
    expect(parseMarkerLine("[[card-stage: done]]")).toBeNull();
    expect(parseMarkerLine("[[card-done]]")).toEqual({ kind: "card-done" });
    expect(parseMarkerLine("say [[noted]]")).toBeNull();
    expect(parseMarkerLine("  [[noted]] ")).toEqual({ kind: "noted" });
    expect(parseMarkerLine("[[noted]] now")).toBeNull();
  });

  it("delegates plan and step to the progress grammar", () => {
    expect(parseMarkerLine("[[plan: a | b]]")).toEqual({ kind: "plan", steps: ["a", "b"] });
    expect(parseMarkerLine("[[step 1/2 done]]")).toEqual({ kind: "step", n: 1, of: 2, state: "done" });
  });

  it("reads a preview with a port from 1 to 65535, and nothing else", () => {
    expect(parseMarkerLine("[[preview: npm run dev | port 5173]]")).toEqual({ kind: "preview", command: "npm run dev", port: 5173 });
    expect(parseMarkerLine("[[preview: npm run dev | port 65535]]")).toEqual({ kind: "preview", command: "npm run dev", port: 65535 });
    expect(parseMarkerLine("[[preview: npm run dev | port 0]]")).toBeNull();
    expect(parseMarkerLine("[[preview: npm run dev | port 70000]]")).toBeNull();
    expect(parseMarkerLine("[[preview: npm run dev | port 65536]]")).toBeNull();
    expect(parseMarkerLine("[[preview: npm run dev]]")).toBeNull();
    expect(parseMarkerLine("[[preview:  | port 5173]]")).toBeNull();
  });

  it("reads an iOS or Android app, and refuses any other platform or a long target", () => {
    expect(parseMarkerLine("[[app: ios Trips.xcodeproj]]")).toEqual({ kind: "app", platform: "ios", target: "Trips.xcodeproj" });
    expect(parseMarkerLine("[[app: android app]]")).toEqual({ kind: "app", platform: "android", target: "app" });
    expect(parseMarkerLine("[[app: web x]]")).toBeNull();
    expect(parseMarkerLine(`[[app: ios ${"x".repeat(201)}]]`)).toBeNull();
    expect(parseMarkerLine(`[[app: ios ${"x".repeat(200)}]]`)).toEqual({ kind: "app", platform: "ios", target: "x".repeat(200) });
  });

  it("cleans a card title: trimmed, controls escaped, secrets redacted, at most 200 characters", () => {
    expect(parseMarkerLine("[[card:   ]]")).toBeNull();
    const m = parseMarkerLine(`[[card: Fix \u202e ${FAKE_KEY} ${"y".repeat(300)} ]]`);
    expect(m?.kind).toBe("card");
    const title = (m as { title: string }).title;
    expect(title).not.toContain("\u202e");
    expect(title).toContain(visibleControls("\u202e"));
    expect(title).not.toContain("TESTKEY");
    expect(title.length).toBeLessThanOrEqual(200);
    expect(title.startsWith("Fix ")).toBe(true);
  });
});

describe("LineReader", () => {
  it("joins a marker split across two chunks and returns it once", () => {
    const r = new LineReader();
    expect(r.feed("[[card: Fi")).toEqual([]);
    expect(r.feed("x]]\nrest")).toEqual(["[[card: Fix]]"]);
    expect(r.feed("\n")).toEqual([""]);
  });

  it("drops an unfinished line longer than 400 characters", () => {
    const r = new LineReader();
    const long = `[[card: ${"x".repeat(393)}`;
    expect(long.length).toBe(401);
    expect(r.feed(long)).toEqual([]);
    expect(r.feed("]]\n").map(parseMarkerLine)).toEqual([null]);
  });

  it("keeps a 400-character unfinished line", () => {
    const r = new LineReader();
    const title = "x".repeat(392);
    expect(r.feed(`[[card: ${title}`)).toEqual([]);
    expect(r.feed("]]\n")).toEqual([`[[card: ${title}]]`]);
  });

  it("returns a last line that is a whole marker at once", () => {
    const r = new LineReader();
    expect(r.feed("[[noted]]")).toEqual(["[[noted]]"]);
    expect(r.feed("[[card-done]]")).toEqual(["[[card-done]]"]);
  });

  it("keeps an unfinished line only while it could still start a marker", () => {
    const r = new LineReader();
    expect(r.feed("Let me look")).toEqual([]);
    expect(r.feed("[[noted]]\n")).toEqual(["[[noted]]"]);
    expect(r.feed("[[prev")).toEqual([]);
    expect(r.feed("iew: npm run dev | port 5173]]\n")).toEqual(["[[preview: npm run dev | port 5173]]"]);
    expect(r.feed("[[app: ios Tr")).toEqual([]);
    expect(r.feed("ips]]\n")).toEqual(["[[app: ios Trips]]"]);
    expect(r.feed("[[card-sta")).toEqual([]);
    expect(r.feed("ge: build]]\n")).toEqual(["[[card-stage: build]]"]);
  });

  it("returns every whole line, markers or not", () => {
    const r = new LineReader();
    expect(r.feed("hello\n[[noted]]\nbye\n")).toEqual(["hello", "[[noted]]", "bye"]);
  });
});
