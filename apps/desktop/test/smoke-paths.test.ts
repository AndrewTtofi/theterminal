import { describe, expect, it } from "vitest";
import { resourcesDir } from "../smoke/paths.js";

describe("resourcesDir", () => {
  it("is Contents/Resources next to the macOS executable", () => {
    expect(resourcesDir("/Applications/The Terminal.app/Contents/MacOS/The Terminal", "darwin")).toBe(
      "/Applications/The Terminal.app/Contents/Resources",
    );
  });

  it("is the resources folder beside the Windows executable", () => {
    expect(resourcesDir("C:\\Programs\\The Terminal\\The Terminal.exe", "win32")).toBe("C:\\Programs\\The Terminal\\resources");
  });

  it("refuses a platform the app is not built for", () => {
    expect(() => resourcesDir("/opt/the-terminal/the-terminal", "linux")).toThrow("Unsupported platform: linux");
  });
});
