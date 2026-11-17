import { afterEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_KEY, loadPreviewPrefs, normalizeDevices, savePreviewPrefs, toggleDevice } from "../src/preview/preview-store";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("preview prefs", () => {
  it("defaults to iPhone 16, iPad and Laptop, unrotated", () => {
    expect(PREVIEW_KEY).toBe("tt.preview.v1");
    expect(loadPreviewPrefs()).toEqual({ devices: ["iphone16", "ipad", "laptop"], rotated: [] });
  });

  it("gives the default for corrupt JSON and for a throwing localStorage", () => {
    localStorage.setItem("tt.preview.v1", "{not json");
    expect(loadPreviewPrefs()).toEqual({ devices: ["iphone16", "ipad", "laptop"], rotated: [] });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadPreviewPrefs()).toEqual({ devices: ["iphone16", "ipad", "laptop"], rotated: [] });
  });

  it("drops unknown and repeated ids, keeps at most four and is never empty", () => {
    expect(normalizeDevices(["laptop", "x", "ipad", "ipad", "pixel9", "iphone16", "laptop"])).toEqual(["iphone16", "pixel9", "ipad", "laptop"]);
    expect(normalizeDevices(["x", 3, null])).toEqual(["iphone16", "ipad", "laptop"]);
    expect(normalizeDevices("laptop")).toEqual(["iphone16", "ipad", "laptop"]);
  });

  it("saves and reads back, keeping rotated only for picked devices", () => {
    savePreviewPrefs({ devices: ["pixel9", "laptop"], rotated: ["laptop", "ipad"] });
    expect(loadPreviewPrefs()).toEqual({ devices: ["pixel9", "laptop"], rotated: ["laptop"] });
  });

  it("does not throw when saving fails", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(() => savePreviewPrefs({ devices: ["ipad"], rotated: [] })).not.toThrow();
  });

  it("toggles a device, never removing the last one", () => {
    expect(toggleDevice({ devices: ["ipad"], rotated: [] }, "laptop")).toEqual({ devices: ["ipad", "laptop"], rotated: [] });
    expect(toggleDevice({ devices: ["ipad", "laptop"], rotated: ["ipad"] }, "ipad")).toEqual({ devices: ["laptop"], rotated: [] });
    expect(toggleDevice({ devices: ["ipad"], rotated: [] }, "ipad")).toEqual({ devices: ["ipad"], rotated: [] });
  });
});
