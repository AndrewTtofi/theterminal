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
    },
  };
});

import { api, ApiError } from "../src/api";
import { ConnectionEditor } from "../src/views/ConnectionEditor";
import { AGENTS, connection, renderWithConnections } from "./connections-harness";

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
    expect(keyInput().getAttribute("autocomplete")).toBe("off");
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
    await userEvent.type(screen.getByLabelText("Name"), "My Codex");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(m.updateConnection).toHaveBeenCalledWith("c2", { name: "My Codex", private: { cliHome: "other-home" } });
  });

  it("names the environment variable in use when there is no connection", async () => {
    renderWithConnections(<ConnectionEditor id="connection:new:claude" />, {
      agentsInfo: { ...AGENTS, providers: { ...AGENTS.providers, claude: { mode: "api_key", installed: true, apiKey: "environment" } } },
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

  it("a GitHub token field shows its help and no sign-in section", () => {
    renderWithConnections(<ConnectionEditor id="connection:new:github" />);
    const token = screen.getByLabelText("Personal access token") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(screen.getByText(/fine-grained personal access token/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: /sign-in/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  });
});
