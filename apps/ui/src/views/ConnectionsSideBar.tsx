import { ProviderAuthSettings } from "../components/ProviderAuthSettings";
import { useShell } from "../shell/model";

type Row = { label: string; description: string; available: boolean };

// Read-only until the connections API lands; the live list comes from the catalog endpoint.
const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: "AI models",
    rows: [
      { label: "Claude (Anthropic)", description: "API key or your own Claude subscription", available: true },
      { label: "Codex (OpenAI)", description: "API key or your own ChatGPT plan", available: true },
      { label: "Gemini (Google)", description: "API key or your own Google account", available: true },
    ],
  },
  { title: "Code hosting", rows: [{ label: "GitHub", description: "Repositories, pull requests and CI", available: true }] },
  {
    title: "Cloud accounts",
    rows: [
      { label: "Amazon Web Services", description: "Scoped cloud credentials", available: false },
      { label: "Google Cloud", description: "Scoped cloud credentials", available: false },
      { label: "Microsoft Azure", description: "Scoped cloud credentials", available: false },
    ],
  },
  {
    title: "Tools (MCP)",
    rows: [
      { label: "MCP server (local)", description: "A tool server started on this machine", available: false },
      { label: "MCP server (remote)", description: "A tool server reached over HTTP", available: false },
    ],
  },
  { title: "Hardware", rows: [{ label: "This computer", description: "Local GPUs and capacity", available: false }] },
];

export function ConnectionsSideBar() {
  const { model } = useShell();
  const info = model.agentsInfo;
  return (
    <div className="connections-side">
      {GROUPS.map((g) => (
        <section key={g.title} className="side-group" aria-label={g.title}>
          <h3>{g.title}</h3>
          <ul>
            {g.rows.map((r) => (
              <li key={r.label} className={`connection-row${r.available ? "" : " unavailable"}`} aria-disabled={!r.available} title={r.description}>
                <span className="status-dot not-connected" aria-hidden="true" />
                <span className="connection-text">
                  <span className="connection-label">{r.label}</span>
                  <span className="connection-note">{r.available ? "Not connected" : "Arrives with Plan 5B"}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {info && (
        <ProviderAuthSettings
          modes={{ claude: info.providers.claude.mode, codex: info.providers.codex.mode, gemini: info.providers.gemini.mode }}
          acks={info.acks}
          onChange={model.onProviderAuthChange}
        />
      )}
    </div>
  );
}
