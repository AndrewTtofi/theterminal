/**
 * The end of a restart offer: the server is stopped first (bounded by `server.stop()`), so the relaunched app finds
 * the data folder free, then the app relaunches if asked and exits 0. `app.exit()` skips `before-quit`, which is why
 * the stop happens here and not there.
 */
export async function finishRestart(o: {
  restart: boolean;
  stopServer: () => Promise<void>;
  relaunch: () => void;
  exit: (code: number) => void;
}): Promise<void> {
  try {
    await o.stopServer();
  } catch {
    // A server that cannot be stopped is not a reason to stay open.
  }
  if (o.restart) o.relaunch();
  o.exit(0);
}
