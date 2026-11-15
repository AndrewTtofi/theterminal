import { describe, expect, it } from "vitest";
import { roleOf } from "../src/shell/model";

describe("roleOf", () => {
  it("fails closed: no model, no me or an unknown me is a viewer; otherwise the person's role", () => {
    expect(roleOf(undefined)).toBe("viewer");
    expect(roleOf({})).toBe("viewer");
    expect(roleOf({ me: null })).toBe("viewer");
    expect(roleOf({ me: { personId: "o", name: "O", role: "owner", listener: "local", method: "token", credentials: [], sessions: [] } })).toBe("owner");
  });
});
