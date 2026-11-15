// A stand-in for the core CLI under a host. The mode comes from argv[2].
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.argv[2];
const ready = { type: "ready", url: "http://127.0.0.1:4321/?token=fake", loopbackUrl: "http://127.0.0.1:4321/", port: 4321 };
const keepAlive = () => setInterval(() => {}, 1000);
const exitOnShutdown = () => {
  process.on("message", (m) => {
    if (m?.type === "shutdown") process.exit(0);
  });
  process.on("disconnect", () => process.exit(0));
};

if (mode === "fail") {
  process.stderr.write("boom\n");
  process.exit(3);
} else if (mode === "hang" || mode === "hang-ignore-sigterm") {
  keepAlive();
  if (mode === "hang-ignore-sigterm") process.on("SIGTERM", () => {});
} else if (mode === "ignore-shutdown" || mode === "ignore-sigterm") {
  keepAlive();
  process.on("message", () => {});
  process.on("disconnect", () => {});
  if (mode === "ignore-sigterm") process.on("SIGTERM", () => {});
  process.send(ready);
} else if (mode === "ready") {
  exitOnShutdown();
  console.log("fake server is running");
  process.send(ready);
} else if (mode === "ready-then-exit") {
  process.send(ready, () => process.exit(5));
} else if (mode === "bad-ready") {
  // Malformed ready messages are ignored; the valid one after them counts.
  exitOnShutdown();
  process.send({ type: "ready", url: 42, loopbackUrl: "x", port: 1 });
  process.send({ type: "ready", url: "http://127.0.0.1:1/", loopbackUrl: "x", port: 1.5 });
  process.send({ type: "ready", url: "http://127.0.0.1:2/", loopbackUrl: "http://127.0.0.1:2/", port: 2 });
} else if (mode === "env") {
  exitOnShutdown();
  const v = (k) => process.env[k] ?? "unset";
  process.send({ ...ready, url: `http://127.0.0.1:4321/?value=${v("TT_TEST_VALUE")}&vitest=${v("VITEST")}` });
} else if (mode === "grandchild") {
  // A detached grandchild inherits stdout and stderr, so the pipes stay open after this process exits.
  exitOnShutdown();
  const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  g.unref();
  writeFileSync(process.argv[3], String(g.pid));
  process.send(ready);
} else if (mode === "pick" || mode === "pick-twice") {
  // Asks the host for folders, then reports the answers it got in the ready URL.
  exitOnShutdown();
  const want = mode === "pick" ? 1 : 2;
  const got = [];
  process.on("message", (m) => {
    if (m?.type !== "picked_folder") return;
    got.push(m);
    if (got.length === want) {
      process.send({ ...ready, url: `http://127.0.0.1:4321/?answers=${encodeURIComponent(JSON.stringify(got))}` });
    }
  });
  if (mode === "pick") {
    // Malformed requests are ignored and never answered.
    process.send({ type: "pick_folder" });
    process.send({ type: "pick_folder", id: 42 });
    process.send({ type: "pick_folder", id: "" });
    process.send({ type: "pick_folder", id: "x".repeat(200) });
    process.send({ type: "pick_folder", id: "../p1" });
    process.send({ type: "pick_folders", id: "p9" });
    process.send({ type: "pick_folder", id: "p1" });
  } else {
    process.send({ type: "pick_folder", id: "p1" });
    process.send({ type: "pick_folder", id: "p2" });
  }
} else {
  process.stderr.write(`unknown mode ${mode}\n`);
  process.exit(2);
}
