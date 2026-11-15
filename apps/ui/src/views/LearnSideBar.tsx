import { useEffect, useRef, useState } from "react";
import { LEARN_SECTIONS, LEARN_SECTION_LABELS, LEARN_TOPICS, topicsFor, visibleControls } from "@theterminal/shared";
import type { LearnTopic } from "@theterminal/shared";
import { markRead, readTopics } from "../learn-store";
import { useShell } from "../shell/model";

function Topic({ topic, read, open, onRead }: { topic: LearnTopic; read: boolean; open: boolean; onRead: (id: string) => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !open) return;
    el.open = true;
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [open]);
  return (
    <details
      ref={ref}
      className={read ? "learn-topic read" : "learn-topic"}
      onToggle={(e) => e.currentTarget.open && onRead(topic.id)}
    >
      <summary>
        {read && <span className="learn-check" aria-label="Read">✓</span>} {visibleControls(topic.title)}
      </summary>
      <p>{visibleControls(topic.body)}</p>
    </details>
  );
}

export function LearnSideBar() {
  const { contextView, learnTopic } = useShell();
  const [query, setQuery] = useState("");
  const [read, setRead] = useState(readTopics);
  const onRead = (id: string) => {
    markRead(id);
    setRead((s) => (s.has(id) ? s : new Set(s).add(id)));
  };

  const q = query.trim().toLowerCase();
  const shown = (t: LearnTopic) => !q || t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q);
  const { matched, rest } = topicsFor({ view: contextView });
  const pinned = learnTopic ? LEARN_TOPICS.find((t) => t.id === learnTopic && shown(t)) : undefined;
  const keep = (t: LearnTopic) => shown(t) && t !== pinned;
  const matchedShown = matched.filter(keep);
  const restShown = rest.filter(keep);
  const empty = !pinned && matchedShown.length === 0 && restShown.length === 0;
  const item = (t: LearnTopic) => <Topic key={t.id} topic={t} read={read.has(t.id)} open={t.id === learnTopic} onRead={onRead} />;

  return (
    <div className="learn-side">
      <input type="search" aria-label="Search topics" placeholder="Search topics" value={query} onChange={(e) => setQuery(e.target.value)} />
      {pinned && item(pinned)}
      {matchedShown.length > 0 && (
        <>
          <h3>For what you are looking at</h3>
          {matchedShown.map(item)}
        </>
      )}
      {restShown.length > 0 && (
        <>
          <h3>Everything else</h3>
          {LEARN_SECTIONS.map((s) => {
            const inSection = restShown.filter((t) => t.section === s);
            return (
              inSection.length > 0 && (
                <section key={s}>
                  <h4>{LEARN_SECTION_LABELS[s]}</h4>
                  {inSection.map(item)}
                </section>
              )
            );
          })}
        </>
      )}
      {empty && <p className="empty">No topic matches.</p>}
      <p className="muted learn-footer">Short explanations so you can decide and audit well. They are written into The Terminal, not generated.</p>
    </div>
  );
}
