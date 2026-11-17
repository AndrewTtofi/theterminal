import { act, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Modal } from "../src/components/Modal";
import { pushOverlay, useOverlayOpen } from "../src/shell/overlay-store";

describe("overlay store", () => {
  it("is open until every pushed overlay is released, and a release counts once", () => {
    const { result } = renderHook(() => useOverlayOpen());
    expect(result.current).toBe(false);
    let a!: () => void;
    let b!: () => void;
    act(() => {
      a = pushOverlay();
      b = pushOverlay();
    });
    expect(result.current).toBe(true);
    act(() => {
      a();
      a();
    });
    expect(result.current).toBe(true);
    act(() => b());
    expect(result.current).toBe(false);
  });

  it("counts an open Modal as an overlay", () => {
    const { result } = renderHook(() => useOverlayOpen());
    const view = render(
      <Modal labelledBy="t" onClose={() => {}}>
        <h2 id="t">Title</h2>
      </Modal>,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(result.current).toBe(true);
    view.unmount();
    expect(result.current).toBe(false);
  });
});
