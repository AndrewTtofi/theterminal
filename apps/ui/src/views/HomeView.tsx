import { useRef, useState } from "react";
import type { HomeRun } from "@theterminal/shared";
import { ApprovalsBlock } from "../home/ApprovalsBlock";
import { AskBox } from "../home/AskBox";
import { FilesBlock } from "../home/FilesBlock";
import { FinishedBlock } from "../home/FinishedBlock";
import { HomeEditor } from "../home/HomeEditor";
import { loadHome, resetHome, saveHome } from "../home/home-store";
import type { HomeBlockId, HomeLayout } from "../home/home-store";
import { OverallBlock } from "../home/OverallBlock";
import { PreviewsBlock } from "../home/PreviewsBlock";
import { TotalsStrip } from "../home/TotalsStrip";
import type { HomeFilter } from "../home/TotalsStrip";
import { WorkingBlock } from "../home/WorkingBlock";
import { useShell } from "../shell/model";
import "../home/home.css";

/**
 * The Home tab: the totals strip, then the blocks in the order this device saved (`tt.home.v1`). Needs your approval
 * always renders, wherever it sits. Everything but the approvals is the selected project's, unless a total in the
 * strip switched Working now or Finished today to every project.
 */
export function HomeView(_props: { id?: string }) {
  const { model } = useShell();
  const [layout, setLayout] = useState<HomeLayout>(loadHome);
  const [draft, setDraft] = useState<HomeLayout | null>(null);
  const [filter, setFilter] = useState<HomeFilter>(null);
  const approvalsHeading = useRef<HTMLHeadingElement>(null);
  const shown = draft ?? layout;

  const data = model.home.data;
  const mine = (h: HomeRun) => h.run.projectId === model.selectedId;
  // The server answers every project's runs in the "all" scope; without a filter only the selected project's show.
  const working = (data?.working ?? []).filter((h) => filter !== null || mine(h));
  const finished = (data?.finishedToday ?? []).filter((h) => filter !== null || mine(h));

  const needYou = () => {
    const h = approvalsHeading.current;
    if (!h) return;
    h.scrollIntoView?.({ block: "start", behavior: "smooth" });
    h.focus({ preventScroll: true });
  };

  const block = (id: HomeBlockId) => {
    switch (id) {
      case "ask":
        return <AskBox />;
      case "approvals":
        return <ApprovalsBlock ref={approvalsHeading} />;
      case "working":
        return <WorkingBlock runs={working} columns={shown.workingColumns} allProjects={filter !== null} />;
      case "overall":
        return <OverallBlock runs={working} />;
      case "finished":
        return <FinishedBlock runs={finished} allProjects={filter !== null} />;
      case "previews":
        return <PreviewsBlock />;
      case "files":
        return <FilesBlock />;
    }
  };

  return (
    <div className="home-view">
      <header className="home-header">
        <TotalsStrip filter={filter} onFilter={setFilter} onNeedYou={needYou} />
        <button
          type="button"
          className="quiet home-edit"
          aria-pressed={draft !== null}
          onClick={() => setDraft((d) => (d === null ? layout : null))}
        >
          Edit Home
        </button>
      </header>
      {draft !== null && (
        <HomeEditor
          draft={draft}
          onChange={setDraft}
          onDone={() => {
            saveHome(draft);
            setLayout(draft);
            setDraft(null);
          }}
          onReset={() => {
            const d = resetHome();
            setLayout(d);
            setDraft(d);
          }}
        />
      )}
      {model.home.error !== null && <p className="home-note" role="status">{model.home.error}</p>}
      <div className="home-blocks">
        {shown.order
          .filter((id) => id === "approvals" || !shown.hidden.includes(id))
          .map((id) => (
            <div key={id} data-block={id} className="home-slot">
              {block(id)}
            </div>
          ))}
      </div>
    </div>
  );
}
