import { KIND_LABELS } from "@theterminal/shared";
import type { Actor, LedgerEntry } from "@theterminal/shared";

const cap = (s: unknown) => {
  const t = String(s);
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function actorName(a: Actor): string {
  if (a.kind === "system") return a.id === "policy" ? "Policy" : "System";
  if (a.kind === "agent") return `Agent ${a.id.slice(0, 8)}`;
  return a.id === "owner" ? "Owner" : a.id;
}

const clip = (s: unknown, max: number) => {
  const t = String(s ?? "");
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** What a run was given for a cloud connection, by credential kind (never its value). */
const CREDENTIAL_LABELS: Record<string, string> = {
  aws_session_token: "a 12-hour AWS session token",
  aws_static_keys: "the AWS access keys (no session token available)",
  gcp_access_token: "a 1-hour Google Cloud token",
  azure_client_secret: "the Azure client secret",
};

export function describeEntry(e: LedgerEntry): string {
  const who = actorName(e.actor);
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "project.created":
      return `${who} created project "${p.name}"`;
    case "card.created":
      return `${who} added "${p.title}" to ${cap(p.stage)}`;
    case "card.moved":
      return `${who} moved a card from ${cap(p.from)} to ${cap(p.to)}`;
    case "card.status_changed":
      return `${who} marked a card ${p.to}`;
    case "agent.started":
      return `${who} started a ${cap(p.adapter)} agent: "${clip(p.prompt, 60)}"`;
    case "agent.action.requested":
      return `${who} wants to: ${p.summary}`;
    case "agent.action.decided": {
      const allowed = p.decision === "allow";
      const reason = typeof p.reason === "string" && p.reason ? p.reason : allowed ? "approved" : "rejected";
      return `${who} ${allowed ? "allowed" : "denied"}: ${reason}`;
    }
    case "agent.action.completed":
      return p.ok ? `${who} finished an action` : `${who} action failed`;
    case "agent.message":
      return `${who} said: "${clip(p.text, 80)}"`;
    case "agent.finished":
      return `Agent run ${p.status}`;
    case "agent.rate_limited": {
      const retry = typeof p.retryAfterS === "number" ? `; retry after ${p.retryAfterS} s` : "";
      return `Agent ${String(p.runId ?? "").slice(0, 8)} was rate-limited by the provider${retry}`;
    }
    case "settings.claude_auth_changed":
      return `${who} set Claude to use ${p.mode === "subscription" ? "own subscription" : "API key"}`;
    case "settings.provider_auth_changed": {
      const how =
        p.mode === "api_key"
          ? "API key"
          : p.mode === "chatgpt"
            ? "own ChatGPT plan"
            : p.mode === "google"
              ? "own Google account"
              : "own subscription";
      return `${who} set ${cap(p.provider)} to use ${how}`;
    }
    case "connection.added":
      return `${who} connected "${p.name}" (${KIND_LABELS[p.kind as keyof typeof KIND_LABELS] ?? String(p.kind)})`;
    case "connection.updated": {
      const c = (p.changes ?? {}) as { enabled?: boolean; secretsSet?: string[] };
      if (c.enabled === true) return `${who} enabled "${p.name}"`;
      if (c.enabled === false) return `${who} disabled "${p.name}"`;
      if (c.secretsSet && c.secretsSet.length > 0) return `${who} replaced the ${c.secretsSet.join(", ")} of "${p.name}"`;
      return `${who} updated "${p.name}"`;
    }
    case "connection.removed":
      return `${who} removed "${p.name}"`;
    case "connection.tested":
      return p.ok ? `"${p.name}" connected` : `"${p.name}" failed to connect: ${clip(p.message, 200)}`;
    case "connection.signin":
      return p.ok ? `${who} signed in to ${cap(p.provider)}` : `Sign-in to ${cap(p.provider)} failed`;
    case "connection.used": {
      const agent = `Agent ${String(p.runId).slice(0, 8)}`;
      if (p.purpose === "mcp_server") return `${agent} was given the MCP server "${p.name}"`;
      if (p.purpose === "cloud_credentials") {
        const label = CREDENTIAL_LABELS[String(p.credential)] ?? "cloud credentials";
        return `${agent} was given ${label} from "${p.name}"`;
      }
      return `${agent} was given access to "${p.name}"`;
    }
    default:
      return `${who} recorded ${e.type}`;
  }
}

export function LedgerPanel({ entries }: { entries: LedgerEntry[] }) {
  const newestFirst = [...entries].sort((a, b) => b.seq - a.seq);
  return (
    <aside className="ledger" aria-label="Ledger">
      <h2>Ledger</h2>
      <ul>
        {newestFirst.map((e) => (
          <li key={e.seq}>
            <time dateTime={e.ts}>{new Date(e.ts).toLocaleTimeString()}</time> · {describeEntry(e)}
          </li>
        ))}
      </ul>
    </aside>
  );
}
