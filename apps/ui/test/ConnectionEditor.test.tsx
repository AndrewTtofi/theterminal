import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
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
      getCapacity: vi.fn(),
    },
  };
});

import { api, ApiError } from "../src/api";
import { ConnectionEditor } from "../src/views/ConnectionEditor";
import type { Status } from "../src/api";
import { AGENTS, connection, renderWithConnections } from "./connections-harness";
import { localEngines, report } from "./capacity-fixtures";

const m = vi.mocked(api);
const KEY = "sk-ant-TESTKEY-0000000000";
const KEYCHAIN_NOTE = "Stored in your operating system's keychain. Never written to files, the ledger or the API.";

beforeEach(() => {
  vi.clearAllMocks();
  m.listConnections.mockResolvedValue([]);
  m.getConnectionCatalog.mockResolvedValue([...CONNECTION_CATALOG]);
});

const keyInput = () => screen.getByLabelText("API key") as HTMLInputElement;

describe("ConnectionEditor", () => {
  it("a new Claude connection posts the key once, then shows it as stored and never echoes it", async () => {
    m.addConnection.mockResolvedValue(connection());
    const { dock, container } = renderWithConnections(<ConnectionEditor id="connection:new:claude" />);
    await waitFor(() => expect(m.listConnections).toHaveBeenCalled());

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Claude");
    expect(screen.getByRole("group", { name: "Claude sign-in" })).toBeTruthy();
    expect(screen.getByText(KEYCHAIN_NOTE)).toBeTruthy();
    expect(keyInput().type).toBe("password");
    expect(keyInput().getAttribute("autocomplete")).toBe("new-password");
    expect(keyInput().hasAttribute("data-1p-ignore")).toBe(true);
    expect(keyInput().getAttribute("data-lpignore")).toBe("true");
    expect(screen.getByText("Not connected")).toBeTruthy();

    await userEvent.type(keyInput(), KEY);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(m.addConnection).toHaveBeenCalledTimes(1);
    expect(m.addConnection).toHaveBeenCalledWith({ kind: "llm", provider: "claude", name: "Claude", secrets: { apiKey: KEY } });
    await waitFor(() => expect(keyInput().placeholder).toBe("Stored in your keychain"));
    expect(keyInput().value).toBe("");
    expect(container.innerHTML).not.toContain(KEY);
    expect(dock.open).toHaveBeenCalledWith("connection:c1", "Claude (Anthropic)", "main");
    expect(dock.close).toHaveBeenCalledWith("connection:new:claude");
  });

  it("names the server's encrypted secret store instead of the keychain when the server keeps secrets in a file", async () => {
    m.listConnections.mockResolvedValue([connection()]);
    const status = { connections: { enabled: 1, failed: 0, keychain: "ok", secretStore: "file" } } as unknown as Status;
    const { container } = renderWithConnections(<ConnectionEditor id="connection:c1" />, { status });
    await waitFor(() => expect(keyInput().placeholder).toBe("Stored in this server's encrypted secret store"));
    expect(container.textContent).not.toContain("keychain");
  });

  it("shows anyone but the Owner the Owner-only line and no form", async () => {
    m.listConnections.mockResolvedValue([connection()]);
    const me = { personId: "m1", name: "M", role: "maintainer", listener: "remote", method: "key", credentials: [], sessions: [] } as const;
    renderWithConnections(<ConnectionEditor id="connection:c1" />, { me: { ...me, credentials: [], sessions: [] } });
    await waitFor(() => expect(m.listConnections).toHaveBeenCalled());
    expect(await screen.findByText(/Only the Owner/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("Replace edits a stored secret and sends only the new value", async () => {
    m.listConnections.mockResolvedValue([connection()]);
    m.updateConnection.mockResolvedValue(connection());
    renderWithConnections(<ConnectionEditor id="connection:c1" />);
    await waitFor(() => expect(keyInput().placeholder).toBe("Stored in your keychain"));
    expect(keyInput().value).toBe("");
    expect(keyInput().disabled).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(keyInput().disabled).toBe(false);
    await userEvent.type(keyInput(), "sk-ant-TESTKEY-1111111111");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(m.updateConnection).toHaveBeenCalledWith("c1", { secrets: { apiKey: "sk-ant-TESTKEY-1111111111" } });
    await waitFor(() => expect(keyInput().disabled).toBe(true));
    expect(keyInput().value).toBe("");
  });

  it("Test connection shows Connected, then the failure message", async () => {
    m.listConnections.mockResolvedValue([connection()]);
    m.testConnection
      .mockResolvedValueOnce({ ok: true, message: "Connected" })
      .mockResolvedValueOnce({ ok: false, message: "Rejected by the provider (HTTP 401)" });
    renderWithConnections(<ConnectionEditor id="connection:c1" />);
    expect(await screen.findByText("Not tested")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(m.testConnection).toHaveBeenCalledWith("c1");
    expect(await screen.findByText("Connected")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Failed: Rejected by the provider (HTTP 401)")).toBeTruthy();
  });

  it("Remove connection asks to confirm, removes it and closes the tab", async () => {
    m.listConnections.mockResolvedValue([connection()]);
    m.removeConnection.mockResolvedValue(undefined);
    const { dock } = renderWithConnections(<ConnectionEditor id="connection:c1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove connection" }));
    expect(m.removeConnection).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(m.removeConnection).toHaveBeenCalledWith("c1");
    await waitFor(() => expect(dock.close).toHaveBeenCalledWith("connection:c1"));
  });

  it("a 503 shows the keychain message and clears the typed key", async () => {
    m.addConnection.mockRejectedValue(new ApiError(503, "keychain_unavailable"));
    renderWithConnections(<ConnectionEditor id="connection:new:claude" />);
    await userEvent.type(keyInput(), KEY);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Your keychain is unavailable. Nothing was saved.");
    expect(keyInput().value).toBe("");
  });

  it("a 409 shows Already connected", async () => {
    m.addConnection.mockRejectedValue(new ApiError(409, "conflict"));
    renderWithConnections(<ConnectionEditor id="connection:new:claude" />);
    await userEvent.type(keyInput(), KEY);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Already connected");
  });

  it("trims the name of a new connection", async () => {
    m.addConnection.mockResolvedValue(connection({ name: "Work" }));
    renderWithConnections(<ConnectionEditor id="connection:new:claude" />);
    await waitFor(() => expect(m.listConnections).toHaveBeenCalled());
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "  Work ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(m.addConnection).toHaveBeenCalledWith({ kind: "llm", provider: "claude", name: "Work" });
  });

  it("a key pasted into a config field is refused with its own message", async () => {
    m.addConnection.mockRejectedValue(new ApiError(400, "secret_in_config"));
    renderWithConnections(<ConnectionEditor id="connection:new:gemini" />);
    await userEvent.type(screen.getByLabelText("Google Cloud project"), "sk-TESTKEY");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(m.addConnection).toHaveBeenCalledWith({
      kind: "llm", provider: "gemini", name: "Gemini", config: { googleCloudProject: "sk-TESTKEY" },
    });
    expect((await screen.findByRole("alert")).textContent).toBe("That field must not contain a key or token");
  });

  it("private path fields are plain inputs with their help text, sent as private values", async () => {
    m.listConnections.mockResolvedValue([
      connection({ id: "c2", provider: "codex", name: "Codex", secretFields: [], private: { cliHome: "codex-home" } }),
    ]);
    m.updateConnection.mockResolvedValue(connection({ id: "c2", provider: "codex", name: "Codex", secretFields: [] }));
    renderWithConnections(<ConnectionEditor id="connection:c2" />);
    const home = (await screen.findByLabelText("CLI home folder")) as HTMLInputElement;
    expect(home.type).toBe("text");
    expect(home.value).toBe("codex-home");
    expect(screen.getByText(/the folder where your Codex login lives \(CODEX_HOME\)/)).toBeTruthy();
    expect(keyInput().placeholder).toBe("");
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();

    await userEvent.clear(home);
    await userEvent.type(home, "other-home");
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "  My Codex  ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(m.updateConnection).toHaveBeenCalledWith("c2", { name: "My Codex", private: { cliHome: "other-home" } });
  });

  it("names the environment variable in use when there is no connection", async () => {
    renderWithConnections(<ConnectionEditor id="connection:new:claude" />, {
      agentsInfo: { ...AGENTS, providers: { ...AGENTS.providers, claude: { mode: "api_key", available: true, apiKey: "environment" } } },
    });
    expect(
      await screen.findByText("Using the ANTHROPIC_API_KEY environment variable. Add a key here to manage it in your keychain."),
    ).toBeTruthy();
  });

  it("changing the sign-in mode goes through the provider auth change with the acknowledgement", async () => {
    const onProviderAuthChange = vi.fn().mockResolvedValue(true);
    renderWithConnections(<ConnectionEditor id="connection:new:codex" />, { onProviderAuthChange });
    const group = within(screen.getByRole("group", { name: "Codex sign-in" }));
    await userEvent.click(group.getByLabelText("My own ChatGPT plan"));
    await userEvent.click(group.getByLabelText("I understand and accept this risk"));
    await userEvent.click(group.getByRole("button", { name: "Confirm" }));
    expect(onProviderAuthChange).toHaveBeenCalledWith("codex", "chatgpt", "Example codex warning.");
  });

  it.each([
    ["claude", "Claude", "Signing in with your own Claude plan is turned off until Anthropic allows it. Use an API key."],
    ["gemini", "Gemini", "Signing in with your own Google account is turned off: Google doesn't allow other apps to use Gemini CLI's Google sign-in. Use an API key."],
  ] as const)("%s with its own-plan sign-in turned off: no own-plan choice and no Sign in button, one plain line instead", (provider, name, line) => {
    const providers = { ...AGENTS.providers, [provider]: { mode: "api_key", available: true, apiKey: "none", ownModeAvailable: false } };
    renderWithConnections(<ConnectionEditor id={`connection:new:${provider}`} />, { agentsInfo: { ...AGENTS, providers } });
    const group = within(screen.getByRole("group", { name: `${name} sign-in` }));
    expect(group.getByText(line)).toBeTruthy();
    expect(group.getAllByRole("radio")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByText(/sign in with .*'s own login/)).toBeNull();
  });

  it.each(["claude", "codex", "gemini"] as const)("%s with its own-plan sign-in allowed keeps the choice and the Sign in button", (provider) => {
    const providers = { ...AGENTS.providers, [provider]: { mode: "api_key", available: true, apiKey: "none", ownModeAvailable: true } };
    renderWithConnections(<ConnectionEditor id={`connection:new:${provider}`} />, { agentsInfo: { ...AGENTS, providers } });
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText(/turned off/)).toBeNull();
  });

  it("a GitHub token field shows its help and no sign-in section", () => {
    renderWithConnections(<ConnectionEditor id="connection:new:github" />);
    const token = screen.getByLabelText("Personal access token") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(screen.getByText(/fine-grained personal access token/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: /sign-in/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  });

  it("a number field renders as a number input", async () => {
    renderWithConnections(<ConnectionEditor id="connection:new:claude" />);
    const budget = (await screen.findByLabelText("Monthly budget (USD)")) as HTMLInputElement;
    expect(budget.type).toBe("number");
    expect(budget.min).toBe("0");
    expect(budget.step).toBe("0.01");
    expect(screen.getByText("Capacity shows this month's spend against it.")).toBeTruthy();
  });

  it("a multiline secret is a textarea, empty with the keychain placeholder and Replace once stored", async () => {
    const gcp = connection({ id: "g1", kind: "cloud", provider: "gcp", name: "Google Cloud", config: { project: "demo-project" }, secretFields: ["serviceAccountJson"] });
    m.listConnections.mockResolvedValue([gcp]);
    m.updateConnection.mockResolvedValue(gcp);
    renderWithConnections(<ConnectionEditor id="connection:g1" />);
    const json = (await screen.findByLabelText("Service account key (JSON)")) as HTMLTextAreaElement;
    expect(json.tagName).toBe("TEXTAREA");
    expect(json.rows).toBe(4);
    await waitFor(() => expect(json.placeholder).toBe("Stored in your keychain"));
    expect(json.value).toBe("");
    expect(json.disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(json.disabled).toBe(false);
    await userEvent.type(json, "{{}");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(m.updateConnection).toHaveBeenCalledWith("g1", { secrets: { serviceAccountJson: "{}" } });
  });

  it("a private multiline field is a textarea sent as a private value", async () => {
    m.addConnection.mockResolvedValue(connection({ id: "m1", kind: "mcp", provider: "mcp_stdio", secretFields: [] }));
    renderWithConnections(<ConnectionEditor id="connection:new:mcp_stdio" />);
    const args = (await screen.findByLabelText("Arguments")) as HTMLTextAreaElement;
    expect(args.tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("Environment variables").tagName).toBe("TEXTAREA");
    await userEvent.type(screen.getByLabelText("Command"), "npx");
    await userEvent.type(args, "-y{enter}example-server");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(m.addConnection).toHaveBeenCalledWith({
      kind: "mcp", provider: "mcp_stdio", name: "MCP server", private: { command: "npx", args: "-y\nexample-server" },
    });
  });

  it.each(["mcp_stdio", "mcp_http"])("the %s editor says Codex and Gemini cannot use MCP servers yet", async (provider) => {
    renderWithConnections(<ConnectionEditor id={`connection:new:${provider}`} />);
    expect(
      await screen.findByText("Codex cannot use MCP servers in The Terminal yet: Codex gives no approval step for MCP tool calls under its strict policy."),
    ).toBeTruthy();
    expect(screen.getByText("Gemini cannot use MCP servers in The Terminal yet: Gemini only starts MCP servers in a trusted folder, and The Terminal never trusts agent worktrees.")).toBeTruthy();
  });

  it("other editors carry no Codex MCP note", async () => {
    renderWithConnections(<ConnectionEditor id="connection:new:claude" />);
    await screen.findByLabelText("Name");
    expect(screen.queryByText(/Codex cannot use MCP servers/)).toBeNull();
    expect(screen.queryByText(/Gemini cannot use MCP servers/)).toBeNull();
  });

  it("This computer shows its detected values read-only, with the detection note and no Save", async () => {
    const hw = connection({ id: "h1", kind: "hardware", provider: "local_hardware", name: "This computer", config: { cores: "8" }, secretFields: [] });
    m.listConnections.mockResolvedValue([hw]);
    renderWithConnections(<ConnectionEditor id="connection:h1" />);
    const cores = (await screen.findByLabelText("Cores")) as HTMLInputElement;
    expect(cores.value).toBe("8");
    expect(cores.readOnly).toBe(true);
    expect(screen.getByText("Filled in by detection. Use Detect this computer in the Capacity view.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove connection" })).toBeTruthy();
  });

  it("a refused connection shows its own message", async () => {
    m.addConnection.mockRejectedValue(new ApiError(400, "connection_unsupported"));
    renderWithConnections(<ConnectionEditor id="connection:new:claude" />);
    await userEvent.type(keyInput(), KEY);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This connection cannot be used that way");
  });

  describe("a local model", () => {
    it("lists the model servers detected on this computer, and Use fills the server URL and the model", async () => {
      m.getCapacity.mockResolvedValue(report({ localModels: localEngines }));
      m.addConnection.mockResolvedValue(connection({ id: "lm1", provider: "local_model", name: "Local model" }));
      renderWithConnections(<ConnectionEditor id="connection:new:local_model" />);
      const found = await screen.findByRole("region", { name: "Detected on this computer" });
      expect(m.getCapacity).toHaveBeenCalledTimes(1);
      const items = within(found).getAllByRole("listitem").map((li) => li.textContent);
      expect(items).toEqual(["qwen2.5-coder:14bUse", "llama3.2:3bUse", "gpt-oss-20bUse"]);
      expect(within(found).getByText("Ollama 0.12.3")).toBeTruthy();
      expect(within(found).getByText("llama.cpp")).toBeTruthy();

      await userEvent.click(within(found).getByRole("button", { name: "Use gpt-oss-20b" }));
      expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("http://127.0.0.1:8080/v1");
      expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("gpt-oss-20b");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(m.addConnection).toHaveBeenCalledWith({
        kind: "llm", provider: "local_model", name: "Local model", config: { baseUrl: "http://127.0.0.1:8080/v1", model: "gpt-oss-20b" },
      });
    });

    it("says when no model server was detected", async () => {
      m.getCapacity.mockResolvedValue(report());
      renderWithConnections(<ConnectionEditor id="connection:new:local_model" />);
      const found = await screen.findByRole("region", { name: "Detected on this computer" });
      await waitFor(() => expect(found.textContent).toContain("No local model server detected. Install Ollama or llama.cpp server and detect again."));
    });

    it("never asks for capacity in another provider's editor", async () => {
      renderWithConnections(<ConnectionEditor id="connection:new:claude" />);
      await waitFor(() => expect(m.listConnections).toHaveBeenCalled());
      expect(m.getCapacity).not.toHaveBeenCalled();
      expect(screen.queryByRole("region", { name: "Detected on this computer" })).toBeNull();
    });
  });
});
