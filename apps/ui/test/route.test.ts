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

  it("sends /preview/<id> to the preview page, and nothing that is not a plain id", () => {
    expect(routeOf("/preview/p1")).toEqual({ page: "preview", id: "p1" });
    expect(routeOf("/preview/AbC_-9")).toEqual({ page: "preview", id: "AbC_-9" });
    expect(routeOf("/preview/../x")).toEqual({ page: "app" });
    expect(routeOf("/preview/")).toEqual({ page: "app" });
    expect(routeOf("/preview/a/b")).toEqual({ page: "app" });
    expect(routeOf("/preview/%2E%2E")).toEqual({ page: "app" });
  });
});
