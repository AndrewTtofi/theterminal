import { useId } from "react";
import { DIGEST_DAYS, visibleControls } from "@theterminal/shared";
import type { DailyDigest, DigestDays, DigestItem } from "@theterminal/shared";
import { useShell } from "../shell/model";

/** The class of an item's line, as in the ledger panel: `attention` when it needs the Owner's eye, `override` for an override. */
function itemClass(item: DigestItem): string | undefined {
  const names = [item.attention && "attention", item.topic === "override" && "override"].filter(Boolean);
  return names.length > 0 ? names.join(" ") : undefined;
}

function Day({ d }: { d: DailyDigest }) {
  const uid = useId();
  return (
    <article aria-labelledby={uid}>
      <h3 id={uid}>{`${d.day} (UTC)`}</h3>
      <p className="digest-summary">{visibleControls(d.summary)}</p>
      <ul>
        {d.items.map((item) => (
          <li key={item.seq} className={itemClass(item)}>
            <time>{item.time}</time> · {item.topic === "override" && !item.headline.startsWith("OVERRIDE") && <span className="override-tag">OVERRIDE </span>}
            <span className="headline">{visibleControls(item.headline)}</span>
          </li>
        ))}
      </ul>
      {d.more > 0 && <p className="note">{`and ${d.more} more`}</p>}
    </article>
  );
}

/** One plain-language account per UTC day of the selected project's ledger, newest first. */
export function DigestPanel(_props: { id: string }) {
  const { model } = useShell();
  const { days, onDaysChange, list } = model.digests;
  return (
    <section className="digest-panel" aria-label="Daily digest">
      <h2>Daily digest</h2>
      {model.selectedId === null ? (
        <p className="empty">Select or create a project.</p>
      ) : (
        <>
          <select aria-label="Days" value={days} onChange={(e) => onDaysChange(Number(e.target.value) as DigestDays)}>
            {DIGEST_DAYS.map((d) => (
              <option key={d} value={d}>{`Last ${d} days`}</option>
            ))}
          </select>
          {list === null ? (
            <p className="empty">Loading…</p>
          ) : list.length === 0 ? (
            <p className="empty">No entries in this window.</p>
          ) : (
            list.map((d) => <Day key={d.day} d={d} />)
          )}
        </>
      )}
    </section>
  );
}
