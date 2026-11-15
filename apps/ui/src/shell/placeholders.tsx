/**
 * Stand-ins for the Conversation and Needs-you panels and the Learn side bar, so layouts holding them
 * restore (an unregistered component would make the whole layout fall back). Each is replaced by its real view.
 */
export function PlaceholderPanel() {
  return <p className="empty">Not available yet.</p>;
}

export function PlaceholderSideBar() {
  return <p className="empty">Not available yet.</p>;
}
