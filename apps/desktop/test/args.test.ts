import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DesktopArgsError, parseDesktopArgs } from "../src/args.js";

const abs = join(tmpdir(), "tt-data");
const absR = join(tmpdir(), "tt-ready.json");

describe("parseDesktopArgs", () => {
  it("reads the four app flags and ignores switches Chromium or Playwright add", () => {
    expect(
      parseDesktopArgs([
        "--data-dir", abs, "--port", "0", "--headless", "--ready-file", absR,
        "--remote-debugging-port=0", "--inspect=0",
      ]),
    ).toEqual({ dataDir: abs, port: 0, headless: true, readyFile: absR });
  });

  it("defaults to a window with no overrides", () => {
    expect(parseDesktopArgs([])).toEqual({ headless: false });
  });

  it("ignores positionals", () => {
    expect(parseDesktopArgs(["."])).toEqual({ headless: false });
  });

  it("accepts the --flag=value form", () => {
    expect(parseDesktopArgs([`--data-dir=${abs}`, "--port=4317"])).toEqual({ dataDir: abs, port: 4317, headless: false });
  });

  it("rejects a relative --data-dir", () => {
    expect(() => parseDesktopArgs(["--data-dir", "data"])).toThrow(new DesktopArgsError("--data-dir must be an absolute path"));
  });

  it("rejects a --data-dir without a value", () => {
    expect(() => parseDesktopArgs(["--data-dir"])).toThrow(DesktopArgsError);
  });

  it("rejects a relative --ready-file", () => {
    expect(() => parseDesktopArgs(["--ready-file", "ready.json"])).toThrow(
      new DesktopArgsError("--ready-file must be an absolute path"),
    );
  });

  it.each(["abc", "70000", "-1", "1.5", ""])("rejects --port %j", (port) => {
    expect(() => parseDesktopArgs(["--port", port])).toThrow(
      new DesktopArgsError("--port must be an integer from 0 to 65535"),
    );
  });

  it("accepts the port bounds", () => {
    expect(parseDesktopArgs(["--port", "65535"]).port).toBe(65535);
    expect(parseDesktopArgs(["--port=0"]).port).toBe(0);
  });

  it("is a named Error subclass", () => {
    const err = new DesktopArgsError("x");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DesktopArgsError");
  });
});
