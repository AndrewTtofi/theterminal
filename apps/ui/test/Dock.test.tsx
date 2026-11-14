import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const seen = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));

vi.mock("dockview-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("dockview-react")>();
  return {
    ...actual,
    DockviewReact: (props: Record<string, unknown>) => {
      seen.props = props;
      return null;
    },
  };
});

import { Dock } from "../src/shell/Dock";

describe("Dock", () => {
  it("disables floating groups, which could cover the Needs-you strip", () => {
    render(<Dock panels={{ board: () => null }} onReady={vi.fn()} layoutKey="test" />);
    expect(seen.props?.disableFloatingGroups).toBe(true);
  });
});
