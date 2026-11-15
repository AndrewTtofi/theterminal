import { render } from "@testing-library/react";
import type { RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import type { Me } from "@theterminal/shared";
import { RoleContext } from "../src/shell/model";

/** The Owner as `me`: what a model needs for the shell to show the Owner's controls (absent `me` is a viewer). */
export const OWNER_ME: Me = { personId: "owner", name: "Owner", role: "owner", listener: "local", method: "token", credentials: [], sessions: [] };

function OwnerRole({ children }: { children: ReactNode }) {
  return <RoleContext.Provider value="owner">{children}</RoleContext.Provider>;
}

/** Renders a component on its own (outside the shell) as the Owner would see it; rerenders keep the role. */
export function renderAsOwner(ui: ReactElement, opts: Omit<RenderOptions, "wrapper"> = {}): ReturnType<typeof render> {
  return render(ui, { wrapper: OwnerRole, ...opts });
}
