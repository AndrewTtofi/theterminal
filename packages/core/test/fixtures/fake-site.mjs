// A stand-in for a website's dev server, for tests only. It never leaves the loopback interface.
//
// PORT, HOST (default 127.0.0.1): where it listens, after FAKE_SITE_DELAY_MS (default 0).
// FAKE_SITE_EXIT: exit at once with this code, without listening.
// FAKE_SITE_PRINT: text written to stdout first, as it is.
// FAKE_SITE_NOFRAME=1: every answer carries `X-Frame-Options: DENY`.
// FAKE_SITE_SILENT=1: accept connections but never answer them (a server that hangs).
// FAKE_SITE_GRANDCHILD: a file path; also starts a child process that never exits on its own and writes its pid
//   there, so a test can check the whole tree was killed. This process writes its own pid to `<path>.parent`.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer as createTcp } from "node:net";

const env = process.env;
if (env.FAKE_SITE_PRINT) process.stdout.write(env.FAKE_SITE_PRINT);
if (env.FAKE_SITE_EXIT !== undefined) {
  process.exitCode = Number(env.FAKE_SITE_EXIT);
} else {
  if (env.FAKE_SITE_GRANDCHILD) {
    const code = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{},1000)";
    spawn(process.execPath, ["-e", code, env.FAKE_SITE_GRANDCHILD], { stdio: "ignore" });
    writeFileSync(`${env.FAKE_SITE_GRANDCHILD}.parent`, String(process.pid));
  }
  const server =
    env.FAKE_SITE_SILENT === "1"
      ? createTcp((c) => c.resume()) // reads what it is sent and never answers
      : createHttp((req, res) => {
          const headers = { "content-type": "text/html" };
          if (env.FAKE_SITE_NOFRAME === "1") headers["x-frame-options"] = "DENY";
          res.writeHead(200, headers);
          res.end("<!doctype html><title>fake site</title>");
        });
  setTimeout(() => server.listen(Number(env.PORT), env.HOST ?? "127.0.0.1"), Number(env.FAKE_SITE_DELAY_MS ?? 0));
  setInterval(() => undefined, 1000);
}
