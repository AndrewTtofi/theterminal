import { describe, expect, it } from "vitest";
import { routeOf } from "../src/route";

describe("routeOf", () => {
  it("sends /join/<code> to the join page, /sign-in to the sign-in page, and anything else to the workspace", () => {
    expect(routeOf("/join/AbC_-1")).toEqual({ page: "join", code: "AbC_-1" });
    expect(routeOf("/sign-in")).toEqual({ page: "sign-in" });
    expect(routeOf("/")).toEqual({ page: "app" });
    expect(routeOf("/join/a/b")).toEqual({ page: "app" });
    expect(routeOf("/join/")).toEqual({ page: "app" });
    expect(routeOf("/join/%3Cscript%3E")).toEqual({ page: "app" });
  });
});
