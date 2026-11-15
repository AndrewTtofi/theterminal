// A stand-in for the core CLI under a host. The mode comes from argv[2]: ready, fail, hang, ignore-shutdown.
const mode = process.argv[2];
const ready = { type: "ready", url: "http://127.0.0.1:4321/?token=fake", loopbackUrl: "http://127.0.0.1:4321/", port: 4321 };
const keepAlive = () => setInterval(() => {}, 1000);

if (mode === "fail") {
  process.stderr.write("boom\n");
  process.exit(3);
} else if (mode === "hang") {
  keepAlive();
} else if (mode === "ignore-shutdown") {
  keepAlive();
  process.on("message", () => {});
  process.on("disconnect", () => {});
  process.send(ready);
} else if (mode === "ready") {
  process.on("message", (m) => {
    if (m?.type === "shutdown") process.exit(0);
  });
  process.on("disconnect", () => process.exit(0));
  console.log("fake server is running");
  process.send(ready);
} else {
  process.stderr.write(`unknown mode ${mode}\n`);
  process.exit(2);
}
