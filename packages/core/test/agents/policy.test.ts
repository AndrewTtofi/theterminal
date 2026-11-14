import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProposedAction } from "../../src/agents/adapter.js";
import { classify } from "../../src/agents/policy.js";
import { WorktreeManager } from "../../src/agents/worktrees.js";

let wt: string;
let outside: string;
const mgr = new WorktreeManager(tmpdir());

beforeEach(() => {
  wt = realpathSync(mkdtempSync(join(tmpdir(), "policy-wt-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "policy-out-")));
});
afterEach(() => {
  rmSync(wt, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const action = (kind: ProposedAction["kind"], paths: string[]): ProposedAction => ({
  tool: "Tool", kind, summary: "s", input: {}, paths,
});

describe("classify", () => {
  it("auto-allows a read with all paths inside the worktree", () => {
    expect(classify(action("file_read", ["README.md", "src/a.ts"]), wt, mgr)).toEqual({
      verdict: "auto_allow", reason: "read-only inside worktree",
    });
  });

  it("asks for a read without paths", () => {
    expect(classify(action("file_read", []), wt, mgr).verdict).toBe("ask");
  });

  it("asks for an inside write, an edit and a shell command", () => {
    expect(classify(action("file_write", ["a.txt"]), wt, mgr).verdict).toBe("ask");
    expect(classify(action("file_edit", ["a.txt"]), wt, mgr).verdict).toBe("ask");
    expect(classify(action("shell", []), wt, mgr).verdict).toBe("ask");
  });

  it("auto-denies absolute outside paths and .. escapes, for any kind", () => {
    const deny = { verdict: "auto_deny", reason: "outside worktree" };
    expect(classify(action("file_read", ["/etc/passwd"]), wt, mgr)).toEqual(deny);
    expect(classify(action("file_read", ["../x"]), wt, mgr)).toEqual(deny);
    expect(classify(action("file_read", ["ok.txt", "../x"]), wt, mgr)).toEqual(deny);
    expect(classify(action("shell", ["/etc/passwd"]), wt, mgr)).toEqual(deny);
    expect(classify(action("file_write", [".git/config"]), wt, mgr)).toEqual(deny);
  });

  it("auto-denies a symlink escape", (ctx) => {
    try {
      symlinkSync(outside, join(wt, "link"), "dir");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return ctx.skip();
      throw e;
    }
    expect(classify(action("file_read", ["link/secret"]), wt, mgr)).toEqual({
      verdict: "auto_deny", reason: "outside worktree",
    });
  });
});

describe("classify truncated input", () => {
  const truncated = { truncated: true, sha256: "0".repeat(64), totalChars: 25000, preview: "echo zzz" };
  it("auto-denies a shell action whose recorded input is truncated", () => {
    expect(classify({ ...action("shell", []), input: truncated }, wt, mgr)).toEqual({
      verdict: "auto_deny", reason: "command too long to review",
    });
  });
  it("leaves other kinds and plain shell input alone", () => {
    expect(classify({ ...action("file_write", ["a.txt"]), input: truncated }, wt, mgr).verdict).toBe("ask");
    expect(classify({ ...action("shell", []), input: { command: "ls" } }, wt, mgr).verdict).toBe("ask");
  });
});
