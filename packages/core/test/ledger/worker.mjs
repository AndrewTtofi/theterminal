// Plain-JS worker: imports the built dist (run `pnpm build` first; root `pnpm test` does).
import { workerData, parentPort } from "node:worker_threads";
import { openDatabase, Ledger } from "../../dist/index.js";

const { file, count, tag } = workerData;
const db = openDatabase(file);
const ledger = new Ledger(db);
for (let i = 0; i < count; i++) {
  ledger.append({
    projectId: null,
    actor: { kind: "human", id: "owner" },
    type: "project.created",
    payload: { projectId: `${tag}-${i}`, name: "n", pitch: "p" },
  });
}
// Close before reporting: on Windows an open SQLite handle (and its -wal/-shm
// files) keeps the test's temporary directory from being removed.
db.close();
parentPort.postMessage("done");
