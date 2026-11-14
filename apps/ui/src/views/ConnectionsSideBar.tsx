import { useState } from "react";
import type { CatalogEntry, Connection, ConnectionKind } from "@theterminal/shared";
import { errorMessage } from "../api";
import { useShell } from "../shell/model";

const GROUPS: { kind: ConnectionKind; title: string }[] = [
  { kind: "llm", title: "AI models" },
  { kind: "github", title: "Code hosting" },
  { kind: "cloud", title: "Cloud accounts" },
  { kind: "mcp", title: "Tools (MCP)" },
  { kind: "hardware", title: "Hardware" },
];

const DOT_LABEL = { untested: "Not tested", ok: "Connected", failed: "Failed" } as const;

/** The editor tab for a catalog entry: its connection's, or a new one. */
export const editorPanelId = (entry: CatalogEntry, conn: Connection | undefined) =>
  conn ? (`connection:${conn.id}` as const) : (`connection:new:${entry.provider}` as const);

function matches(entry: CatalogEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || entry.label.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q);
}

/** Extensions-style list of every connection the catalog offers, grouped by kind. */
export function ConnectionsSideBar() {
  const { model, dock } = useShell();
  const { catalog, list, update } = model.connections;
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const groups = GROUPS.map((g) => ({ ...g, entries: catalog.filter((e) => e.kind === g.kind && matches(e, query)) })).filter(
    (g) => g.entries.length > 0,
  );

  const toggle = (conn: Connection) => {
    setError(null);
    update(conn.id, { enabled: !conn.enabled }).catch((e: unknown) => setError(errorMessage(e)));
  };

  return (
    <div className="connections-side">
      <input
        type="search"
        className="connections-search"
        aria-label="Search connections"
        placeholder="Search connections"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {groups.length === 0 && <p className="muted">No connections match.</p>}
      {groups.map((g) => (
        <section key={g.kind} className="side-group" aria-label={g.title}>
          <h3>{g.title}</h3>
          <ul>
            {g.entries.map((entry) => {
              const conn = entry.available ? list.find((c) => c.provider === entry.provider) : undefined;
              const state = conn ? conn.status.state : "not-connected";
              return (
                <li
                  key={entry.provider}
                  className={`connection-row${entry.available ? "" : " unavailable"}`}
                  aria-disabled={entry.available ? undefined : true}
                >
                  <button
                    type="button"
                    className="connection-open"
                    disabled={!entry.available}
                    title={entry.description}
                    onClick={() => dock()?.open(editorPanelId(entry, conn), entry.label, "main")}
                  >
                    <span
                      className={`status-dot ${state}`}
                      role="img"
                      aria-label={conn ? DOT_LABEL[conn.status.state] : "Not connected"}
                    />
                    <span className="connection-text">
                      <span className="connection-label">{entry.label}</span>
                      <span className="connection-note">{entry.available ? entry.description : "Arrives with Plan 5B"}</span>
                    </span>
                  </button>
                  {conn && (
                    <button
                      type="button"
                      role="switch"
                      className="switch"
                      aria-checked={conn.enabled}
                      aria-label={`Enable ${entry.label}`}
                      onClick={() => toggle(conn)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
