import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom has no ResizeObserver; the shell's layout code only needs it to exist.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// Newer Node versions define their own global localStorage (unusable without --localstorage-file),
// which shadows jsdom's; point the global back at jsdom's storage.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
if (dom) Object.defineProperty(globalThis, "localStorage", { value: dom.window.localStorage, configurable: true });

afterEach(cleanup);
