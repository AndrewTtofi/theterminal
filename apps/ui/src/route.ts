/** Which page a path opens: an invitation's join page, the sign-in page, or the workspace itself. */
export type Route = { page: "join"; code: string } | { page: "sign-in" } | { page: "app" };

/** The server serves these two paths as the same page (static-ui.ts), with the same code rule. */
const JOIN = /^\/join\/([A-Za-z0-9_-]{1,200})$/;

export function routeOf(pathname: string): Route {
  const join = JOIN.exec(pathname);
  if (join) return { page: "join", code: join[1]! };
  if (pathname === "/sign-in") return { page: "sign-in" };
  return { page: "app" };
}
