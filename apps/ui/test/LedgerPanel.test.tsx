import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { narrate } from "@theterminal/shared";
import type { LedgerEntry } from "@theterminal/shared";
import { LedgerPanel, describeEntry } from "../src/components/LedgerPanel";

const base = { id: "x", ts: "2026-01-01T10:00:00Z", projectId: "p1", prevHash: "", hash: "" };
const owner = { kind: "human", id: "owner" } as const;
const entry = (seq: number, type: LedgerEntry["type"], payload: unknown, actor: LedgerEntry["actor"] = owner): LedgerEntry => ({
  ...base,
  seq,
  type,
  payload,
  actor,
});

describe("describeEntry rate limits", () => {
  it("describes an observed rate limit, with the wait when there is one", () => {
    const agent = { kind: "agent", id: "abcdef1234567890" } as const;
    expect(describeEntry(entry(1, "agent.rate_limited", { runId: "abcdef1234567890", retryAfterS: null }, agent))).toBe(
      "Agent abcdef12 was rate-limited by the provider",
    );
    expect(describeEntry(entry(2, "agent.rate_limited", { runId: "abcdef1234567890", retryAfterS: 30 }, agent))).toBe(
      "Agent abcdef12 was rate-limited by the provider; retry after 30 s",
    );
  });
});

describe("describeEntry connections", () => {
  const c = { connectionId: "c1", name: "Work key" };
  it("describes connection events", () => {
    expect(describeEntry(entry(1, "connection.added", { ...c, kind: "llm", provider: "claude", config: {}, secretFields: [], privateFields: [] }))).toBe(
      'Owner connected "Work key" (AI model)',
    );
    expect(describeEntry(entry(2, "connection.updated", { ...c, changes: { enabled: true } }))).toBe('Owner enabled "Work key"');
    expect(describeEntry(entry(3, "connection.updated", { ...c, changes: { enabled: false } }))).toBe('Owner disabled "Work key"');
    expect(describeEntry(entry(4, "connection.updated", { ...c, changes: { secretsSet: ["apiKey", "token"] } }))).toBe(
      'Owner replaced the apiKey, token of "Work key"',
    );
    expect(describeEntry(entry(5, "connection.updated", { ...c, changes: { name: "New" } }))).toBe('Owner updated "Work key"');
    expect(describeEntry(entry(6, "connection.removed", c))).toBe('Owner removed "Work key"');
    expect(describeEntry(entry(7, "connection.tested", { ...c, ok: true, message: "" }))).toBe('"Work key" connected');
    expect(describeEntry(entry(8, "connection.tested", { ...c, ok: false, message: "Key rejected" }))).toBe(
      '"Work key" failed to connect: Key rejected',
    );
    const longFailure = entry(10, "connection.tested", { ...c, ok: false, message: "x".repeat(300) });
    const clipped = describeEntry(longFailure);
    expect(clipped).toBe(narrate(longFailure).headline);
    expect(clipped.startsWith('"Work key" failed to connect: xxx')).toBe(true);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped.length).toBeLessThanOrEqual(200);
    expect(
      describeEntry(entry(9, "connection.used", { ...c, runId: "abcdef1234567890", purpose: "api_key" }, { kind: "system", id: "runner" })),
    ).toBe('Agent abcdef12 was given access to "Work key"');
  });

  it("describes what a run was given: the kind of cloud credential, or an MCP server, never a value", () => {
    const used = (purpose: string, extra: Record<string, unknown> = {}) =>
      describeEntry(entry(20, "connection.used", { connectionId: "c1", name: "Ops", runId: "abcdef1234567890", purpose, ...extra }, { kind: "system", id: "runner" }));
    expect(used("cloud_credentials", { credential: "aws_session_token", expiresAt: "2026-11-16T00:00:00.000Z" })).toBe(
      'Agent abcdef12 was given a 12-hour AWS session token from "Ops"',
    );
    expect(used("cloud_credentials", { credential: "aws_static_keys", expiresAt: null })).toBe(
      'Agent abcdef12 was given the AWS access keys (no session token available) from "Ops"',
    );
    expect(used("cloud_credentials", { credential: "gcp_access_token", expiresAt: "2026-11-16T00:00:00.000Z" })).toBe(
      'Agent abcdef12 was given a 1-hour Google Cloud token from "Ops"',
    );
    expect(used("cloud_credentials", { credential: "azure_client_secret", expiresAt: null })).toBe(
      'Agent abcdef12 was given the Azure client secret from "Ops"',
    );
    expect(used("mcp_server")).toBe('Agent abcdef12 was given the MCP server "Ops"');
  });

  it("describes a sign-in with only the provider and the outcome", () => {
    expect(describeEntry(entry(11, "connection.signin", { provider: "codex", ok: true }))).toBe("Owner signed in to Codex");
    expect(describeEntry(entry(12, "connection.signin", { provider: "claude", ok: false }))).toBe("Sign-in to Claude failed");
  });
});

describe("describeEntry", () => {
  it("describes each event type", () => {
    expect(describeEntry(entry(1, "project.created", { name: "Demo" }))).toBe('Owner created the project "Demo"');
    expect(describeEntry(entry(2, "card.created", { title: "Detect GPU", stage: "plan" }))).toBe(
      'Owner added "Detect GPU" to Plan',
    );
    expect(describeEntry(entry(3, "card.moved", { from: "plan", to: "build" }))).toBe(
      "Owner moved a card from Plan to Build",
    );
    expect(describeEntry(entry(4, "card.status_changed", { from: "todo", to: "done" }))).toBe(
      "Owner marked a card done",
    );
  });

  it("names an agent actor without a known adapter as The agent", () => {
    const e = entry(5, "card.moved", { from: "build", to: "ship" }, { kind: "agent", id: "a7" });
    expect(describeEntry(e)).toBe("The agent moved a card from Build to Ship");
  });

  it("names the card when the context knows its title", () => {
    const e = entry(6, "card.moved", { cardId: "c9", from: "build", to: "ship" });
    expect(describeEntry(e, { cardTitle: (id) => (id === "c9" ? "Login" : undefined) })).toBe('Owner moved "Login" from Build to Ship');
  });
});

describe("describeEntry agent events", () => {
  const agent = { kind: "agent", id: "abcdef123456" } as const;
  const policy = { kind: "system", id: "policy" } as const;
  const runner = { kind: "system", id: "runner" } as const;

  it("describes agent.started with capitalised adapter and truncated prompt", () => {
    expect(describeEntry(entry(1, "agent.started", { adapter: "claude", prompt: "Fix it" }))).toBe(
      'Owner started a Claude agent: "Fix it"',
    );
    const long = "x".repeat(90);
    expect(describeEntry(entry(2, "agent.started", { adapter: "fake", prompt: long }))).toBe(
      `Owner started a Fake agent: "${"x".repeat(80)}…"`,
    );
  });

  it("describes requests, decisions and completions", () => {
    expect(describeEntry(entry(3, "agent.action.requested", { summary: "run ls" }, agent))).toBe(
      "The agent wants to run ls",
    );
    expect(describeEntry(entry(4, "agent.action.decided", { decision: "allow", reason: "" }, policy))).toBe(
      "Allowed automatically",
    );
    expect(describeEntry(entry(5, "agent.action.decided", { decision: "deny", reason: "" }))).toBe(
      "Owner denied it: no reason given",
    );
    expect(describeEntry(entry(6, "agent.action.decided", { decision: "deny", reason: "too risky" }))).toBe(
      "Owner denied it: too risky",
    );
    expect(describeEntry(entry(7, "agent.action.completed", { ok: true }, agent))).toBe(
      "Done (0 lines of output)",
    );
    expect(describeEntry(entry(8, "agent.action.completed", { ok: false }, agent))).toBe(
      "It failed",
    );
  });

  it("describes messages, finish and settings", () => {
    expect(describeEntry(entry(9, "agent.message", { text: "hi" }, agent))).toBe('The agent said: "hi"');
    expect(describeEntry(entry(10, "agent.message", { text: "y".repeat(130) }, agent))).toBe(
      `The agent said: "${"y".repeat(120)}…"`,
    );
    expect(describeEntry(entry(11, "agent.finished", { status: "completed" }, runner))).toBe(
      "The agent finished",
    );
    expect(describeEntry(entry(12, "settings.claude_auth_changed", { mode: "api_key" }))).toBe(
      "Owner set Claude to use API key",
    );
    expect(describeEntry(entry(13, "settings.claude_auth_changed", { mode: "subscription" }))).toBe(
      "Owner set Claude to use own subscription",
    );
  });

  it("describes provider auth changes", () => {
    const d = (provider: string, mode: string) =>
      describeEntry(entry(20, "settings.provider_auth_changed", { provider, mode }));
    expect(d("claude", "api_key")).toBe("Owner set Claude to use API key");
    expect(d("claude", "subscription")).toBe("Owner set Claude to use own subscription");
    expect(d("codex", "chatgpt")).toBe("Owner set Codex to use own ChatGPT plan");
    expect(d("gemini", "google")).toBe("Owner set Gemini to use own Google account");
  });

  it("falls back for unknown types", () => {
    expect(describeEntry(entry(14, "something.new" as LedgerEntry["type"], {}, runner))).toBe(
      "The workspace recorded something.new",
    );
  });
});

describe("LedgerPanel", () => {
  it("lists entries newest first", () => {
    render(
      <LedgerPanel
        entries={[
          entry(1, "project.created", { name: "Demo" }),
          entry(2, "card.created", { title: "Detect GPU", stage: "plan" }),
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(items[0]).toContain("Detect GPU");
    expect(items[1]).toContain("Demo");
  });
});

describe("LedgerPanel narration and raw record", () => {
  const ctx = { cardTitle: (id: string) => (id === "c9" ? "Login" : undefined) };

  it("shows the headline with the context, and the raw payload underneath as text", () => {
    render(<LedgerPanel entries={[entry(1, "card.moved", { cardId: "c9", from: "build", to: "ship" })]} ctx={ctx} />);
    const li = screen.getByRole("listitem");
    expect(li.querySelector(".headline")?.textContent).toBe('Owner moved "Login" from Build to Ship');
    expect(li.querySelector(".headline details")).toBeNull();
    const raw = li.querySelector("details");
    expect(raw?.querySelector("summary")?.textContent).toBe("Raw");
    const pre = raw?.querySelector("pre")?.textContent ?? "";
    expect(pre).toContain('"cardId": "c9"');
    expect(pre).toContain('"to": "ship"');
  });

  it("puts the detail above the payload and sorts the payload's keys", () => {
    const agent = { kind: "agent", id: "abcdef123456" } as const;
    render(<LedgerPanel entries={[entry(1, "agent.message", { text: "Found the GPU", runId: "r1" }, agent)]} />);
    const pre = screen.getByRole("listitem").querySelector("details pre")?.textContent ?? "";
    expect(pre.startsWith("Found the GPU")).toBe(true);
    expect(pre.indexOf('"runId"')).toBeLessThan(pre.indexOf('"text"'));
  });

  it("renders a hostile payload as inert text and makes hidden characters visible", () => {
    const agent = { kind: "agent", id: "abcdef123456" } as const;
    const text = '<img src=x onerror="window.__pwned=1">a\u202eb\u200bc';
    const { container } = render(<LedgerPanel entries={[entry(1, "agent.message", { runId: "r1", text }, agent)]} />);
    expect(container.querySelector("img, script")).toBeNull();
    const pre = container.querySelector("details pre")?.textContent ?? "";
    expect(pre).toContain("<img src=x");
    expect(pre).toContain("a\\u202eb\\u200bc");
    expect(pre).not.toMatch(/[\u200b\u202e]/);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("marks entries that need attention", () => {
    const agent = { kind: "agent", id: "abcdef123456" } as const;
    render(
      <LedgerPanel
        entries={[
          entry(1, "project.created", { name: "Demo" }),
          entry(2, "agent.action.requested", { runId: "r1", kind: "shell", tool: "Bash", summary: "Run: ls", input: { command: "ls" } }, agent),
        ]}
      />,
    );
    const [requested, created] = screen.getAllByRole("listitem");
    expect(requested!.classList.contains("attention")).toBe(true);
    expect(created!.classList.contains("attention")).toBe(false);
  });

  it("hides entries outside the chosen topics", () => {
    render(
      <LedgerPanel
        topics={["gate"]}
        entries={[
          entry(1, "card.created", { title: "Detect GPU", stage: "plan" }),
          entry(2, "gate.blocked", { cardId: "c9", to: "ship", gates: [] }),
        ]}
      />,
    );
    const aside = screen.getByRole("complementary", { name: "Ledger" });
    expect(within(aside).getAllByRole("listitem")).toHaveLength(1);
    expect(aside.textContent).not.toContain("Detect GPU");
  });

  it("labels each Raw summary with its headline", () => {
    render(<LedgerPanel entries={[entry(1, "card.created", { title: "Detect GPU", stage: "plan" })]} />);
    const summary = screen.getByRole("listitem").querySelector("summary")!;
    expect(summary.textContent).toBe("Raw");
    expect(summary.getAttribute("aria-label")).toBe('Raw record: Owner added "Detect GPU" to Plan');
  });

  it("says how many entries needing attention the topic filter hides", () => {
    const agent = { kind: "agent", id: "abcdef123456" } as const;
    const requested = (seq: number) =>
      entry(seq, "agent.action.requested", { runId: "r1", kind: "shell", tool: "Bash", summary: "Run: ls", input: { command: "ls" } }, agent);
    const { rerender } = render(<LedgerPanel topics={["board"]} entries={[entry(1, "card.created", { title: "A", stage: "plan" }), requested(2), requested(3)]} />);
    expect(screen.getByText("2 entries needing attention are hidden by the topic filter")).toBeTruthy();
    rerender(<LedgerPanel topics={["board"]} entries={[requested(2)]} />);
    expect(screen.getByText("1 entry needing attention is hidden by the topic filter")).toBeTruthy();
    rerender(<LedgerPanel entries={[requested(2)]} />);
    expect(screen.queryByText(/hidden by the topic filter/)).toBeNull();
  });
});
