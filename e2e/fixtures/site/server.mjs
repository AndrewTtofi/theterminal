// The e2e website fixture (preview.spec.ts): one page, on the port and address The Terminal gives it (PORT, HOST).
import { createServer } from "node:http";

const PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Contact</title></head>
  <body><h1>Contact us</h1><p>The fixture site.</p></body>
</html>
`;

const port = Number.parseInt(process.env.PORT ?? "", 10);
const host = process.env.HOST || "127.0.0.1";
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error("PORT is not set");
  process.exit(1);
}

const server = createServer((req, res) => {
  res.writeHead(req.url === "/" ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(req.url === "/" ? PAGE : "Not found");
});
server.listen(port, host, () => console.log(`listening on ${host}:${port}`));
const close = () => server.close(() => process.exit(0));
process.on("SIGTERM", close);
process.on("SIGINT", close);
