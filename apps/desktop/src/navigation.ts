const APP_HOST = "theterminal.localhost";

/** The only origin the window may show. Chromium resolves `*.localhost` to loopback itself. */
export function appOrigin(port: number): string {
  return `http://${APP_HOST}:${port}`;
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** True when `url` is on the app origin: http, the app host, and exactly this port. */
export function isAppUrl(url: string, port: number): boolean {
  const u = parse(url);
  return u !== null && u.origin === new URL(appOrigin(port)).origin;
}

/** The normalized URL when it may go to the system browser (http or https only), otherwise null. */
export function externalUrl(url: string): string | null {
  const u = parse(url);
  return u !== null && (u.protocol === "http:" || u.protocol === "https:") ? u.href : null;
}
