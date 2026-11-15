import { render } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { DEFAULT_SHARE_OPTIONS, HIDDEN_BY_DEFAULT } from "@theterminal/shared";
import type { DailyDigest, ShareLink, ShareSnapshot, ShareSnapshotRecord } from "@theterminal/shared";
import type { ShareAddress, SharePreview } from "../src/api";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { fakeDock, shellNav } from "./connections-harness";
import { OWNER_ME } from "./as-owner";

export const SHARE_ID = "5a7c0e1f9b2d4c3a8e6f00112233aabb";
export const HASH = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";

export function preview(over: Partial<SharePreview> = {}): SharePreview {
  return {
    previewId: "pv1",
    contentHash: HASH,
    bytes: 20480,
    expiresAt: "2026-11-15T12:10:00.000Z",
    html: "<!doctype html><title>Book Club</title><h1>Book Club</h1><p>Reading lists</p>",
    snapshot: { hidden: [...HIDDEN_BY_DEFAULT] } as unknown as ShareSnapshot,
    ...over,
  };
}

export function snapshotRecord(over: Partial<ShareSnapshotRecord> = {}): ShareSnapshotRecord {
  return {
    id: SHARE_ID,
    projectId: "p1",
    contentHash: HASH,
    bytes: 20480,
    sections: ["overview"],
    options: DEFAULT_SHARE_OPTIONS,
    headSeq: 10,
    confirmedAt: "2026-11-15T12:00:00.000Z",
    ...over,
  };
}

export function link(over: Partial<ShareLink> = {}): ShareLink {
  return {
    id: "l1",
    shareId: SHARE_ID,
    projectId: "p1",
    scope: "this_computer",
    port: 47400,
    state: "active",
    createdAt: "2026-11-15T12:00:00.000Z",
    expiresAt: "2026-11-16T12:00:00.000Z",
    endedAt: null,
    ...over,
  };
}

export const ADDRESSES: ShareAddress[] = [
  { address: "127.0.0.1", scope: "this_computer", label: "This computer only" },
  { address: "192.168.1.20", scope: "local_network", label: "Local network (192.168.1.20)" },
];

export function digest(over: Partial<DailyDigest> = {}): DailyDigest {
  return {
    day: "2026-11-15",
    summary: "4 ledger entries: 1 agent action requested, 1 allowed and 0 denied by a human.",
    counts: { entries: 4, actions: 1, allowed: 1, denied: 0, decisions: 1, cardsMoved: 0, runsStarted: 0, runsFinished: 0, spendUsd: null },
    items: [
      { seq: 3, time: "09:30", headline: "Owner created card \"Login\"", topic: "board", attention: false },
      { seq: 4, time: "09:31", headline: "A Fake agent wants to run the command \"nvidia-smi\"", topic: "agent", attention: true },
      { seq: 5, time: "09:40", headline: "OVERRIDE: Owner ran git status", topic: "override", attention: false },
    ],
    more: 3,
    ...over,
  };
}

export function shareModel(over: Partial<WorkbenchModel["share"]> = {}): WorkbenchModel["share"] {
  return {
    options: DEFAULT_SHARE_OPTIONS,
    onOptionsChange: vi.fn(),
    preview: null,
    previewing: false,
    onPreview: vi.fn().mockResolvedValue(true),
    onConfirm: vi.fn().mockResolvedValue(true),
    snapshots: [],
    links: [],
    addresses: ADDRESSES,
    addressesError: null,
    loadAddresses: vi.fn(),
    onCreateLink: vi.fn().mockResolvedValue({ url: "http://127.0.0.1:47400/tok" }),
    onRevokeLink: vi.fn().mockResolvedValue(true),
    ...over,
  };
}

export function digestsModel(over: Partial<WorkbenchModel["digests"]> = {}): WorkbenchModel["digests"] {
  return { days: 7, onDaysChange: vi.fn(), list: [digest()], watch: vi.fn(() => () => {}), ...over };
}

/** Renders `children` in the shell context with a model holding only what the share views read. */
export function renderShare(
  children: ReactNode,
  over: { share?: Partial<WorkbenchModel["share"]>; digests?: Partial<WorkbenchModel["digests"]>; selectedId?: string | null } = {},
): RenderResult & { model: WorkbenchModel; dock: ReturnType<typeof fakeDock> } {
  const dock = fakeDock();
  const model = {
    selectedId: over.selectedId === undefined ? "p1" : over.selectedId,
    share: shareModel(over.share),
    digests: digestsModel(over.digests),
    me: OWNER_ME,
  } as unknown as WorkbenchModel;
  const result = render(<ShellContext.Provider value={{ model, dock: () => dock, ...shellNav() }}>{children}</ShellContext.Provider>);
  return { ...result, model, dock };
}
