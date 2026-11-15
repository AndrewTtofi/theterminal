import { useId, useRef, useState } from "react";
import { ROLE_LABELS, visibleControls } from "@theterminal/shared";
import type { PresenceEntry, Project } from "@theterminal/shared";
import { InviteDialog } from "../components/InviteDialog";
import { clip } from "../components/text";
import { roleOf, useShell } from "../shell/model";
import { VIEW_LABELS } from "../shell/views";
import type { ViewId } from "../shell/views";

const name = (s: string) => clip(visibleControls(s), 60);

/** `<name> · <role> · <view> in <project>`, or `… · not in a project`. */
export function presenceLine(p: PresenceEntry, projects: Project[]): string {
  const who = `${name(p.name)} · ${ROLE_LABELS[p.role]}`;
  if (p.projectId === null) return `${who} · not in a project`;
  const project = projects.find((x) => x.id === p.projectId)?.name;
  const view = p.view !== null && p.view in VIEW_LABELS ? VIEW_LABELS[p.view as ViewId] : "A view";
  return `${who} · ${view} in ${project === undefined ? "a project" : name(project)}`;
}

/** Who is here, everyone in the workspace, and whether remote access is on; the Owner can invite from here. */
export function PeopleSideBar() {
  const { model, dock } = useShell();
  const role = roleOf(model);
  const uid = useId();
  const [inviting, setInviting] = useState(false);
  const inviteButton = useRef<HTMLButtonElement>(null);
  const presence = model.presence ?? [];
  const online = new Set(presence.map((p) => p.personId));
  const remote = model.status?.remote;
  const remoteText = !remote ? "Unknown" : !remote.enabled ? "Off" : remote.label !== undefined ? `On · ${visibleControls(remote.label)}` : "On";

  const close = () => {
    setInviting(false);
    inviteButton.current?.focus();
  };

  return (
    <div className="people-side">
      <section aria-labelledby={`${uid}-here`}>
        <h2 id={`${uid}-here`}>People here</h2>
        {presence.length === 0 ? (
          <p className="empty">Nobody else is here.</p>
        ) : (
          <ul>
            {presence.map((p) => (
              <li key={p.personId}>{presenceLine(p, model.projects)}</li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby={`${uid}-everyone`}>
        <h2 id={`${uid}-everyone`}>Everyone</h2>
        <ul>
          {(model.people ?? []).map((p) => (
            <li key={p.id}>
              <span
                className={`dot ${online.has(p.id) ? "online" : "offline"}`}
                role="img"
                aria-label={online.has(p.id) ? "Online" : "Offline"}
              />{" "}
              <span className="person-name">{name(p.name)}</span> <span className="muted">{ROLE_LABELS[p.role]}</span>
            </li>
          ))}
        </ul>
        {role === "owner" && (
          <button type="button" ref={inviteButton} onClick={() => setInviting(true)}>
            Invite someone
          </button>
        )}
      </section>
      <section aria-labelledby={`${uid}-remote`}>
        <h2 id={`${uid}-remote`}>Remote access</h2>
        <p>{remoteText}</p>
        <button type="button" onClick={() => dock()?.focus("people")}>
          Open People
        </button>
      </section>
      {inviting && <InviteDialog remoteOn={remote?.enabled === true} onClose={close} onCreated={model.refreshPeople} />}
    </div>
  );
}
