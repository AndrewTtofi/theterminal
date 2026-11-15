import { Fragment, useId, useState } from "react";
import { isConnectionSummary, visibleControls } from "@theterminal/shared";
import type { CatalogEntry, Connection, ConnectionKind, ConnectionSummary, Role } from "@theterminal/shared";
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
/** What a collaborator is told in place of the editor: the Owner alone holds the details. */
export const OWNER_ONLY_NOTE = "Only the Owner can see or change connection details.";

/** The editor tab for a catalog entry: its connection's, or a new one. */
export const editorPanelId = (entry: CatalogEntry, conn: { id: string } | undefined) =>
  conn ? (`connection:${conn.id}` as const) : (`connection:new:${entry.provider}` as const);

function matches(entry: CatalogEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || entry.label.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q);
}

/**
 * Extensions-style list of every connection the catalog offers, grouped by kind. For the Owner each row opens its
 * editor and has its switch; for anyone else (`viewer` below the Owner, or a list of summaries) the rows are read-only
 * and say so once, and no editor tab is ever opened.
 */
export function ConnectionsSideBar({ viewer }: { viewer?: { role: Role } } = {}) {
  const { model, dock } = useShell();
  const { catalog, list, loaded, loadError, refresh, update } = model.connections;
  const uid = useId();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<ReadonlySet<string>>(() => new Set());
  const readOnly = (viewer !== undefined && viewer.role !== "owner") || list.some(isConnectionSummary);

  const groups = GROUPS.map((g) => ({ ...g, entries: catalog.filter((e) => e.kind === g.kind && matches(e, query)) })).filter(
    (g) => g.entries.length > 0,
  );

  const toggle = (conn: Connection | ConnectionSummary) => {
    setError(null);
    setToggling((s) => new Set(s).add(conn.id));
    update(conn.id, { enabled: !conn.enabled })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() =>
        setToggling((s) => {
          const next = new Set(s);
          next.delete(conn.id);
          return next;
        }),
      );
  };

  const toggleSwitch = (conn: Connection | ConnectionSummary, label: string) => (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={conn.enabled}
      aria-label={`Enable ${label}`}
      disabled={!loaded || toggling.has(conn.id)}
      onClick={() => toggle(conn)}
    />
  );

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
      {loadError && (
        <div className="error" role="alert">
          Couldn't load connections
          <button type="button" onClick={refresh}>
            Retry
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {readOnly && <p className="muted connections-owner-only">{OWNER_ONLY_NOTE}</p>}
      {groups.length === 0 && <p className="muted">No connections match.</p>}
      {groups.map((g) => (
        <section key={g.kind} className="side-group" aria-label={g.title}>
          <h3>{g.title}</h3>
          <ul>
            {g.entries.map((entry) => {
              const conns = entry.available ? list.filter((c) => c.provider === entry.provider) : [];
              const conn = conns[0];
              const state = conn ? conn.status.state : "not-connected";
              const statusId = `${uid}-${entry.provider}-status`;
              const noteId = `${uid}-${entry.provider}-note`;
              const row = (
                <>
                  <span className={`status-dot ${state}`} aria-hidden="true" />
                  <span id={statusId} className="visually-hidden">
                    {conn ? DOT_LABEL[conn.status.state] : "Not connected"}
                  </span>
                  <span className="connection-text">
                    <span className="connection-label">{entry.label}</span>
                    <span id={noteId} className="connection-note">
                      {entry.available ? entry.description : "Arrives in a later release"}
                    </span>
                  </span>
                </>
              );
              return (
                <Fragment key={entry.provider}>
                  <li
                    className={`connection-row${entry.available ? "" : " unavailable"}`}
                    aria-disabled={entry.available ? undefined : true}
                  >
                    {readOnly ? (
                      <div className="connection-open" aria-describedby={`${statusId} ${noteId}`}>
                        {row}
                      </div>
                    ) : (
                      /* Until the list has loaded, a row cannot know whether to open a new or an existing tab. */
                      <button
                        type="button"
                        className="connection-open"
                        aria-label={entry.label}
                        aria-describedby={`${statusId} ${noteId}`}
                        disabled={!entry.available || !loaded}
                        onClick={() => dock()?.open(editorPanelId(entry, conn), entry.label, "main")}
                      >
                        {row}
                      </button>
                    )}
                    {!readOnly && conn && !entry.single && (
                      <button
                        type="button"
                        className="connection-add"
                        aria-label={`Add another ${entry.label}`}
                        disabled={!loaded}
                        onClick={() => dock()?.open(`connection:new:${entry.provider}`, entry.label, "main")}
                      >
                        Add another
                      </button>
                    )}
                    {!readOnly && conn && toggleSwitch(conn, entry.label)}
                  </li>
                  {/* A provider with several connections lists each one, so every one can be opened. */}
                  {conns.length > 1 &&
                    conns.map((c) => {
                      const name = visibleControls(c.name);
                      const label = `${entry.label}: ${name}`;
                      const inner = (
                        <>
                          <span className={`status-dot ${c.status.state}`} aria-hidden="true" />
                          <span id={`${uid}-${c.id}-status`} className="visually-hidden">
                            {DOT_LABEL[c.status.state]}
                          </span>
                          <span className="connection-text">
                            <span className="connection-label">{name}</span>
                          </span>
                        </>
                      );
                      return (
                        <li key={c.id} className="connection-row nested">
                          {readOnly ? (
                            <div className="connection-open" aria-describedby={`${uid}-${c.id}-status`}>
                              {inner}
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="connection-open"
                              aria-label={label}
                              aria-describedby={`${uid}-${c.id}-status`}
                              disabled={!loaded}
                              onClick={() => dock()?.open(`connection:${c.id}`, c.name, "main")}
                            >
                              {inner}
                            </button>
                          )}
                          {!readOnly && toggleSwitch(c, label)}
                        </li>
                      );
                    })}
                </Fragment>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
