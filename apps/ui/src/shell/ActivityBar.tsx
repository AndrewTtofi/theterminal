import type { ReactNode } from "react";
import { VIEWS, VIEW_LABELS } from "./views";
import type { ViewId } from "./views";

type Props = {
  active: ViewId | null;
  /** Running agent runs, badged on Agents. */
  running: number;
  /** Pending decisions and open plan decisions, badged on Needs you. */
  pending: number;
  onSelect: (view: ViewId) => void;
};

const svg = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

const ICONS: Record<ViewId, ReactNode> = {
  board: svg(<><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="11" rx="1" /><rect x="17" y="4" width="4" height="7" rx="1" /></>),
  agents: svg(<><rect x="5" y="8" width="14" height="11" rx="2" /><path d="M12 8V4M9 13h.01M15 13h.01M9.5 16h5" /></>),
  changes: svg(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M12 7v6M9 10h6M9 17h6" /></>),
  needs_you: svg(<><path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7" /><path d="M10 19a2 2 0 0 0 4 0" /></>),
  ledger: svg(<><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v4h4M9 11h7M9 15h7M9 19h4" /></>),
  connections: svg(<><path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0z" /><path d="M12 16v5" /></>),
  github: svg(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="9" r="2" /><path d="M6 7v10M18 11c0 4-6 3-11 6.5" /></>),
  capacity: svg(<><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>),
  machines: svg(<><rect x="2" y="4" width="9" height="7" rx="1" /><rect x="13" y="13" width="9" height="7" rx="1" /><path d="M6.5 11v3h6.5M17.5 13v-3H11" /></>),
  share: svg(<><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="M8.2 10.8l7.6-4.6M8.2 13.2l7.6 4.6" /></>),
  learn: svg(<><path d="M12 6C10 4.5 7 4 3 4v14c4 0 7 .5 9 2 2-1.5 5-2 9-2V4c-4 0-7 .5-9 2z" /><path d="M12 6v14" /></>),
};

const BADGES: Partial<Record<ViewId, keyof Pick<Props, "running" | "pending">>> = { agents: "running", needs_you: "pending" };

export function ActivityBar({ active, running, pending, onSelect }: Props) {
  const counts = { running, pending };
  return (
    <nav className="activity-bar" aria-label="Views">
      {VIEWS.map((v) => {
        const badgeOf = BADGES[v];
        const count = badgeOf ? counts[badgeOf] : 0;
        return (
          <button
            key={v}
            type="button"
            className={v === active ? "active" : ""}
            aria-label={VIEW_LABELS[v]}
            aria-pressed={v === active}
            title={count > 0 ? `${VIEW_LABELS[v]} (${count})` : VIEW_LABELS[v]}
            onClick={() => onSelect(v)}
          >
            {ICONS[v]}
            {count > 0 && (
              <span className={`badge badge-${v}`} aria-hidden="true">
                {count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
