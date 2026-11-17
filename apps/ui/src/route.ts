/** Which page a path opens: an invitation's join page, the sign-in page, a preview's device frames, or the workspace. */
export type Route = { page: "join"; code: string } | { page: "sign-in" } | { page: "preview"; id: string } | { page: "app" };

/** The server serves these two paths as the same page (static-ui.ts), with the same code rule. */
const JOIN = /^\/join\/([A-Za-z0-9_-]{1,200})$/;
/** `/preview/<id>`: the same index page under the preview's own CSP; ids have the desktop app's preview id form. */
const PREVIEW = /^\/preview\/([A-Za-z0-9_-]{1,100})$/;

export function routeOf(pathname: string): Route {
  const join = JOIN.exec(pathname);
  if (join) return { page: "join", code: join[1]! };
  if (pathname === "/sign-in") return { page: "sign-in" };
  const preview = PREVIEW.exec(pathname);
  if (preview) return { page: "preview", id: preview[1]! };
  return { page: "app" };
}
