import { describe, expect, it } from "vitest";
import { finishRestart } from "../src/lifecycle.js";

/** A fake app whose server stop takes a tick, recording the order of what happens. */
function fakeApp(o: { stopFails?: boolean } = {}) {
  const order: string[] = [];
  let release!: () => void;
  const stopped = new Promise<void>((r) => (release = r));
  return {
    order,
    release: () => release(),
    deps: {
      stopServer: () => {
        order.push("stop:begin");
        return stopped.then(() => {
          order.push("stop:end");
          if (o.stopFails) throw new Error("stop failed");
        });
      },
      relaunch: () => order.push("relaunch"),
      exit: (code: number) => order.push(`exit:${code}`),
    },
  };
}

describe("finishRestart", () => {
  it("stops the server before it relaunches and exits 0", async () => {
    const a = fakeApp();
    const done = finishRestart({ restart: true, ...a.deps });
    await Promise.resolve();
    expect(a.order).toEqual(["stop:begin"]);
    a.release();
    await done;
    expect(a.order).toEqual(["stop:begin", "stop:end", "relaunch", "exit:0"]);
  });

  it("stops the server and exits 0 without relaunching when the user chose Quit", async () => {
    const a = fakeApp();
    a.release();
    await finishRestart({ restart: false, ...a.deps });
    expect(a.order).toEqual(["stop:begin", "stop:end", "exit:0"]);
  });

  it("still exits when stopping the server fails", async () => {
    const a = fakeApp({ stopFails: true });
    a.release();
    await finishRestart({ restart: true, ...a.deps });
    expect(a.order).toEqual(["stop:begin", "stop:end", "relaunch", "exit:0"]);
  });
});
