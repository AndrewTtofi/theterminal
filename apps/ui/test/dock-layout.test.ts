import { afterEach, describe, expect, it } from "vitest";
import { createDockview } from "dockview-react";
import type { DockviewApi, SerializedDockview } from "dockview-react";
import { CONNECTION_CATALOG } from "@theterminal/shared";
import {
  PRESET_LABELS, buildDefault, buildPreset, diffPanelId, filePanelId, parsePanelPath, restoreOrDefault, staleConnectionPanels,
  staleRunPanels,
} from "../src/shell/dock-layout";

const KNOWN = ["board", "agent_feed", "ledger", "conversation", "capacity", "terminal"];
const apis: DockviewApi[] = [];

/** A real dockview instance in jsdom, with plain DOM panels. */
function dock(): DockviewApi {
  const el = document.createElement("div");
  document.body.append(el);
  const api = createDockview(el, {
    createComponent: () => {
      const element = document.createElement("div");
      return { element, init: () => {} };
    },
  });
  api.layout(1000, 800);
  apis.push(api);
  return api;
}

afterEach(() => {
  for (const a of apis.splice(0)) a.dispose();
  document.body.innerHTML = "";
});

/** A valid saved layout: the default one, serialised. */
function savedDefault(): SerializedDockview {
  const api = dock();
  buildDefault(api);
  return JSON.parse(JSON.stringify(api.toJSON())) as SerializedDockview;
}

const ids = (api: DockviewApi) => api.panels.map((p) => p.id).sort();

describe("restoreOrDefault", () => {
  it("restores a valid saved layout", () => {
    const saved = savedDefault();
    saved.panels.conversation!.title = "Conversation";
    const api = dock();
    expect(restoreOrDefault(api, saved, KNOWN)).toBe("restored");
    expect(ids(api)).toEqual(["board", "conversation"]);
  });

  it("builds the default layout when nothing is saved", () => {
    const api = dock();
    expect(restoreOrDefault(api, null, KNOWN)).toBe("default");
    expect(ids(api)).toEqual(["board", "conversation"]);
    expect(api.getPanel("conversation")!.group).toBe(api.getPanel("board")!.group);
    expect(api.getPanel("board")!.group.activePanel?.id).toBe("board");
  });

  it("falls back to the default for corrupt layouts", () => {
    for (const bad of ["{not json", 42, { grid: "nope" }, { panels: {} }, { grid: {}, panels: [] }]) {
      const api = dock();
      expect(restoreOrDefault(api, bad, KNOWN)).toBe("default");
      expect(ids(api)).toEqual(["board", "conversation"]);
    }
  });

  it("falls back when a panel uses a component that is not registered", () => {
    const saved = savedDefault();
    saved.panels["connection:x"] = { ...saved.panels.board!, id: "connection:x", contentComponent: "connection" };
    const api = dock();
    expect(restoreOrDefault(api, saved, KNOWN)).toBe("default");
    expect(api.getPanel("connection:x")).toBeUndefined();
  });

  it("restores a connection panel once its component is registered", () => {
    const api0 = dock();
    buildDefault(api0);
    api0.addPanel({ id: "connection:x", component: "connection", title: "Claude", position: { referencePanel: "board", direction: "within" } });
    const saved = JSON.parse(JSON.stringify(api0.toJSON())) as SerializedDockview;
    const api = dock();
    expect(restoreOrDefault(api, saved, [...KNOWN, "connection"])).toBe("restored");
    expect(api.getPanel("connection:x")).toBeTruthy();
  });

  it("falls back when the layout has no panels", () => {
    const api0 = dock();
    const empty = JSON.parse(JSON.stringify(api0.toJSON())) as SerializedDockview;
    const api = dock();
    expect(restoreOrDefault(api, empty, KNOWN)).toBe("default");
    expect(ids(api)).toEqual(["board", "conversation"]);
  });

  it("falls back when every group with panels is hidden", () => {
    const api0 = dock();
    buildDefault(api0);
    for (const g of api0.groups) g.api.setVisible(false);
    const saved = JSON.parse(JSON.stringify(api0.toJSON())) as SerializedDockview;
    const api = dock();
    expect(restoreOrDefault(api, saved, KNOWN)).toBe("default");
    expect(api.groups.every((g) => g.api.isVisible)).toBe(true);
  });

  it("strips floating and popout groups before restoring", () => {
    const api0 = dock();
    buildDefault(api0);
    api0.addFloatingGroup(api0.getPanel("conversation")!, { position: { top: -200, left: 0 }, width: 400, height: 300 });
    const saved = JSON.parse(JSON.stringify(api0.toJSON())) as SerializedDockview & Record<string, unknown>;
    expect(saved.floatingGroups?.length).toBe(1);
    saved.popoutGroups = [{ data: saved.floatingGroups![0]!.data, position: null, gridReferenceGroup: undefined, url: "https://example.invalid/" }] as never;
    const api = dock();
    restoreOrDefault(api, saved, KNOWN);
    expect(api.groups.some((g) => g.api.location.type !== "grid")).toBe(false);
    expect(api.getPanel("board")).toBeTruthy();
  });
});

describe("staleConnectionPanels", () => {
  it("lists connection tabs whose connection is gone, and new tabs for unknown or unavailable providers", () => {
    const ids = ["board", "ledger", "connection:c1", "connection:gone", "connection:new:github", "connection:new:aws", "connection:new:nope"];
    // Every provider is available since 5B; mark one unavailable to cover that path.
    const catalog = CONNECTION_CATALOG.map((e) => (e.provider === "aws" ? { ...e, available: false } : e));
    expect(staleConnectionPanels(ids, [{ id: "c1" }], catalog)).toEqual([
      "connection:gone",
      "connection:new:aws",
      "connection:new:nope",
    ]);
  });
});

describe("presets", () => {
  it("names the two presets", () => {
    expect(PRESET_LABELS).toEqual({ guided: "Guided", operator: "Operator" });
  });

  it("builds Guided: the Board and the Conversation in the main area, Board active", () => {
    const api = dock();
    buildPreset(api, "guided");
    expect(ids(api)).toEqual(["board", "conversation"]);
    expect(api.groups).toHaveLength(1);
    expect(api.getPanel("board")!.group.activePanel?.id).toBe("board");
  });

  it("builds Operator: Board and Capacity above; Terminal, Agent feed and Ledger below (30 %), Ledger active", () => {
    const api = dock();
    buildPreset(api, "operator");
    expect(ids(api)).toEqual(["agent_feed", "board", "capacity", "ledger", "terminal"]);
    const main = api.getPanel("board")!.group;
    const bottom = api.getPanel("ledger")!.group;
    expect(main).not.toBe(bottom);
    expect(main.panels.map((p) => p.id)).toEqual(["board", "capacity"]);
    expect(bottom.panels.map((p) => p.id)).toEqual(["terminal", "agent_feed", "ledger"]);
    expect(bottom.activePanel?.id).toBe("ledger");
    expect(main.activePanel?.id).toBe("board");
    expect(bottom.api.height).toBe(Math.round(800 * 0.3));
  });
});

describe("run panel ids", () => {
  it("round-trips a diff or file id through parsePanelPath", () => {
    const id = diffPanelId("r1", "src/a b.ts");
    expect(id).toBe("diff:r1:src%2Fa%20b.ts");
    expect(parsePanelPath(id)).toEqual({ runId: "r1", path: "src/a b.ts" });
    expect(parsePanelPath(filePanelId("r2", "dir/x:y.md"))).toEqual({ runId: "r2", path: "dir/x:y.md" });
  });

  it("parses nothing else", () => {
    for (const id of ["board", "story:c1", "connection:c1", "diff:r1", "diff::a", "file:r1:", "diff:r1:%E0%A4%A"]) {
      expect(parsePanelPath(id)).toBeNull();
    }
  });

  it("lists the diff and file tabs of runs that are not known", () => {
    expect(staleRunPanels(["diff:r1:a", "file:r2:b", "board"], ["r1"])).toEqual(["file:r2:b"]);
    expect(staleRunPanels(["diff:broken", "story:r9", "connection:r9"], [])).toEqual(["diff:broken"]);
  });
});
