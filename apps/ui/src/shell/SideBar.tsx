import type { ComponentType, KeyboardEvent, PointerEvent } from "react";
import { AgentsSideBar } from "../views/AgentsSideBar";
import { CapacitySideBar } from "../views/CapacitySideBar";
import { ConnectionsSideBar } from "../views/ConnectionsSideBar";
import { GitHubSideBar } from "../views/GitHubSideBar";
import { LedgerSideBar } from "../views/LedgerSideBar";
import { NeedsYouSideBar } from "../views/NeedsYouSideBar";
import { ProjectsSideBar } from "../views/ProjectsSideBar";
import { PlaceholderSideBar } from "./placeholders";
import { VIEW_LABELS } from "./views";
import type { ViewId } from "./views";

export const SIDE_BAR_MIN = 200;
export const SIDE_BAR_MAX = 480;
export const SIDE_BAR_DEFAULT = 260;
const KEY_STEP = 20;

const CONTENT: Record<ViewId, ComponentType> = {
  board: ProjectsSideBar,
  agents: AgentsSideBar,
  changes: PlaceholderSideBar,
  needs_you: NeedsYouSideBar,
  ledger: LedgerSideBar,
  connections: ConnectionsSideBar,
  github: GitHubSideBar,
  capacity: CapacitySideBar,
  learn: PlaceholderSideBar,
};

export const clampWidth = (w: number) => Math.min(SIDE_BAR_MAX, Math.max(SIDE_BAR_MIN, Math.round(w)));

type Props = { view: ViewId; width: number; onResize: (width: number) => void };

export function SideBar({ view, width, onResize }: Props) {
  const Content = CONTENT[view];

  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const move = (ev: globalThis.PointerEvent) => onResize(clampWidth(startWidth + ev.clientX - startX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") onResize(clampWidth(width - KEY_STEP));
    else if (e.key === "ArrowRight") onResize(clampWidth(width + KEY_STEP));
    else return;
    e.preventDefault();
  };

  return (
    <>
      <aside className="side-bar" aria-label="Side bar" style={{ width: `${width}px` }}>
        <header className="side-bar-title">{VIEW_LABELS[view]}</header>
        <div className="side-bar-content">
          <Content />
        </div>
      </aside>
      <div
        className="sash"
        role="separator"
        aria-label="Resize side bar"
        aria-orientation="vertical"
        aria-valuemin={SIDE_BAR_MIN}
        aria-valuemax={SIDE_BAR_MAX}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={onKey}
      />
    </>
  );
}
