import { afterEach, describe, expect, it } from "vitest";
import { createDockview } from "dockview-react";
import type { DockviewApi, SerializedDockview } from "dockview-react";
import { CONNECTION_CATALOG } from "@theterminal/shared";
import { buildDefault, restoreOrDefault, staleConnectionPanels } from "../src/shell/dock-layout";

const KNOWN = ["board", "agent_feed", "ledger"];
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
    saved.panels.ledger!.title = "Ledger";
    const api = dock();
    expect(restoreOrDefault(api, saved, KNOWN)).toBe("restored");
    expect(ids(api)).toEqual(["agent_feed", "board", "ledger"]);
  });

  it("builds the default layout when nothing is saved", () => {
    const api = dock();
    expect(restoreOrDefault(api, null, KNOWN)).toBe("default");
    expect(ids(api)).toEqual(["agent_feed", "board", "ledger"]);
    expect(api.getPanel("ledger")!.group).toBe(api.getPanel("agent_feed")!.group);
    expect(api.getPanel("board")!.group).not.toBe(api.getPanel("ledger")!.group);
  });

  it("falls back to the default for corrupt layouts", () => {
    for (const bad of ["{not json", 42, { grid: "nope" }, { panels: {} }, { grid: {}, panels: [] }]) {
      const api = dock();
      expect(restoreOrDefault(api, bad, KNOWN)).toBe("default");
      expect(ids(api)).toEqual(["agent_feed", "board", "ledger"]);
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
    expect(ids(api)).toEqual(["agent_feed", "board", "ledger"]);
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
    api0.addFloatingGroup(api0.getPanel("ledger")!, { position: { top: -200, left: 0 }, width: 400, height: 300 });
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
    expect(staleConnectionPanels(ids, [{ id: "c1" }], CONNECTION_CATALOG)).toEqual([
      "connection:gone",
      "connection:new:aws",
      "connection:new:nope",
    ]);
  });
});
