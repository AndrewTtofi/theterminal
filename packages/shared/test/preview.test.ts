import { describe, expect, it } from "vitest";
import {
  DEVICES,
  DEVICE_IDS,
  eventPayloadSchemas,
  failureSentence,
  narrate,
  PREVIEW_LIMITS,
  viewport,
  type HomeRuns,
  type LedgerEntry,
} from "../src/index.js";

const sha = "a".repeat(64);

describe("devices", () => {
  it("has the four fixed devices", () => {
    expect([...DEVICE_IDS]).toEqual(["iphone16", "pixel9", "ipad", "laptop"]);
    expect(DEVICES.pixel9.scale).toBe(2.625);
    expect(DEVICES.iphone16).toMatchObject({ width: 393, height: 852, scale: 3 });
    expect(DEVICES.laptop.userAgent).toBeNull();
    expect(PREVIEW_LIMITS.maxDevices).toBe(4);
  });
  it("swaps the sides when rotated", () => {
    expect(viewport("iphone16", true)).toEqual({ width: 852, height: 393 });
    expect(viewport("iphone16", false)).toEqual({ width: 393, height: 852 });
  });
});

describe("preview payloads", () => {
  const p = (t: string, v: unknown) => eventPayloadSchemas[t as keyof typeof eventPayloadSchemas]!.safeParse(v).success;
  it("has all eight types", () => {
    for (const t of ["offered", "requested", "started", "progress", "ready", "failed", "stopped", "screenshot"]) {
      expect(eventPayloadSchemas).toHaveProperty(`preview.${t}`);
    }
  });
  it("preview.offered", () => {
    expect(p("preview.offered", { runId: "r", kind: "web", command: "npm run dev", port: 5173 })).toBe(true);
    expect(p("preview.offered", { runId: "r", kind: "web", command: "npm run dev" })).toBe(false);
    expect(p("preview.offered", { runId: "r", kind: "web", command: "npm run dev", port: 70000 })).toBe(false);
    expect(p("preview.offered", { runId: "r", kind: "ios" })).toBe(false);
    expect(p("preview.offered", { runId: "r", kind: "ios", target: "App" })).toBe(true);
  });
  it("preview.ready", () => {
    expect(p("preview.ready", { previewId: "x", origin: "http://localhost:3000" })).toBe(false);
    expect(p("preview.ready", { previewId: "x", origin: "http://10.0.0.2:3000" })).toBe(false);
    expect(p("preview.ready", { previewId: "x", origin: "http://[::1]:5173" })).toBe(true);
    expect(p("preview.ready", { previewId: "x" })).toBe(true);
  });
  it("preview.failed", () => {
    expect(p("preview.failed", { previewId: "x", reason: "exited", tail: Array(20).fill("a") })).toBe(true);
    expect(p("preview.failed", { previewId: "x", reason: "exited", tail: Array(21).fill("a") })).toBe(false);
    expect(p("preview.failed", { previewId: "x", reason: "exited", tail: ["a".repeat(301)] })).toBe(false);
  });
  it("preview.requested", () => {
    const ok = { previewId: "x", runId: "r", kind: "web", commands: [["npm", "run", "dev"]], key: sha, install: false, target: "site" };
    expect(p("preview.requested", ok)).toBe(true);
    expect(p("preview.requested", { ...ok, key: "a".repeat(63) })).toBe(false);
    expect(p("preview.requested", { ...ok, commands: Array(9).fill(["a"]) })).toBe(false);
  });
  it("preview.progress, started, stopped, screenshot", () => {
    expect(p("preview.progress", { previewId: "x", steps: ["a", "b"], done: [1], current: 2 })).toBe(true);
    expect(p("preview.progress", { previewId: "x", steps: ["a"], done: [2], current: null })).toBe(false);
    expect(p("preview.started", { previewId: "x", port: 3000 })).toBe(true);
    expect(p("preview.stopped", { previewId: "x", reason: "idle" })).toBe(true);
    expect(p("preview.stopped", { previewId: "x", reason: "nope" })).toBe(false);
    const shot = { previewId: "x", runId: "r", device: "iphone16", sha256: sha, bytes: 10, width: 393, height: 852 };
    expect(p("preview.screenshot", shot)).toBe(true);
    expect(p("preview.screenshot", { ...shot, bytes: 16_777_217 })).toBe(false);
  });
});

describe("failureSentence", () => {
  it("says what happened", () => {
    expect(failureSentence("timed_out", "web")).toBe("The site did not answer within 3 minutes.");
  });

  it("has a sentence that fits any kind of preview, when the kind is not known", () => {
    expect(failureSentence("timed_out", null)).toBe("The preview did not start within 3 minutes.");
    expect(failureSentence("exited", null)).toBe("The preview stopped by itself.");
    expect(failureSentence("start_failed", null)).toBe("The preview could not be started.");
    expect(failureSentence("build_failed", null)).toBe("The build failed.");
  });
});

describe("narration of preview events", () => {
  const ctx = { cardTitle: () => undefined, adapterName: (id: string) => (id === "r1" ? "claude" : undefined) };
  const entry = (type: string, payload: unknown): LedgerEntry =>
    ({ seq: 1, id: "e1", ts: "2026-11-17T00:00:00.000Z", projectId: "p1", actor: { kind: "human", id: "owner" }, type, payload, prevHash: "", hash: "" }) as unknown as LedgerEntry;
  const say = (type: string, payload: unknown) => narrate(entry(type, payload), ctx);
  it("narrates each line", () => {
    expect(say("preview.offered", { runId: "r1", kind: "web", command: "npm run dev", port: 1 }).headline).toBe("Claude offered a website preview");
    expect(say("preview.offered", { runId: "r1", kind: "ios", target: "A" }).headline).toBe("Claude offered an iPhone app preview");
    expect(say("preview.offered", { runId: "r1", kind: "android", target: "A" }).headline).toBe("Claude offered an Android app preview");
    const req = say("preview.requested", { previewId: "x", runId: "r1", kind: "web", commands: [["npm", "ci"], ["npm", "run", "dev"]], key: sha, install: true, target: "s" });
    expect(req.headline).toBe("Owner confirmed starting the website preview: npm ci");
    expect(req.topic).toBe("preview");
    expect(say("preview.ready", { previewId: "x" }).headline).toBe("The preview is ready");
    expect(say("preview.failed", { previewId: "x", reason: "timed_out", tail: [] }).headline).toBe("The preview did not start within 3 minutes.");
    expect(say("preview.failed", { previewId: "x", reason: "launch_failed", tail: [] }).headline).toBe("The app could not be opened.");
    expect(say("preview.failed", { previewId: "x", reason: "odd", tail: [] }).headline).toBe("The preview failed");
    expect(say("preview.stopped", { previewId: "x", reason: "person" }).headline).toBe("The preview stopped");
    expect(say("preview.stopped", { previewId: "x", reason: "idle" }).headline).toMatch(/\(idle for 30 minutes\)$/);
    expect(say("preview.stopped", { previewId: "x", reason: "restarted" }).headline).toMatch(/\(The Terminal restarted\)$/);
    expect(say("preview.screenshot", { previewId: "x", runId: "r1", device: "iphone16", sha256: sha, bytes: 1, width: 1, height: 1 }).headline).toBe("Owner took a screenshot on iPhone 16");
    expect(say("preview.started", { previewId: "x" }).headline).toBe("Started the preview");
    expect(say("preview.progress", { previewId: "x", steps: ["a", "b", "c"], done: [1, 2], current: 3 }).headline).toBe("Preview: step 2 of 3 done");
  });
});

describe("home types", () => {
  it("HomeRuns without the new fields still type-checks", () => {
    const h: HomeRuns = { working: [], finishedToday: [] };
    expect(h.moveRequests).toBeUndefined();
  });
});
