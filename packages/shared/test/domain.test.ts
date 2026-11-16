import { describe, expect, it } from "vitest";
import {
  STAGES,
  GENESIS_HASH,
  actorSchema,
  cardInputSchema,
  eventPayloadSchemas,
  projectInputSchema,
} from "../src/index.js";

describe("STAGES", () => {
  it("lists the five stages in order", () => {
    expect(STAGES).toEqual(["plan", "design", "build", "ship", "operate"]);
  });
});

describe("GENESIS_HASH", () => {
  it("is 64 zero characters", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
  });
});

describe("actorSchema", () => {
  it("accepts a human owner actor", () => {
    expect(actorSchema.safeParse({ kind: "human", id: "owner" }).success).toBe(true);
  });

  it("rejects an unknown actor kind", () => {
    expect(actorSchema.safeParse({ kind: "robot", id: "x" }).success).toBe(false);
  });
});

describe("projectInputSchema", () => {
  it("rejects an empty name", () => {
    expect(projectInputSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects a name longer than 120 characters", () => {
    expect(projectInputSchema.safeParse({ name: "a".repeat(121) }).success).toBe(false);
  });

  it("defaults pitch to an empty string when absent", () => {
    const parsed = projectInputSchema.parse({ name: "Atlas" });
    expect(parsed.pitch).toBe("");
  });

  it("rejects a pitch longer than 500 characters", () => {
    expect(projectInputSchema.safeParse({ name: "Atlas", pitch: "p".repeat(501) }).success).toBe(false);
  });
});

describe("cardInputSchema", () => {
  it("rejects an unknown stage", () => {
    expect(cardInputSchema.safeParse({ title: "Ship it", stage: "deploy" }).success).toBe(false);
  });

  it("rejects an empty title", () => {
    expect(cardInputSchema.safeParse({ title: "", stage: "plan" }).success).toBe(false);
  });

  it("accepts a valid card", () => {
    expect(cardInputSchema.safeParse({ title: "Ship it", stage: "ship" }).success).toBe(true);
  });
});

describe("eventPayloadSchemas", () => {
  it("accepts a valid card.moved payload", () => {
    const schema = eventPayloadSchemas["card.moved"];
    expect(schema.safeParse({ cardId: "c1", from: "plan", to: "build" }).success).toBe(true);
  });

  it("rejects a card.moved payload with an unknown target stage", () => {
    const schema = eventPayloadSchemas["card.moved"];
    expect(schema.safeParse({ cardId: "c1", from: "plan", to: "nope" }).success).toBe(false);
  });

  it("rejects payloads with unknown keys", () => {
    const schema = eventPayloadSchemas["card.moved"];
    expect(schema.safeParse({ cardId: "c1", from: "plan", to: "build", extra: 1 }).success).toBe(false);
  });

  it("rejects an empty cardId", () => {
    const schema = eventPayloadSchemas["card.created"];
    expect(schema.safeParse({ cardId: "", title: "t", stage: "plan" }).success).toBe(false);
  });

  it("defines a schema for every event type", () => {
    expect(Object.keys(eventPayloadSchemas).sort()).toEqual([
      "agent.action.completed",
      "agent.action.decided",
      "agent.action.requested",
      "agent.finished",
      "agent.message",
      "agent.progress",
      "agent.rate_limited",
      "agent.started",
      "card.comment",
      "card.comments_given",
      "card.comments_read",
      "card.created",
      "card.move_declined",
      "card.move_requested",
      "card.moved",
      "card.run_linked",
      "card.status_changed",
      "connection.added",
      "connection.removed",
      "connection.signin",
      "connection.tested",
      "connection.updated",
      "connection.used",
      "gate.blocked",
      "gate.requirement_set",
      "gate.signed_off",
      "gate.waived",
      "intake.answered",
      "intake.completed",
      "intake.decided",
      "intake.reopened",
      "intake.started",
      "link.changes_imported",
      "link.changes_refused",
      "link.decision_received",
      "link.mirrored",
      "link.project_received",
      "link.run_accepted",
      "link.run_failed",
      "link.run_requested",
      "machine.identity_created",
      "machine.linking_disabled",
      "machine.linking_enabled",
      "machine.named",
      "machine.paired",
      "machine.unpaired",
      "override.command",
      "override.completed",
      "override.discard",
      "person.credential_added",
      "person.credential_removed",
      "person.invite_revoked",
      "person.invited",
      "person.joined",
      "person.locked",
      "person.removed",
      "person.renamed",
      "person.role_changed",
      "person.signed_in",
      "project.created",
      "project.files_imported",
      "project.folder_applied",
      "project.published",
      "project.source_set",
      "remote.certificate_changed",
      "remote.disabled",
      "remote.enabled",
      "run.accepted",
      "settings.claude_auth_changed",
      "settings.provider_auth_changed",
      "share.confirmed",
      "share.expired",
      "share.link_created",
      "share.revoked",
      "share.stopped",
    ]);
  });
});
