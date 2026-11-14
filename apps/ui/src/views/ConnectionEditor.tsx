import { useId, useState } from "react";
import { PROVIDER_MODES } from "@theterminal/shared";
import type { CatalogEntry, Connection, ConnectionField, Provider } from "@theterminal/shared";
import { errorMessage } from "../api";
import type { ConnectionPatch, NewConnection } from "../api";
import { OWN_LABEL, PROVIDER_NAMES, ProviderModeSection } from "../components/ProviderAuthSettings";
import { SignInPanel } from "./SignInPanel";
import { useShell } from "../shell/model";

const KEYCHAIN_NOTE = "Stored in your operating system's keychain. Never written to files, the ledger or the API.";
const ENV_VARS: Record<Provider, string> = { claude: "ANTHROPIC_API_KEY", codex: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" };

/** "Claude (Anthropic)" → "Claude". */
const defaultName = (label: string) => label.replace(/\s*\(.*\)$/, "");

const isProvider = (p: string): p is Provider => p in ENV_VARS;

/** Non-empty values of `fields`, by field name. */
function collect(fields: ConnectionField[], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.name] ?? "";
    if (v !== "") out[f.name] = v;
  }
  return out;
}

const sameRecord = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

function StatusLine({ conn }: { conn: Connection | undefined }) {
  if (!conn) return <p className="connection-status">Not connected</p>;
  const { state, message, testedAt } = conn.status;
  const text = state === "ok" ? "Connected" : state === "failed" ? `Failed: ${message}` : "Not tested";
  return (
    <p className={`connection-status ${state}`}>
      <span>{text}</span>
      {testedAt && (
        <span className="muted">
          {" · tested "}
          <time dateTime={testedAt}>{new Date(testedAt).toLocaleString()}</time>
        </span>
      )}
    </p>
  );
}

function EditorForm({ panelId, entry, conn }: { panelId: string; entry: CatalogEntry; conn: Connection | undefined }) {
  const { model, dock } = useShell();
  const connections = model.connections;
  const uid = useId();
  const [name, setName] = useState(conn?.name ?? defaultName(entry.label));
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...conn?.config, ...conn?.private }));
  // Typed secrets live here only until the request settles; stored ones are never read back.
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [replacing, setReplacing] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  const fieldsOf = (storage: ConnectionField["storage"]) => entry.fields.filter((f) => f.storage === storage);
  const provider = isProvider(entry.provider) ? entry.provider : null;
  const info = model.agentsInfo;

  const act = async (task: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await task();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    act(async () => {
      const typed = collect(fieldsOf("secret"), secrets);
      const config = collect(fieldsOf("config"), values);
      try {
        if (!conn) {
          const body: NewConnection = { kind: entry.kind, provider: entry.provider, name: name.trim() };
          if (Object.keys(config).length > 0) body.config = config;
          if (Object.keys(typed).length > 0) body.secrets = typed;
          const priv = collect(fieldsOf("private"), values);
          if (Object.keys(priv).length > 0) body.private = priv;
          const created = await connections.add(body);
          // Swap the "new" tab for the connection's own tab.
          dock()?.open(`connection:${created.id}`, entry.label, "main");
          dock()?.close(panelId as `connection:${string}`);
          return;
        }
        const patch: ConnectionPatch = {};
        if (name.trim() !== conn.name) patch.name = name.trim();
        if (!sameRecord(config, conn.config)) patch.config = config;
        const priv: Record<string, string | null> = {};
        for (const f of fieldsOf("private")) {
          const v = values[f.name] ?? "";
          if (v !== (conn.private[f.name] ?? "")) priv[f.name] = v === "" ? null : v;
        }
        if (Object.keys(priv).length > 0) patch.private = priv;
        if (Object.keys(typed).length > 0) patch.secrets = typed;
        if (Object.keys(patch).length > 0) await connections.update(conn.id, patch);
      } finally {
        setSecrets({});
        setReplacing({});
      }
    });

  const test = () =>
    act(async () => {
      if (conn) await connections.test(conn.id);
    });

  const remove = () =>
    act(async () => {
      if (!conn) return;
      await connections.remove(conn.id);
      dock()?.close(panelId as `connection:${string}`);
    });

  const field = (f: ConnectionField) => {
    const id = `${uid}-${f.name}`;
    if (f.storage === "secret") {
      const stored = conn?.secretFields.includes(f.name) ?? false;
      const locked = stored && !replacing[f.name];
      return (
        <div key={f.name} className="connection-field">
          <label htmlFor={id}>{f.label}</label>
          <div className="secret-row">
            <input
              id={id}
              type="password"
              autoComplete="new-password"
              data-1p-ignore=""
              data-lpignore="true"
              spellCheck={false}
              value={secrets[f.name] ?? ""}
              placeholder={stored ? "Stored in your keychain" : ""}
              disabled={locked || busy}
              onChange={(e) => setSecrets((s) => ({ ...s, [f.name]: e.target.value }))}
            />
            {locked && (
              <button type="button" onClick={() => setReplacing((r) => ({ ...r, [f.name]: true }))}>
                Replace
              </button>
            )}
          </div>
          {f.help && <p className="field-help">{f.help}</p>}
          <p className="field-help">{KEYCHAIN_NOTE}</p>
        </div>
      );
    }
    return (
      <div key={f.name} className="connection-field">
        <label htmlFor={id}>{f.label}</label>
        <input
          id={id}
          type="text"
          spellCheck={false}
          value={values[f.name] ?? ""}
          disabled={busy}
          onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
        />
        {f.help && <p className="field-help">{f.help}</p>}
      </div>
    );
  };

  return (
    <form
      className="connection-editor"
      aria-label={entry.label}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2>{entry.label}</h2>
      <p className="muted">{entry.description}</p>
      <StatusLine conn={conn} />
      {!conn && provider && info?.providers[provider]?.apiKey === "environment" && (
        <p className="note">
          Using the {ENV_VARS[provider]} environment variable. Add a key here to manage it in your keychain.
        </p>
      )}
      <div className="connection-field">
        <label htmlFor={`${uid}-name`}>Name</label>
        <input id={`${uid}-name`} type="text" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
      </div>
      {provider && info && (
        <ProviderModeSection
          key={`${provider}:${info.providers[provider].mode}`}
          provider={provider}
          mode={info.providers[provider].mode}
          ack={info.acks[provider]}
          onChange={model.onProviderAuthChange}
        />
      )}
      {provider && info && (
        <div className="connection-field signin">
          {signingIn ? (
            <SignInPanel provider={provider} onClose={() => setSigningIn(false)} />
          ) : (
            <button type="button" onClick={() => setSigningIn(true)}>
              Sign in
            </button>
          )}
          <p className="field-help">For "{OWN_LABEL[PROVIDER_MODES[provider][1]]}": sign in with {PROVIDER_NAMES[provider]}'s own login.</p>
        </div>
      )}
      {entry.fields.map(field)}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="connection-actions">
        <button type="submit" disabled={busy || name.trim() === ""}>
          Save
        </button>
        {conn && (
          <button type="button" disabled={busy} onClick={() => void test()}>
            Test connection
          </button>
        )}
        {conn && !confirmRemove && (
          <button type="button" className="danger" disabled={busy} onClick={() => setConfirmRemove(true)}>
            Remove connection
          </button>
        )}
      </div>
      {conn && confirmRemove && (
        <div className="confirm" role="group" aria-label="Confirm removal">
          <p>Remove "{conn.name}"? Agents lose access to it. Its stored values are deleted from your keychain.</p>
          <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
            Remove
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>
            Cancel
          </button>
        </div>
      )}
    </form>
  );
}

/** Editor tab for `connection:<id>` or `connection:new:<provider>`. */
export function ConnectionEditor({ id }: { id: string }) {
  const { model } = useShell();
  const { catalog, list, loaded } = model.connections;
  const rest = id.slice("connection:".length);
  const newProvider = rest.startsWith("new:") ? rest.slice("new:".length) : null;

  let conn: Connection | undefined;
  let entry: CatalogEntry | undefined;
  if (newProvider) {
    entry = catalog.find((e) => e.provider === newProvider);
    // A single-connection provider that is already connected edits that connection.
    if (entry?.single) conn = list.find((c) => c.provider === newProvider);
  } else {
    conn = list.find((c) => c.id === rest);
    entry = conn && catalog.find((e) => e.provider === conn!.provider);
  }

  if (!entry || !entry.available) {
    return <p className="muted">{!newProvider && !loaded ? "Loading…" : "This connection no longer exists."}</p>;
  }
  return <EditorForm key={conn?.id ?? "new"} panelId={id} entry={entry} conn={conn} />;
}
