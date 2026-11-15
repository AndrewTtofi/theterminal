import { z } from "zod";
import type { AgentRun } from "./agents.js";
import type { DirEntry } from "./changes.js";
import type { Project } from "./domain.js";

/** Limits for every import and every write-back. MB means MiB. */
export const IMPORT_LIMITS = { files: 2000, bytes: 209_715_200, fileBytes: 52_428_800 } as const;

export type PathRefusal = "absolute" | "dot_dot" | "git" | "unstorable" | "empty" | "too_long";

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[<>:"|?*\u0000-\u001f]/;

/** Whether a segment names the git directory on any platform: case, trailing dots and spaces, `:stream`, `GIT~n`. */
function gitSegment(name: string): boolean {
  const n = name.toLowerCase();
  if (n === ".git") return true;
  const base = n.split(":")[0]!.replace(/[. ]+$/, "");
  return base === ".git" || /^git~\d+$/.test(base);
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

export function checkImportPath(p: string): { ok: true; path: string } | { ok: false; reason: PathRefusal } {
  if (p === "") return { ok: false, reason: "empty" };
  if (/^[\\/]/.test(p) || /^(?:[A-Z]:|[a-z]:[\\/])/.test(p)) return { ok: false, reason: "absolute" };
  if (p.length > 1024) return { ok: false, reason: "too_long" };
  const segments = p.replace(/\\/g, "/").split("/");
  if (segments.some((s) => s === "")) return { ok: false, reason: "empty" };
  if (segments.some((s) => s === "..")) return { ok: false, reason: "dot_dot" };
  if (segments.some(gitSegment)) return { ok: false, reason: "git" };
  for (const s of segments) {
    if (RESERVED.test(s) || BAD_CHARS.test(s) || /[. ]$/.test(s) || utf8Length(s) > 255) {
      return { ok: false, reason: "unstorable" };
    }
  }
  return { ok: true, path: segments.join("/") };
}

const SECRET_NAMES: readonly RegExp[] = [
  /^\.env(?:\..*)?$/i,
  /\.(?:pem|key|p12|pfx|keystore)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /^(?:\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials\.json)$/i,
];

/** Whether a path may hold a secret. `redactsTo` is the host's redaction, so shared stays free of core. */
export function secretLikePath(p: string, redactsTo: (s: string) => string = (s) => s): boolean {
  if (redactsTo(p) !== p) return true;
  const norm = p.replace(/\\/g, "/");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  if (SECRET_NAMES.some((re) => re.test(base))) return true;
  return /(?:^|\/)\.aws\/credentials$/i.test(norm);
}

/** Lower case, for case-collision checks. */
export const foldKey = (p: string): string => p.toLowerCase();

export type ProjectSourceKind = "github" | "folder";
export type ProjectSourceView = { kind: "github"; repo: string; branch: string } | { kind: "folder"; path?: string } | null;

export type HomeRun = {
  run: AgentRun;
  projectName: string;
  title: string;
  percent: number | null;
  now: string | null;
  summary: string | null;
  waiting: boolean;
  reason: string | null;
};
export type HomeRuns = { working: HomeRun[]; finishedToday: HomeRun[] };
export type ProjectFiles = { source: ProjectSourceView; added: boolean; head: string; entries: DirEntry[]; truncated: boolean };
export type GitHubRepoChoice = { fullName: string; defaultBranch: string; private: boolean };
export type ImportResult = {
  commit: string;
  files: number;
  bytes: number;
  skipped: { path: string; reason: string }[];
  skippedCount: number;
};
export type ImportedProject = { project: Project; result: ImportResult };
export type WritebackPreview = {
  kind: ProjectSourceKind;
  head: string;
  files: { path: string; change: "add" | "modify" | "delete" }[];
};
export type ApplyResult = { written: number; deleted: number; skipped: string[] };

const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const id = z.string().min(1);
const count = z.number().int().nonnegative();
const REPO_NAME = /^(?!\.\.?\/)[A-Za-z0-9_.-]{1,100}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;

export const sourcePayloadSchemas = {
  "project.source_set": z
    .object({
      projectId: id,
      kind: z.enum(["github", "folder"]),
      repo: z.string().regex(REPO_NAME).optional(),
      branch: z.string().min(1).max(255).optional(),
      remoteCommit: sha.optional(),
      path: z.string().min(1).max(4096).optional(),
      syncedCommit: sha,
    })
    .strict()
    .superRefine((v, ctx) => {
      const github = v.kind === "github";
      const ok = github
        ? v.repo !== undefined && v.branch !== undefined && v.remoteCommit !== undefined && v.path === undefined
        : v.path !== undefined && v.repo === undefined && v.branch === undefined && v.remoteCommit === undefined;
      if (!ok) ctx.addIssue({ code: "custom", message: `invalid fields for a ${v.kind} source` });
    }),
  "project.files_imported": z
    .object({
      projectId: id,
      from: z.enum(["files", "github", "folder"]),
      commit: sha,
      files: count,
      bytes: count,
      skipped: count,
      secretsIncluded: z.boolean(),
    })
    .strict(),
  "run.accepted": z.object({ runId: id, commit: sha, files: count }).strict(),
  "project.folder_applied": z
    .object({ projectId: id, from: sha, to: sha, written: count, deleted: count, skipped: count })
    .strict(),
  "project.published": z
    .object({
      projectId: id,
      branch: z.string().regex(/^the-terminal\/[0-9a-f]{8}$/),
      pullUrl: z.string().regex(/^https:\/\/github\.com\/[^\s]{1,300}$/),
      from: sha,
      to: sha,
      files: count,
    })
    .strict(),
} as const;

export type SourceEventType = keyof typeof sourcePayloadSchemas;
