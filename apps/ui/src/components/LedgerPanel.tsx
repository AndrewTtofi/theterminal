import type { Actor, LedgerEntry } from "@theterminal/shared";

const cap = (s: unknown) => {
  const t = String(s);
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function actorName(a: Actor): string {
  if (a.kind === "system") return "System";
  if (a.kind === "agent") return `Agent ${a.id}`;
  return a.id === "owner" ? "Owner" : a.id;
}

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
