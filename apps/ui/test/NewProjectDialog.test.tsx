import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, Role } from "@theterminal/shared";
import { ApiError, api } from "../src/api";
import { NewProjectDialog } from "../src/components/NewProjectDialog";
import { RoleContext } from "../src/shell/model";

afterEach(() => vi.restoreAllMocks());

const project = (name: string): Project => ({ id: "p9", name, pitch: "", createdAt: "" });
const result = (over = {}) => ({ commit: "c".repeat(40), files: 12, bytes: 2048, skipped: [], skippedCount: 0, ...over });

function setup(role: Role = "owner") {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <RoleContext.Provider value={role}>
      <NewProjectDialog onClose={onClose} onCreated={onCreated} />
    </RoleContext.Provider>,
  );
  const dialog = screen.getByRole("dialog", { name: "New project" });
  return { dialog, onClose, onCreated };
}

describe("NewProjectDialog", () => {
  it("offers files, GitHub, a folder and starting empty to the Owner", () => {
    const { dialog } = setup();
    const choices = within(dialog).getAllByRole("radio").map((r) => r.getAttribute("value"));
    expect(choices).toEqual(["files", "github", "folder", "empty"]);
    expect(within(dialog).getByLabelText("Name")).toBe(document.activeElement);
  });

  it("lists the GitHub repositories and creates a project from one, selecting it", async () => {
    vi.spyOn(api, "githubRepos").mockResolvedValue({
      repos: [
        { fullName: "you/website", defaultBranch: "main", private: false },
        { fullName: "you/taxes", defaultBranch: "main", private: true },
      ],
    });
    const create = vi.spyOn(api, "createFromGitHub").mockResolvedValue({ project: project("taxes"), result: result({ skippedCount: 1, skipped: [{ path: "CON.txt", reason: "unstorable" }] }) });
    const { dialog, onCreated } = setup("maintainer");
    await userEvent.click(within(dialog).getByRole("radio", { name: /From GitHub/ }));
    const repo = (await within(dialog).findByRole("combobox", { name: "Repository" })) as HTMLSelectElement;
    expect(within(repo).getAllByRole("option").map((o) => o.textContent)).toEqual(["you/website", "you/taxes · private"]);
    await userEvent.selectOptions(repo, "you/taxes");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect(create).toHaveBeenCalledWith({ repo: "you/taxes", includeSecrets: false });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project("taxes")));
    expect(await within(dialog).findByText(/Copied in 12 files/)).toBeTruthy();
    expect(within(dialog).getByText(/CON\.txt/)).toBeTruthy();
  });

  it("asks to connect GitHub when there is no connection", async () => {
    vi.spyOn(api, "githubRepos").mockRejectedValue(new ApiError(400, "github_not_connected"));
    const { dialog } = setup("maintainer");
    await userEvent.click(within(dialog).getByRole("radio", { name: /From GitHub/ }));
    expect(await within(dialog).findByText("Connect GitHub in Connections first.")).toBeTruthy();
  });

  it("shows no folder choice to anyone but the Owner", () => {
    const { dialog } = setup("maintainer");
    expect(within(dialog).queryByRole("radio", { name: /folder on this computer/ })).toBeNull();
  });

  it("uses the folder picker, and on folder_picker_unavailable offers a typed path", async () => {
    vi.spyOn(api, "pickFolder").mockRejectedValue(new ApiError(404, "folder_picker_unavailable"));
    const create = vi.spyOn(api, "createFromFolder").mockResolvedValue({ project: project("notes"), result: result() });
    const { dialog, onCreated } = setup();
    await userEvent.click(within(dialog).getByRole("radio", { name: /folder on this computer/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Choose folder…" }));
    const path = await within(dialog).findByLabelText("Folder path");
    await userEvent.type(path, "/work/notes");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect(create).toHaveBeenCalledWith({ path: "/work/notes", includeSecrets: false });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("shows the picked folder", async () => {
    vi.spyOn(api, "pickFolder").mockResolvedValue({ path: "/work/site" });
    const { dialog } = setup();
    await userEvent.click(within(dialog).getByRole("radio", { name: /folder on this computer/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Choose folder…" }));
    expect(await within(dialog).findByText("/work/site")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Folder path")).toBeNull();
  });

  it("names possible secrets, and sends them once ticked", async () => {
    vi.spyOn(api, "githubRepos").mockResolvedValue({ repos: [{ fullName: "you/website", defaultBranch: "main", private: false }] });
    const create = vi
      .spyOn(api, "createFromGitHub")
      .mockRejectedValueOnce(new ApiError(409, "possible_secrets", { names: [".env", "deploy.pem"] }))
      .mockResolvedValueOnce({ project: project("website"), result: result() });
    const { dialog } = setup("maintainer");
    await userEvent.click(within(dialog).getByRole("radio", { name: /From GitHub/ }));
    await within(dialog).findByRole("combobox", { name: "Repository" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect(await within(dialog).findByText(/These files may contain secrets: \.env, deploy\.pem/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "include files that may contain secrets" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect(create).toHaveBeenLastCalledWith({ repo: "you/website", includeSecrets: true });
  });

  it("starts an empty project with a name", async () => {
    const create = vi.spyOn(api, "createProject").mockResolvedValue(project("Blank"));
    const { dialog, onCreated, onClose } = setup("maintainer");
    await userEvent.click(within(dialog).getByRole("radio", { name: /Start empty/ }));
    const go = within(dialog).getByRole("button", { name: "Create project" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await userEvent.type(within(dialog).getByLabelText("Name"), "Blank");
    await userEvent.click(go);
    expect(create).toHaveBeenCalledWith({ name: "Blank" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project("Blank")));
    expect(onClose).toHaveBeenCalled();
  });

  it("adds picked files to a new project with a progress bar", async () => {
    vi.spyOn(api, "createProject").mockResolvedValue(project("Docs"));
    vi.spyOn(api, "openUpload").mockResolvedValue({ uploadId: "u1" });
    const put = vi.spyOn(api, "putUploadFile").mockResolvedValue(undefined);
    vi.spyOn(api, "commitUpload").mockResolvedValue(result({ files: 2 }));
    const { dialog, onCreated } = setup("maintainer");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Docs");
    await userEvent.upload(within(dialog).getByLabelText("Choose files"), [new File(["a"], "a.txt"), new File(["b"], "b.txt")]);
    expect(within(dialog).getByText("2 files chosen · 2 B")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Create and add 2 files" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project("Docs")));
    expect(await within(dialog).findByText(/Copied in 2 files/)).toBeTruthy();
    expect(put.mock.calls.map((c) => c[1])).toEqual(["a.txt", "b.txt"]);
  });

  it("closes on Escape", async () => {
    const { onClose } = setup();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
