import type { ReactNode } from "react";
import { VIEWS, VIEW_LABELS } from "./views";
import { useWorkspace } from "./workspace-store";
import type { ActivityViewId, ViewId } from "./views";

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

const ICONS: Record<ActivityViewId, ReactNode> = {
  home: svg(<><path d="M4 11l8-7 8 7" /><path d="M6 10v10h12V10" /><path d="M10 20v-6h4v6" /></>),
  board: svg(<><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="11" rx="1" /><rect x="17" y="4" width="4" height="7" rx="1" /></>),
  agents: svg(<><rect x="5" y="8" width="14" height="11" rx="2" /><path d="M12 8V4M9 13h.01M15 13h.01M9.5 16h5" /></>),
  changes: svg(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M12 7v6M9 10h6M9 17h6" /></>),
  needs_you: svg(<><path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7" /><path d="M10 19a2 2 0 0 0 4 0" /></>),
  ledger: svg(<><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v4h4M9 11h7M9 15h7M9 19h4" /></>),
  connections: svg(<><path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0z" /><path d="M12 16v5" /></>),
  github: svg(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="9" r="2" /><path d="M6 7v10M18 11c0 4-6 3-11 6.5" /></>),
  capacity: svg(<><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>),
  machines: svg(<><rect x="2" y="4" width="9" height="7" rx="1" /><rect x="13" y="13" width="9" height="7" rx="1" /><path d="M6.5 11v3h6.5M17.5 13v-3H11" /></>),
  people: svg(<><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17" cy="9" r="2.5" /><path d="M17 14c2.5 0 4.5 2 4.5 5" /></>),
  share: svg(<><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="M8.2 10.8l7.6-4.6M8.2 13.2l7.6 4.6" /></>),
  learn: svg(<><path d="M12 6C10 4.5 7 4 3 4v14c4 0 7 .5 9 2 2-1.5 5-2 9-2V4c-4 0-7 .5-9 2z" /><path d="M12 6v14" /></>),
};

const GEAR = svg(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </>,
);

const BADGES: Partial<Record<ActivityViewId, keyof Pick<Props, "running" | "pending">>> = { agents: "running", needs_you: "pending" };

export function ActivityBar({ active, running, pending, onSelect }: Props) {
  const counts = { running, pending };
  const { showBoard } = useWorkspace();
  return (
    <div className="activity-bar">
      <nav className="activity-views" aria-label="Views">
        {VIEWS.filter((v) => v !== "board" || showBoard).map((v) => {
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
                <span className={`badge badge-${v} num`} aria-hidden="true">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      {/* Pinned to the bottom, outside the views, like VS Code's Manage gear. */}
      <div className="activity-manage">
        <button
          type="button"
          className={active === "settings" ? "active" : ""}
          aria-label="Settings"
          aria-pressed={active === "settings"}
          title="Settings"
          onClick={() => onSelect("settings")}
        >
          {GEAR}
        </button>
      </div>
    </div>
  );
}
