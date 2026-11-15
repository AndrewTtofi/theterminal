import { describe, expect, it } from "vitest";
import {
  ACTION_KINDS,
  ACTION_TOPIC,
  GATE_IDS,
  GATE_TOPIC,
  LEARN_SECTION_LABELS,
  LEARN_SECTIONS,
  LEARN_TOPICS,
  matchesContext,
  STAGES,
  topicsFor,
} from "../src/index.js";

const ids = LEARN_TOPICS.map((t) => t.id);
const byId = (id: string) => LEARN_TOPICS.find((t) => t.id === id)!;

describe("LEARN_TOPICS", () => {
  it("has the exact ids, in catalog order, each in its section", () => {
    expect(LEARN_TOPICS.map((t) => [t.section, t.id])).toEqual([
      ["lifecycle", "stage_plan"],
      ["lifecycle", "stage_design"],
      ["lifecycle", "stage_build"],
      ["lifecycle", "stage_ship"],
      ["lifecycle", "stage_operate"],
      ["agents", "agent_runs"],
      ["agents", "worktrees"],
      ["agents", "approvals"],
      ["agents", "action_kinds"],
      ["agents", "asking_for_changes"],
      ["deciding", "readiness_gates"],
      ["deciding", "waivers"],
      ["deciding", "hash_chain"],
      ["deciding", "audit_export"],
      ["code", "reading_a_diff"],
      ["code", "tracked_and_untracked"],
      ["code", "read_only_by_design"],
      ["code", "emergency_override"],
      ["connections", "api_keys_and_keychain"],
      ["connections", "estimates"],
      ["connections", "cloud_session_tokens"],
      ["connections", "mcp_servers"],
      ["connections", "subscriptions_and_api_keys"],
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("labels every section", () => {
    expect(LEARN_SECTIONS).toEqual(["lifecycle", "agents", "deciding", "code", "connections"]);
    expect(LEARN_SECTION_LABELS).toEqual({
      lifecycle: "The lifecycle",
      agents: "Working with agents",
      deciding: "Deciding and gates",
      code: "Your code and changes",
      connections: "Connections and capacity",
    });
  });

  it("refers only to known stages, action kinds and gates", () => {
    for (const t of LEARN_TOPICS) {
      for (const s of t.appliesTo.stages ?? []) expect(STAGES, t.id).toContain(s);
      for (const k of t.appliesTo.actionKinds ?? []) expect(ACTION_KINDS, t.id).toContain(k);
      for (const g of t.appliesTo.gateIds ?? []) expect(GATE_IDS, t.id).toContain(g);
    }
  });

  it("covers every stage, every action kind and every gate", () => {
    const stages = new Set(LEARN_TOPICS.flatMap((t) => t.appliesTo.stages ?? []));
    const kinds = new Set(LEARN_TOPICS.flatMap((t) => t.appliesTo.actionKinds ?? []));
    const gates = new Set(LEARN_TOPICS.flatMap((t) => t.appliesTo.gateIds ?? []));
    expect(STAGES.filter((s) => !stages.has(s))).toEqual([]);
    expect(ACTION_KINDS.filter((k) => !kinds.has(k))).toEqual([]);
    expect(GATE_IDS.filter((g) => !gates.has(g))).toEqual([]);
  });

  it("sets the stage, kind, gate and view references of the catalog", () => {
    STAGES.forEach((s) => expect(byId(`stage_${s}`).appliesTo.stages).toEqual([s]));
    expect(byId("action_kinds").appliesTo.actionKinds).toEqual([...ACTION_KINDS]);
    expect(byId("readiness_gates").appliesTo.gateIds).toEqual(GATE_IDS.filter((g) => g !== "over_budget"));
    expect(byId("estimates").appliesTo.gateIds).toEqual(["over_budget"]);
    expect(byId("asking_for_changes").appliesTo.views).toEqual(["agents", "board"]);
    expect(byId("agent_runs").appliesTo.views).toEqual(["agents", "board"]);
    expect(byId("hash_chain").appliesTo.views).toEqual(["needs_you", "ledger"]);
    expect(byId("emergency_override").appliesTo.views).toEqual(["changes"]);
    expect(byId("mcp_servers").appliesTo.views).toEqual(["connections", "capacity", "github"]);
    for (const t of LEARN_TOPICS) expect(t.appliesTo.views ?? [], t.id).not.toContain("conversation");
  });

  it("writes every body in 120 to 1,200 characters of plain text", () => {
    for (const t of LEARN_TOPICS) {
      expect(t.body.length, t.id).toBeGreaterThanOrEqual(120);
      expect(t.body.length, t.id).toBeLessThanOrEqual(1200);
      expect(t.title.length, t.id).toBeGreaterThan(0);
      expect(t.body, t.id).not.toMatch(/[<>*`#]/);
    }
  });

  it("describes the override honestly", () => {
    const body = byId("emergency_override").body;
    expect(body).toContain("outside the agent gate");
    expect(body).toContain("can change files");
    expect(body).toContain("not through a shell");
    expect(body).toContain("keys in its environment");
    expect(body).not.toMatch(/no shell|without a shell|no credentials|safe/i);
  });
});

describe("topicsFor", () => {
  it("puts the matching topics first", () => {
    expect(topicsFor({ view: "changes" }).matched[0].id).toBe("reading_a_diff");
    expect(topicsFor({ gateId: "over_budget" }).matched[0].id).toBe("estimates");
    expect(topicsFor({ gateId: "payments" }).matched.map((t) => t.id)).toEqual(["readiness_gates"]);
    expect(topicsFor({ stage: "ship" }).matched.map((t) => t.id)).toEqual(["stage_ship"]);
    expect(topicsFor({ actionKind: "shell" }).matched.map((t) => t.id)).toEqual(["action_kinds"]);
  });

  it("matches any field of the context and keeps catalog order in both lists", () => {
    const { matched, rest } = topicsFor({ view: "changes", stage: "plan" });
    expect(matched.map((t) => t.id)).toEqual(["stage_plan", "reading_a_diff", "tracked_and_untracked", "read_only_by_design", "emergency_override"]);
    expect([...matched, ...rest].map((t) => t.id).sort()).toEqual([...ids].sort());
    expect(rest.map((t) => t.id)).toEqual(ids.filter((id) => !matched.some((m) => m.id === id)));
  });

  it("returns the whole catalog in order when nothing is known", () => {
    expect(topicsFor({})).toEqual({ matched: [], rest: [...LEARN_TOPICS] });
    expect(topicsFor({ view: "nowhere" }).matched).toEqual([]);
  });

  it("matches a topic against a context", () => {
    expect(matchesContext(byId("estimates"), { gateId: "over_budget" })).toBe(true);
    expect(matchesContext(byId("estimates"), { gateId: "payments" })).toBe(false);
    expect(matchesContext(byId("estimates"), {})).toBe(false);
  });
});

describe("ACTION_TOPIC and GATE_TOPIC", () => {
  it("points every kind and gate at a topic", () => {
    for (const k of ACTION_KINDS) expect(ACTION_TOPIC[k]).toBe("action_kinds");
    for (const g of GATE_IDS) expect(GATE_TOPIC[g]).toBe(g === "over_budget" ? "estimates" : "readiness_gates");
    for (const id of [...Object.values(ACTION_TOPIC), ...Object.values(GATE_TOPIC)]) expect(ids).toContain(id);
  });
});
