import { describe, expect, it } from "vitest";
import {
  checkImportPath,
  eventPayloadSchemas,
  foldKey,
  IMPORT_LIMITS,
  secretLikePath,
  sourcePayloadSchemas,
} from "../src/index.js";

const SHA = "a".repeat(40);

describe("IMPORT_LIMITS", () => {
  it("holds the fixed limits", () => {
    expect(IMPORT_LIMITS).toEqual({ files: 2000, bytes: 209_715_200, fileBytes: 52_428_800 });
  });
});

describe("checkImportPath", () => {
  it("accepts ordinary paths and normalises separators", () => {
    expect(checkImportPath("src/a.ts")).toEqual({ ok: true, path: "src/a.ts" });
    expect(checkImportPath("docs\\b.md")).toEqual({ ok: true, path: "docs/b.md" });
    expect(checkImportPath("ünïcode/ok.txt")).toEqual({ ok: true, path: "ünïcode/ok.txt" });
  });

  it.each([
    ["/etc/x", "absolute"],
    ["\\x", "absolute"],
    ["C:x", "absolute"],
    ["a/../b", "dot_dot"],
    [".git/config", "git"],
    ["x/.GIT/y", "git"],
    ["con.txt", "unstorable"],
    ["a/aux", "unstorable"],
    ["a/LPT1.log", "unstorable"],
    ["a:b", "unstorable"],
    ["a/b.", "unstorable"],
    ["a/b ", "unstorable"],
    ["a\u0001", "unstorable"],
    ["a<b", "unstorable"],
    ["a?b", "unstorable"],
    ["", "empty"],
    ["a//b", "empty"],
    [`${"a".repeat(256)}`, "unstorable"],
    [`${"a/".repeat(600)}b`, "too_long"],
  ])("refuses %j as %s", (p, reason) => {
    expect(checkImportPath(p)).toEqual({ ok: false, reason });
  });
});

describe("secretLikePath", () => {
  it.each([".env", "config/.env.local", "server.pem", "a/b.key", "x.p12", "x.pfx", "id_rsa", "id_ed25519", ".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials.json", "a.keystore", "x/.aws/credentials"])(
    "flags %s",
    (p) => expect(secretLikePath(p)).toBe(true),
  );
  it.each(["id_rsa.pub", "env.ts", "README.md"])("does not flag %s", (p) => expect(secretLikePath(p)).toBe(false));
  it("flags a name the redactor changes", () => {
    const name = "notes-ghp_TESTKEY0123456789.txt";
    const redact = (s: string) => s.replace(/ghp_[A-Za-z0-9]+/g, "[redacted]");
    expect(secretLikePath(name)).toBe(false);
    expect(secretLikePath(name, redact)).toBe(true);
  });
});

describe("foldKey", () => {
  it("lower-cases", () => expect(foldKey("A/B.TXT")).toBe("a/b.txt"));
});

describe("source payload schemas", () => {
  const set = sourcePayloadSchemas["project.source_set"];
  const gh = { projectId: "p1", kind: "github", repo: "o/r", branch: "main", remoteCommit: SHA, syncedCommit: SHA };
  it("accepts a github and a folder source", () => {
    expect(set.safeParse(gh).success).toBe(true);
    expect(set.safeParse({ projectId: "p1", kind: "folder", path: "/x/y", syncedCommit: SHA }).success).toBe(true);
  });
  it("refuses wrong combinations", () => {
    expect(set.safeParse({ projectId: "p1", kind: "github", branch: "main", remoteCommit: SHA, syncedCommit: SHA }).success).toBe(false);
    expect(set.safeParse({ ...gh, repo: "../x" }).success).toBe(false);
    expect(set.safeParse({ projectId: "p1", kind: "folder", repo: "o/r", path: "/x", syncedCommit: SHA }).success).toBe(false);
    expect(set.safeParse({ projectId: "p1", kind: "folder", syncedCommit: SHA }).success).toBe(false);
    expect(set.safeParse({ ...gh, syncedCommit: "nope" }).success).toBe(false);
    expect(set.safeParse({ ...gh, extra: 1 }).success).toBe(false);
  });
  it("validates files_imported, accepted and applied", () => {
    const fi = sourcePayloadSchemas["project.files_imported"];
    const ok = { projectId: "p1", from: "files", commit: SHA, files: 1, bytes: 2, skipped: 0, secretsIncluded: false };
    expect(fi.safeParse(ok).success).toBe(true);
    expect(fi.safeParse({ ...ok, files: -1 }).success).toBe(false);
    expect(fi.safeParse({ ...ok, from: "zip" }).success).toBe(false);
    expect(sourcePayloadSchemas["run.accepted"].safeParse({ runId: "r1", commit: SHA, files: 3 }).success).toBe(true);
    expect(
      sourcePayloadSchemas["project.folder_applied"].safeParse({ projectId: "p1", from: SHA, to: SHA, written: 1, deleted: 0, skipped: 0 }).success,
    ).toBe(true);
  });
  it("validates project.published", () => {
    const s = sourcePayloadSchemas["project.published"];
    const ok = { projectId: "p1", branch: "the-terminal/0123abcd", pullUrl: "https://github.com/o/r/pull/1", from: SHA, to: SHA, files: 2 };
    expect(s.safeParse(ok).success).toBe(true);
    expect(s.safeParse({ ...ok, branch: "main" }).success).toBe(false);
    expect(s.safeParse({ ...ok, pullUrl: "http://github.com/o/r/pull/1" }).success).toBe(false);
  });
  it("registers every new type", () => {
    for (const t of Object.keys(sourcePayloadSchemas)) expect(eventPayloadSchemas).toHaveProperty(t);
    expect(Object.keys(sourcePayloadSchemas).sort()).toEqual([
      "project.files_imported", "project.folder_applied", "project.published", "project.source_set", "run.accepted",
    ]);
  });
});
