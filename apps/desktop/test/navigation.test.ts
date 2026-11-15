import { describe, expect, it } from "vitest";
import { appOrigin, externalUrl, isAppUrl } from "../src/navigation.js";

describe("appOrigin", () => {
  it("is the app host on the server's port", () => {
    expect(appOrigin(4317)).toBe("http://theterminal.localhost:4317");
  });
});

describe("isAppUrl", () => {
  it("accepts any path on the app origin", () => {
    expect(isAppUrl("http://theterminal.localhost:4317/x", 4317)).toBe(true);
    expect(isAppUrl("http://theterminal.localhost:4317/?token=abc", 4317)).toBe(true);
  });

  it.each([
    "http://theterminal.localhost:4318/",
    "http://127.0.0.1:4317/",
    "http://theterminal.localhost.evil.test:4317/",
    "https://theterminal.localhost:4317/",
    "not a url",
    "",
  ])("rejects %j", (url) => {
    expect(isAppUrl(url, 4317)).toBe(false);
  });
});

describe("externalUrl", () => {
  it("returns http and https URLs in normalized form", () => {
    expect(externalUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(externalUrl("http://example.com")).toBe("http://example.com/");
  });

  it.each(["file:///etc/hosts", "javascript:alert(1)", "mailto:a@b.c", "not a url", ""])("drops %j", (url) => {
    expect(externalUrl(url)).toBeNull();
  });
});
