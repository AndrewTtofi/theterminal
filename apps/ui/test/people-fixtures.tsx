import { vi } from "vitest";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import type { Invite, Me, Person, PresenceEntry, Project } from "@theterminal/shared";
import type { RemoteInfo, Status } from "../src/api";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { fakeDock, shellNav } from "./connections-harness";

export const FP = Array.from({ length: 32 }, (_, i) => ((i * 11 + 5) % 256).toString(16).toUpperCase().padStart(2, "0")).join(":");

export const meOf = (over: Partial<Me> = {}): Me => ({
  personId: "owner",
  name: "Owner",
  role: "owner",
  listener: "local",
  method: "token",
  credentials: [],
  sessions: [],
  ...over,
});

export const PEOPLE: Person[] = [
  { id: "owner", name: "Owner", role: "owner", joinedAt: null, lastSeenAt: "2026-11-15T10:00:00.000Z", removedAt: null, credentials: 1 },
  { id: "r1", name: "Reviewer One", role: "reviewer", joinedAt: "2026-11-14T09:00:00.000Z", lastSeenAt: "2026-11-15T09:30:00.000Z", removedAt: null, credentials: 2 },
  { id: "v1", name: "<b>Viewer</b>\u200b", role: "viewer", joinedAt: "2026-11-14T09:00:00.000Z", lastSeenAt: null, removedAt: null, credentials: 1 },
];

export const PRESENCE: PresenceEntry[] = [
  { personId: "r1", name: "Reviewer One", role: "reviewer", projectId: "p1", view: "board", since: "2026-11-15T09:00:00.000Z" },
  { personId: "v1", name: "<b>Viewer</b>\u200b", role: "viewer", projectId: null, view: null, since: "2026-11-15T09:00:00.000Z" },
];

export const INVITES: Invite[] = [
  { id: "i1", role: "maintainer", createdAt: "2026-11-15T08:00:00.000Z", expiresAt: "2026-11-22T08:00:00.000Z", status: "pending" },
];

export const PROJECTS: Project[] = [{ id: "p1", name: "Local Model Hub", pitch: "", createdAt: "" }];

export const REMOTE_OFF: RemoteInfo = {
  enabled: false, listening: false, port: 4318, bind: "0.0.0.0", domain: null, tls: "self_signed", fingerprint: null, expiresAt: null,
  addresses: [], acme: { lastError: null },
};
export const REMOTE_ON: RemoteInfo = {
  ...REMOTE_OFF, enabled: true, listening: true, fingerprint: FP, expiresAt: "2027-11-15T00:00:00.000Z", addresses: ["192.168.1.20"],
};

export const statusWith = (remote?: Status["remote"]): Status => ({
  runningAgents: 0, pendingDecisions: 0, todayCostUsd: 0, monthCostUsd: 0, monthlyBudgetUsd: null,
  connections: { enabled: 0, failed: 0, keychain: "ok" }, ci: null, intakeDecisions: 0, intakeProjects: [],
  machines: { linked: 0, online: 0, keyChanged: 0 }, network: { state: "unknown", basis: "inferred", since: null, lastError: null },
  shareLinks: 0, ...(remote !== undefined && { remote }),
});

export function peopleModel(over: Partial<WorkbenchModel> = {}): WorkbenchModel {
  return {
    me: meOf(),
    people: PEOPLE,
    presence: PRESENCE,
    invites: INVITES,
    remote: REMOTE_OFF,
    projects: PROJECTS,
    status: statusWith({ enabled: false, listening: false, label: "off" }),
    refreshPeople: vi.fn(),
    onMeChange: vi.fn(),
    ...over,
  } as unknown as WorkbenchModel;
}

/** Renders `ui` inside the shell context with `model`; returns the fake dock to check what was opened. */
export function renderInShell(
  ui: ReactElement,
  model: WorkbenchModel,
): ReturnType<typeof render> & { dock: ReturnType<typeof fakeDock>; nav: ReturnType<typeof shellNav> } {
  const dock = fakeDock();
  const nav = shellNav();
  const utils = render(<ShellContext.Provider value={{ model, dock: () => dock, ...nav }}>{ui}</ShellContext.Provider>);
  return { ...utils, dock, nav };
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
