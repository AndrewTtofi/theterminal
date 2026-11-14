import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eventPayloadSchemas, type EventType } from "../src/index.js";

/**
 * Payloads as the zod 3 schemas wrote them to the ledger (canonical JSON, sorted keys), including the older
 * shapes still on disk, such as `agent.finished` without token totals. The ledger is append-only: every one
 * must keep parsing, and parse to exactly itself, so a payload written again hashes the same.
 */
// Checked when added: each sample parsed, unchanged, with the zod 3 schemas of the base commit compiled against `zod/v3`.
const samples = JSON.parse(readFileSync(new URL("./fixtures/ledger-payloads-legacy.json", import.meta.url), "utf8")) as {
  type: EventType;
  payload: unknown;
}[];

describe("ledger payloads written by zod 3", () => {
  it("has a saved sample of every event type", () => {
    const covered = new Set(samples.map((s) => s.type));
    expect(Object.keys(eventPayloadSchemas).filter((t) => !covered.has(t as EventType))).toEqual([]);
  });

  it.each(samples.map((s, i) => [`${i}: ${s.type}`, s] as const))("parses %s unchanged", (_label, sample) => {
    const schema = eventPayloadSchemas[sample.type];
    expect(schema, `no schema for ${sample.type}`).toBeDefined();
    const result = schema.safeParse(sample.payload);
    expect(result.error?.issues).toBeUndefined();
    expect(result.data).toEqual(sample.payload);
  });

  it.each(samples.map((s, i) => [`${i}: ${s.type}`, s] as const))("refuses %s with an extra key", (_label, sample) => {
    const payload = { ...(sample.payload as Record<string, unknown>), extra: 1 };
    expect(eventPayloadSchemas[sample.type].safeParse(payload).success).toBe(false);
  });
});
