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
    case "settings.claude_auth_changed":
      return `${who} set Claude to use ${p.mode === "subscription" ? "own subscription" : "API key"}`;
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
