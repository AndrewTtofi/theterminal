import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONNECTION_CATALOG } from "@theterminal/shared";

vi.mock("../src/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/api")>();
  return {
    ...real,
    api: {
      listConnections: vi.fn(),
      getConnectionCatalog: vi.fn(),
      addConnection: vi.fn(),
      updateConnection: vi.fn(),
      removeConnection: vi.fn(),
      testConnection: vi.fn(),
    },
  };
});

import { api } from "../src/api";
import { ConnectionsSideBar } from "../src/views/ConnectionsSideBar";
import { connection, renderWithConnections } from "./connections-harness";

const m = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  m.listConnections.mockResolvedValue([]);
  m.getConnectionCatalog.mockResolvedValue([...CONNECTION_CATALOG]);
});

const groupTitles = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

describe("ConnectionsSideBar", () => {
  it("lists the five groups in order, with every catalog entry", async () => {
    renderWithConnections(<ConnectionsSideBar />);
    await waitFor(() => expect(m.listConnections).toHaveBeenCalled());
    expect(groupTitles()).toEqual(["AI models", "Code hosting", "Cloud accounts", "Tools (MCP)", "Hardware"]);
    for (const e of CONNECTION_CATALOG) expect(screen.getByText(e.label)).toBeTruthy();
  });

  it("shows unavailable entries disabled, with the later-release note", async () => {
    m.getConnectionCatalog.mockResolvedValue(CONNECTION_CATALOG.map((e) => (e.provider === "aws" ? { ...e, available: false } : e)));
    renderWithConnections(<ConnectionsSideBar />);
    await waitFor(() => expect((screen.getByRole("button", { name: "GitHub" }) as HTMLButtonElement).disabled).toBe(false));
    const aws = screen.getByText("AWS").closest("li")!;
    expect(aws.getAttribute("aria-disabled")).toBe("true");
    expect(aws.textContent).toContain("Arrives in a later release");
    expect(aws.textContent).not.toMatch(/Plan \d/);
    expect((within(aws).getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    const claude = screen.getByText("Claude (Anthropic)").closest("li")!;
    expect(claude.getAttribute("aria-disabled")).toBeNull();
  });

  it("filters by label and description", async () => {
    renderWithConnections(<ConnectionsSideBar />);
    const search = screen.getByRole("searchbox", { name: "Search connections" }) as HTMLInputElement;
    expect(search.placeholder).toBe("Search connections");

    await userEvent.type(search, "git");
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.queryByText("Claude (Anthropic)")).toBeNull();
    expect(groupTitles()).toEqual(["Code hosting"]);

    await userEvent.clear(search);
    await userEvent.type(search, "ChatGPT plan");
    expect(screen.getByText("Codex (OpenAI)")).toBeTruthy();
    expect(screen.queryByText("GitHub")).toBeNull();

    await userEvent.clear(search);
    await userEvent.type(search, "nothing matches this");
    expect(screen.getByText("No connections match.")).toBeTruthy();
  });

  it("shows a status dot per entry: hollow when not connected, coloured by test state when connected", async () => {
    m.listConnections.mockResolvedValue([
      connection({ id: "c1", provider: "claude", status: { state: "ok", message: "ok", testedAt: "2026-01-01T00:00:00Z" } }),
      connection({ id: "c2", provider: "codex", name: "Codex", status: { state: "failed", message: "no", testedAt: null } }),
      connection({ id: "c3", provider: "github", kind: "github", name: "GitHub", secretFields: ["token"] }),
    ]);
    renderWithConnections(<ConnectionsSideBar />);
    const dot = (label: string) => screen.getByText(label).closest("li")!.querySelector(".status-dot")!;
    await waitFor(() => expect(dot("Claude (Anthropic)").classList.contains("ok")).toBe(true));
    expect(dot("Codex (OpenAI)").classList.contains("failed")).toBe(true);
    expect(dot("GitHub").classList.contains("untested")).toBe(true);
    expect(dot("Gemini (Google)").classList.contains("not-connected")).toBe(true);
    expect(screen.queryByRole("switch", { name: "Enable Gemini (Google)" })).toBeNull();
  });

  it("the enable switch calls updateConnection(id, { enabled: false }) and is disabled while it is in flight", async () => {
    m.listConnections.mockResolvedValue([connection()]);
    let finish!: (c: ReturnType<typeof connection>) => void;
    m.updateConnection.mockImplementation(() => new Promise((r) => (finish = r)));
    renderWithConnections(<ConnectionsSideBar />);
    const sw = (await screen.findByRole("switch", { name: "Enable Claude (Anthropic)" })) as HTMLButtonElement;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(sw);
    expect(m.updateConnection).toHaveBeenCalledWith("c1", { enabled: false });
    expect(sw.disabled).toBe(true);
    await act(async () => finish(connection({ enabled: false })));
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
    expect(sw.disabled).toBe(false);
  });

  it("names a row by its label and describes it by status and description", async () => {
    renderWithConnections(<ConnectionsSideBar />);
    const row = screen.getByRole("button", { name: "Claude (Anthropic)" });
    expect(row.getAttribute("aria-describedby")).toBeTruthy();
    await waitFor(() => expect((row as HTMLButtonElement).disabled).toBe(false));
    const description = row
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)!.textContent)
      .join(" ");
    expect(description).toContain("Not connected");
    expect(description).toContain("Run Claude agents with an Anthropic API key.");
  });

  it("shows a failed load with Retry, keeps rows disabled until the list loads, then enables them", async () => {
    m.listConnections.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([connection()]);
    renderWithConnections(<ConnectionsSideBar />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load connections");
    // The static catalog still shows, but nothing can be opened yet.
    expect((screen.getByRole("button", { name: "Claude (Anthropic)" }) as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(m.listConnections).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect((screen.getByRole("button", { name: "Claude (Anthropic)" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("switch", { name: "Enable Claude (Anthropic)" })).toBeTruthy();
  });

  it("opens the editor tab: a new one when not connected, the connection's when connected", async () => {
    m.listConnections.mockResolvedValue([connection()]);
    const { dock } = renderWithConnections(<ConnectionsSideBar />);
    await screen.findByRole("switch", { name: "Enable Claude (Anthropic)" });
    await userEvent.click(screen.getByRole("button", { name: "Claude (Anthropic)" }));
    expect(dock.open).toHaveBeenCalledWith("connection:c1", "Claude (Anthropic)", "main");
    await userEvent.click(screen.getByRole("button", { name: "GitHub" }));
    expect(dock.open).toHaveBeenCalledWith("connection:new:github", "GitHub", "main");
  });
  it("offers Add another for a provider that allows several connections, once one exists", async () => {
    m.listConnections.mockResolvedValue([
      connection(),
      connection({ id: "a1", kind: "cloud", provider: "aws", name: "AWS", config: { region: "us-east-1" }, secretFields: [] }),
    ]);
    const { dock } = renderWithConnections(<ConnectionsSideBar />);
    const add = (await screen.findByRole("button", { name: "Add another AWS" })) as HTMLButtonElement;
    expect(add.textContent).toBe("Add another");
    // Single-connection providers, and providers with no connection yet, have no Add another.
    expect(screen.queryByRole("button", { name: "Add another Claude (Anthropic)" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add another Google Cloud" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Add another/ })).toBe(add);
    await userEvent.click(add);
    expect(dock.open).toHaveBeenCalledWith("connection:new:aws", "AWS", "main");
    // The row itself still opens the existing connection.
    await userEvent.click(screen.getByRole("button", { name: "AWS" }));
    expect(dock.open).toHaveBeenCalledWith("connection:a1", "AWS", "main");
  });

  it("offers Add another for MCP servers too", async () => {
    m.listConnections.mockResolvedValue([
      connection({ id: "m1", kind: "mcp", provider: "mcp_http", name: "Docs", config: { url: "https://mcp.example.test/" }, secretFields: [] }),
    ]);
    const { dock } = renderWithConnections(<ConnectionsSideBar />);
    await userEvent.click(await screen.findByRole("button", { name: "Add another MCP server (remote)" }));
    expect(dock.open).toHaveBeenCalledWith("connection:new:mcp_http", "MCP server (remote)", "main");
  });

  it("lists each connection by name when a provider has several, each with its own tab and switch", async () => {
    m.listConnections.mockResolvedValue([
      connection({ id: "a1", kind: "cloud", provider: "aws", name: "Staging", config: { region: "us-east-1" }, secretFields: [] }),
      connection({
        id: "a2", kind: "cloud", provider: "aws", name: "Production", enabled: false, config: { region: "eu-west-1" }, secretFields: [],
        status: { state: "ok", message: "ok", testedAt: "2026-01-01T00:00:00Z" },
      }),
    ]);
    m.updateConnection.mockResolvedValue(
      connection({ id: "a2", kind: "cloud", provider: "aws", name: "Production", enabled: true, config: { region: "eu-west-1" }, secretFields: [] }),
    );
    const { dock } = renderWithConnections(<ConnectionsSideBar />);
    const prod = await screen.findByRole("button", { name: "AWS: Production" });
    expect(screen.getByRole("button", { name: "AWS: Staging" })).toBeTruthy();
    expect(prod.querySelector(".status-dot")!.classList.contains("ok")).toBe(true);
    await userEvent.click(prod);
    expect(dock.open).toHaveBeenCalledWith("connection:a2", "AWS", "main");
    const sw = screen.getByRole("switch", { name: "Enable AWS: Production" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(sw);
    expect(m.updateConnection).toHaveBeenCalledWith("a2", { enabled: true });
  });

  it("lists no per-connection rows while a provider has only one connection", async () => {
    m.listConnections.mockResolvedValue([
      connection({ id: "a1", kind: "cloud", provider: "aws", name: "Staging", config: { region: "us-east-1" }, secretFields: [] }),
    ]);
    renderWithConnections(<ConnectionsSideBar />);
    await screen.findByRole("button", { name: "Add another AWS" });
    expect(screen.queryByRole("button", { name: "AWS: Staging" })).toBeNull();
  });
});
