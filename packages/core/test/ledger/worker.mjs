// Plain-JS worker: imports the built dist (run `pnpm build` first; root `pnpm test` does).
import { workerData, parentPort } from "node:worker_threads";
import { openDatabase, Ledger } from "../../dist/index.js";

const { file, count, tag } = workerData;
const ledger = new Ledger(openDatabase(file));
for (let i = 0; i < count; i++) {
  ledger.append({
    projectId: null,
    actor: { kind: "human", id: "owner" },
    type: "project.created",
    payload: { projectId: `${tag}-${i}`, name: "n", pitch: "p" },
  });
}
parentPort.postMessage("done");
