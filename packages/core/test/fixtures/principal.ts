import type { FastifyInstance } from "fastify";
import { OWNER_ID, type Principal, type Role } from "@theterminal/shared";

/** The header a test sends to say who is asking: `<personId>:<role>`, or `none` for nobody. Absent means the Owner. */
export const TEST_PRINCIPAL = "x-test-principal";

export const testPrincipal = (personId: string, role: Role): Principal => ({
  personId, name: personId === OWNER_ID ? "Owner" : personId, role, listener: "local", method: personId === OWNER_ID ? "token" : "passkey", sessionId: null,
});

/** The header a test sends to put the request on the remote listener: `remote`. Absent means the local listener. */
export const TEST_LISTENER = "x-test-listener";
export const onRemote: Record<string, string> = { [TEST_LISTENER]: "remote" };

/** Request headers naming the caller: `asPrincipal("r1", "reviewer")`. */
export const asPrincipal = (personId: string, role: Role): Record<string, string> => ({ [TEST_PRINCIPAL]: `${personId}:${role}` });
export const asNobody: Record<string, string> = { [TEST_PRINCIPAL]: "none" };

/**
 * Stands in for registerAuth on a plain Fastify app in a route unit test: `request.principal` is read from the
 * TEST_PRINCIPAL header, and is the Owner when the header is absent; `request.listener` is remote only when the
 * TEST_LISTENER header says so. Nothing else of the guard (Host, Origin, the
 * role table) is applied, so a test sees what the route's own checks do.
 */
export function fakeAuth(app: FastifyInstance): void {
  app.decorateRequest("principal", null);
  app.decorateRequest("listener", "local");
  app.addHook("onRequest", async (request) => {
    request.listener = request.headers[TEST_LISTENER] === "remote" ? "remote" : "local";
    const h = request.headers[TEST_PRINCIPAL];
    if (h === "none") {
      request.principal = null;
      return;
    }
    if (typeof h !== "string") {
      request.principal = { ...testPrincipal(OWNER_ID, "owner"), listener: request.listener };
      return;
    }
    const [personId = "", role = "viewer"] = h.split(":");
    request.principal = { ...testPrincipal(personId, role as Role), listener: request.listener };
  });
}
