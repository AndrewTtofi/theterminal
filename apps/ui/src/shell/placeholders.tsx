import { basename } from "../components/text";
import { parsePanelPath } from "./dock-layout";

/**
 * Stand-ins for the Conversation, Needs-you, Terminal, diff and file panels and the Changes and Learn side bars,
 * so layouts holding them restore (an unregistered component would make the whole layout fall back). Each is
 * replaced by its real view.
 */
export function PlaceholderPanel({ id }: { id: string }) {
  const file = parsePanelPath(id);
  return <p className="empty">{file ? `${basename(file.path)}: not available yet.` : "Not available yet."}</p>;
}

export function PlaceholderSideBar() {
  return <p className="empty">Not available yet.</p>;
}
