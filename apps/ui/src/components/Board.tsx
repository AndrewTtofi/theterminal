import { STAGES, adapterLabel, visibleControls } from "@theterminal/shared";
import type { Board as BoardData, Card, CardInfo, Stage } from "@theterminal/shared";
import { ProgressBar, progressKey } from "./ProgressBar";
import "./board.css";

type Props = {
  board: BoardData;
  /** Each card's run, progress and note counts, by card id; a card without one shows its title only. */
  infos: Record<string, CardInfo>;
  /** The card whose panel is open, if any. */
  selectedId: string | null;
  onOpen: (cardId: string) => void;
  /** Called with each card's button as it mounts (null as it unmounts), so focus can return to it. */
  cardRef?: (cardId: string, el: HTMLButtonElement | null) => void;
};

/** "ship" → "Ship". */
export const stageLabel = (s: Stage) => s.charAt(0).toUpperCase() + s.slice(1);

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The dot's meaning: accent for live, amber for waiting on a person, green for done, grey otherwise. */
export function cardTone(card: Card, info: CardInfo | undefined): "done" | "waiting" | "live" | "idle" {
  if (card.status === "done") return "done";
  if (info?.waiting) return "waiting";
  if (info?.runStatus === "running") return "live";
  return "idle";
}

/** The card's one line of what is happening; null when nothing is known yet. */
function nowLine(info: CardInfo | undefined): { text: string; attention: boolean } | null {
  if (!info) return null;
  if (info.waiting) return { text: "Waiting for your approval", attention: true };
  if (info.runId === null) return { text: "Waiting for an agent", attention: false };
  if (info.now) return { text: `Now: ${visibleControls(info.now)}`, attention: false };
  switch (info.runStatus) {
    case "running": return { text: "Working…", attention: false };
    case "completed": return { text: "Finished", attention: false };
    case "failed": return { text: "Failed", attention: false };
    case "stopped": return { text: "Stopped", attention: false };
    default: return null;
  }
}

function AgentCard({ card, info, selected, onOpen, cardRef }: {
  card: Card; info: CardInfo | undefined; selected: boolean; onOpen: (id: string) => void;
  cardRef?: Props["cardRef"];
}) {
  const title = visibleControls(card.title);
  const tone = cardTone(card, info);
  const now = nowLine(info);
  const percent = info?.percent ?? null;
  return (
    <button
      type="button"
      className={`agent-card ${tone}${selected ? " selected" : ""}`}
      aria-label={`Open ${title}`}
      aria-pressed={selected}
      ref={cardRef ? (el) => cardRef(card.id, el) : undefined}
      onClick={() => onOpen(card.id)}
    >
      <span className="agent-card-row">
        <span className="agent-card-title">{title}</span>
        {percent !== null && <span className="agent-card-pct num">{percent}%</span>}
      </span>
      <ProgressBar
        key={progressKey(info?.runId ?? card.id, info?.progress?.steps.length ?? 0)}
        compact
        percent={percent}
        label={`${title} progress`}
      />
      {now !== null && (
        <span className={`agent-card-now${now.attention ? " attention" : ""}`}>
          <span className={`dot ${tone}`} aria-hidden="true" />
          {now.text}
        </span>
      )}
      {info && (
        <span className="agent-card-meta">
          <span>{info.adapter !== null ? adapterLabel(info.adapter) : ""}</span>
          <span className="agent-card-counts">
            {info.commentsWaiting > 0 ? (
              <span className="agent-card-tag attention">{plural(info.commentsWaiting, "note")} waiting</span>
            ) : info.comments > 0 ? (
              <span>{plural(info.comments, "note")}</span>
            ) : null}
            {info.screenshots > 0 && <span>{plural(info.screenshots, "screenshot")}</span>}
          </span>
        </span>
      )}
    </button>
  );
}

/**
 * The lifecycle board, run by agents: read-only cards with their progress, what is happening now, the agent and the
 * notes. Nobody adds, drags or moves a card here; clicking one opens its panel.
 */
export function Board({ board, infos, selectedId, onOpen, cardRef }: Props) {
  return (
    <div className="agent-board">
      {STAGES.map((stage) => {
        const cards = board.columns[stage];
        return (
          <section key={stage} className="agent-col" aria-label={stageLabel(stage)}>
            <h3 className="agent-col-head">
              {stageLabel(stage)} <span className="num">{cards.length}</span>
            </h3>
            <div className="agent-col-cards">
              {cards.map((card) => (
                <AgentCard
                  key={card.id}
                  card={card}
                  info={infos[card.id]}
                  selected={card.id === selectedId}
                  onOpen={onOpen}
                  {...(cardRef && { cardRef })}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
