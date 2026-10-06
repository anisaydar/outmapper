import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CanonicalProject } from "../domain/types.js";
import { createValidProject, timestamp } from "../test/project-fixtures.js";
import { App } from "./App.js";
import type { HistoryState, ProjectApi, ProjectAssetApi, ProjectMutationResponse } from "./api/project-client.js";

/** An in-memory stand-in for the local server: canonical state, revisions, title trimming, and undo snapshots. */
function createServer(initial: CanonicalProject) {
  let project = structuredClone(initial);
  const undo: CanonicalProject[] = [];
  const redo: CanonicalProject[] = [];
  let hold: Promise<void> | undefined;
  const history = (): HistoryState => ({ canUndo: undo.length > 0, canRedo: redo.length > 0 });
  const respond = (): ProjectMutationResponse => ({ project: structuredClone(project), history: history() });
  const mutate = async (change: (next: CanonicalProject) => void) => {
    if (hold) await hold;
    undo.push(structuredClone(project));
    redo.length = 0;
    const next = structuredClone(project);
    change(next);
    next.manifest.revision = project.manifest.revision + 1;
    project = next;
    return respond();
  };
  const restore = (from: CanonicalProject[], to: CanonicalProject[]) => {
    const state = from.pop();
    if (!state) return respond();
    to.push(project);
    project = { ...structuredClone(state), manifest: { ...state.manifest, revision: project.manifest.revision + 1 } };
    return respond();
  };
  const unused = async () => respond();
  const api: ProjectApi = {
    createTopic: vi.fn(async ({ title }) => mutate((next) => { next.topics.push({ id: `topic-${next.topics.length + 1}`, title: title.trim(), createdAt: timestamp, updatedAt: timestamp }); })),
    createAndConnectTopic: vi.fn(unused),
    updateProject: vi.fn(async (patch) => mutate((next) => {
      if (patch.homeTopicId) next.manifest.homeTopicId = patch.homeTopicId;
      if (patch.title !== undefined) next.manifest.title = patch.title.trim();
    })),
    editKnowledge: unused,
    removeKnowledge: unused,
    updateTopic: vi.fn(async (id, patch) => mutate((next) => {
      const topic = next.topics.find((candidate) => candidate.id === id)!;
      if (patch.title !== undefined) topic.title = patch.title.trim();
      if (patch.description !== undefined) topic.description = patch.description;
    })),
    updateKeyIssue: vi.fn(unused),
    deleteTopic: unused,
    deleteKeyIssue: unused,
    createKeyIssue: unused,
    reorderKeyIssues: vi.fn(async (_topicId, ids) => mutate((next) => {
      for (const issue of next.keyIssues) if (ids.includes(issue.id)) issue.order = ids.indexOf(issue.id);
    })),
    connectTopics: unused,
    disconnectRelationship: unused,
    reorderRelationships: unused,
    linkProject: unused,
    unlinkProject: unused,
    reorderKeyIssueTargets: unused,
    createKnowledge: vi.fn(unused),
    updateKnowledgeAssociation: unused,
    undo: vi.fn(async () => restore(undo, redo)),
    redo: vi.fn(async () => restore(redo, undo)),
    checkpoint: vi.fn(async () => ({ checkpoint: { depth: undo.length, revision: project.manifest.revision }, history: history() })),
    revert: vi.fn(async () => mutate((next) => Object.assign(next, structuredClone(initial), { manifest: next.manifest }))),
    publish: unused
  };
  return {
    api,
    get project() { return project; },
    /** Holds every following mutation until the returned release function is called. */
    hold() {
      let release!: () => void;
      hold = new Promise((resolve) => { release = resolve; });
      return () => { hold = undefined; release(); };
    }
  };
}

function createProject() {
  const project = createValidProject();
  project.topics[0].title = "Artificial Intelligence";
  project.keyIssues.push({ id: "issue-2", topicId: "topic-1", title: "Evaluation", order: 1, createdAt: timestamp, updatedAt: timestamp });
  return project;
}

const assetApi: ProjectAssetApi = {
  attachAsset: async () => { throw new Error("not used"); },
  setCover: async () => { throw new Error("not used"); },
  removeCover: async () => { throw new Error("not used"); }
};

async function openStudio(server: ReturnType<typeof createServer>) {
  render(<App loadProject={async () => structuredClone(server.project)} api={server.api} assetApi={assetApi} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  return screen.getByLabelText<HTMLTextAreaElement>("Description");
}

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

describe("Studio editing", () => {
  it("keeps focus, caret, and every character while autosaves round-trip during continuous typing", async () => {
    const server = createServer(createProject());
    const description = await openStudio(server);
    description.focus();
    let text = "";
    for (const chunk of ["Systems ", "that act\n", "through ", "tools."]) {
      text += chunk;
      fireEvent.change(description, { target: { value: text } });
      description.setSelectionRange(3, 3);
      await wait(750);
      expect(screen.getByLabelText("Description")).toBe(description);
      expect(description).toHaveFocus();
      expect(description.selectionStart).toBe(3);
      expect(description).toHaveValue(text);
    }
    await waitFor(() => expect(server.project.topics[0].description).toBe("Systems that act\nthrough tools."));
    expect(vi.mocked(server.api.updateTopic).mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("does not drop a trailing space when the server trims the saved title", async () => {
    const server = createServer(createProject());
    await openStudio(server);
    const title = screen.getByLabelText<HTMLInputElement>("Title");
    fireEvent.change(title, { target: { value: "Machine " } });
    await waitFor(() => expect(server.project.topics[0].title).toBe("Machine"));
    await wait(50);
    expect(title).toHaveValue("Machine ");
    fireEvent.change(title, { target: { value: "Machine Minds" } });
    await waitFor(() => expect(server.project.topics[0].title).toBe("Machine Minds"));
  });

  it("preserves and saves text typed while a save is in flight", async () => {
    const server = createServer(createProject());
    const description = await openStudio(server);
    const release = server.hold();
    fireEvent.change(description, { target: { value: "First" } });
    await waitFor(() => expect(server.api.updateTopic).toHaveBeenCalledTimes(1), { timeout: 1500 });
    fireEvent.change(description, { target: { value: "First and more" } });
    release();
    await waitFor(() => expect(server.project.topics[0].description).toBe("First and more"), { timeout: 2000 });
    expect(description).toHaveValue("First and more");
    expect(vi.mocked(server.api.updateTopic).mock.calls.map(([, patch]) => patch.description)).toEqual(["First", "First and more"]);
  });

  it("keeps the Knowledge draft and the editors mounted across unrelated mutations", async () => {
    const server = createServer(createProject());
    const description = await openStudio(server);
    fireEvent.click(screen.getByRole("button", { name: "Add knowledge", expanded: false }));
    const form = screen.getByRole("form", { name: "Add knowledge" });
    fireEvent.change(within(form).getByLabelText("Item title"), { target: { value: "Draft note" } });
    fireEvent.change(screen.getByLabelText("Add Key Issue"), { target: { value: "Unsaved issue" } });
    fireEvent.click(screen.getByRole("button", { name: "Move later: Issue" }));
    await waitFor(() => expect(server.api.reorderKeyIssues).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Move earlier: Issue" })).toBeEnabled());
    expect(within(form).getByLabelText("Item title")).toHaveValue("Draft note");
    expect(screen.getByLabelText("Add Key Issue")).toHaveValue("Unsaved issue");
    expect(screen.getByLabelText("Description")).toBe(description);
  });

  it("saves a pending edit before Undo so the autosave cannot re-apply undone text", async () => {
    const server = createServer(createProject());
    await openStudio(server);
    const title = screen.getByLabelText("Title");
    fireEvent.change(title, { target: { value: "First edit" } });
    await waitFor(() => expect(server.project.topics[0].title).toBe("First edit"), { timeout: 1500 });
    fireEvent.change(title, { target: { value: "Second edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    await waitFor(() => expect(server.api.undo).toHaveBeenCalledTimes(1));
    const calls = vi.mocked(server.api.updateTopic).mock.calls.map(([, patch]) => patch.title);
    expect(calls).toEqual(["First edit", "Second edit"]);
    expect(vi.mocked(server.api.updateTopic).mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(server.api.undo).mock.invocationCallOrder[0]);
    await waitFor(() => expect(title).toHaveValue("First edit"));
    await wait(800);
    expect(server.project.topics[0].title).toBe("First edit");
    expect(server.api.updateTopic).toHaveBeenCalledTimes(2);
  });

  it("closes without asking when nothing changed, and discards a session's changes after confirmation", async () => {
    const server = createServer(createProject());
    await openStudio(server);
    fireEvent.click(screen.getByRole("button", { name: "Cancel editing" }));
    await waitFor(() => expect(screen.queryByLabelText("Title")).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(server.api.revert).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel editing" }));
    const dialog = await screen.findByRole("dialog", { name: "Discard changes?" });
    expect(within(dialog).getByText("Discard changes from this editing session?")).toBeInTheDocument();
    expect(server.project.topics[0].title).toBe("Renamed");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Title")).toHaveValue("Renamed");

    fireEvent.click(screen.getByRole("button", { name: "Cancel editing" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Discard changes?" })).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.queryByLabelText("Title")).not.toBeInTheDocument());
    expect(server.api.revert).toHaveBeenCalledWith({ depth: 0, revision: 0 });
    expect(await screen.findByRole("button", { name: "Central Topic: Artificial Intelligence" })).toBeInTheDocument();
  });

  it("creates a New Topic from the Studio bar, centers it, and focuses its title", async () => {
    const server = createServer(createProject());
    await openStudio(server);
    fireEvent.click(screen.getByRole("button", { name: "New Topic" }));
    expect(await screen.findByRole("button", { name: "Central Topic: Untitled Topic" })).toBeInTheDocument();
    const title = screen.getByLabelText<HTMLInputElement>("Title");
    await waitFor(() => expect(title).toHaveFocus());
    expect(title).toHaveValue("Untitled Topic");
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("shows the Home Topic badge, sets another Topic as Home, and shows inherited Key Issue covers", async () => {
    const project = createProject();
    project.assets.push({ id: "asset-cover", path: "assets/asset-cover/cover.png", originalFilename: "cover.png", mimeType: "image/png", byteSize: 1, sha256: "a".repeat(64), createdAt: timestamp });
    project.topics[0].visualAssetId = "asset-cover";
    const server = createServer(project);
    render(<App loadProject={async () => structuredClone(server.project)} api={server.api} assetApi={assetApi} />);
    expect(await screen.findByText("Home Topic", { selector: ".home-badge" })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /Key Issue: Issue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("Topic cover", { selector: ".studio-heading .cover-badge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set custom cover" })).toBeInTheDocument();
    expect(document.querySelector(".studio-heading .panel-cover")).toHaveAttribute("src", "/api/assets/asset-cover");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByLabelText("Title")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Related Topic: Related/ }));
    await screen.findByRole("button", { name: "Central Topic: Related" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Upload cover" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set as Home Topic" }));
    await waitFor(() => expect(server.api.updateProject).toHaveBeenCalledWith({ homeTopicId: "topic-2" }));
    expect(await screen.findByText("Home Topic", { selector: ".home-badge" })).toBeInTheDocument();
  });
});

describe("Studio follow-up authoring", () => {
  function threeIssues() {
    const project = createProject();
    project.keyIssues.push({ id: "issue-3", topicId: "topic-1", title: "Policy", order: 2, createdAt: timestamp, updatedAt: timestamp });
    return project;
  }

  function measureRows() {
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const row = this.closest<HTMLElement>("[data-reorder-id]");
      if (this.classList.contains("order-list")) return DOMRect.fromRect({ x: 0, y: 100, width: 300, height: 140 });
      if (row === this) {
        const index = [...row.parentElement!.querySelectorAll("[data-reorder-id]")].indexOf(row);
        return DOMRect.fromRect({ x: 0, y: 100 + index * 48, width: 300, height: 42 });
      }
      return original.call(this);
    });
  }

  afterEach(() => vi.restoreAllMocks());

  it("reorders Key Issues by dragging the grip, as one reorder call and one Undo step, and announces the move", async () => {
    measureRows();
    const server = createServer(threeIssues());
    await openStudio(server);
    const grip = document.querySelector<HTMLElement>("[data-reorder-id='issue-1'] .order-grip")!;
    expect(grip).toHaveAttribute("aria-hidden", "true");

    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 121 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 150 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 222 });
    expect(document.querySelector("[data-reorder-id='issue-1']")).toHaveClass("is-dragging");
    // The rows the dragged one passes slide up to open its slot.
    expect(document.querySelector("[data-reorder-id='issue-2']")).toHaveStyle({ transform: "translateY(-48px)" });
    expect(document.querySelector("[data-reorder-id='issue-3']")).toHaveStyle({ transform: "translateY(-48px)" });
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 222 });

    // The new order shows immediately on drop, before the save returns, with no slide offsets left over.
    expect([...document.querySelectorAll("[data-reorder-id]")].map((row) => row.getAttribute("data-reorder-id"))).toEqual(["issue-2", "issue-3", "issue-1"]);
    expect(document.querySelector("[data-shifted]")).toBeNull();
    await waitFor(() => expect(server.api.reorderKeyIssues).toHaveBeenCalledTimes(1));
    expect(server.api.reorderKeyIssues).toHaveBeenCalledWith("topic-1", ["issue-2", "issue-3", "issue-1"]);
    expect(screen.getByRole("status")).toHaveTextContent("Moved Issue to position 3 of 3");
    await waitFor(() => expect([...document.querySelectorAll("[data-reorder-id]")].map((row) => row.getAttribute("data-reorder-id"))).toEqual(["issue-2", "issue-3", "issue-1"]));

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect([...document.querySelectorAll("[data-reorder-id]")].map((row) => row.getAttribute("data-reorder-id"))).toEqual(["issue-1", "issue-2", "issue-3"]));
    expect(server.api.undo).toHaveBeenCalledTimes(1);
  });

  it("ignores a click on the grip without movement, and the arrow buttons still reorder", async () => {
    measureRows();
    const server = createServer(threeIssues());
    await openStudio(server);
    const grip = document.querySelector<HTMLElement>("[data-reorder-id='issue-2'] .order-grip")!;
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 169 });
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 170 });
    expect(server.api.reorderKeyIssues).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Move earlier: Evaluation" }));
    await waitFor(() => expect(server.api.reorderKeyIssues).toHaveBeenCalledWith("topic-1", ["issue-2", "issue-1", "issue-3"]));
    expect(screen.getByRole("status")).toHaveTextContent("Moved Evaluation to position 1 of 3");
  });

  it("shows a new order immediately and restores the original order when the save fails", async () => {
    measureRows();
    const server = createServer(threeIssues());
    let reject!: (error: Error) => void;
    vi.mocked(server.api.reorderKeyIssues).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await openStudio(server);
    const order = () => [...document.querySelectorAll("[data-reorder-id]")].map((row) => row.getAttribute("data-reorder-id"));

    fireEvent.click(screen.getByRole("button", { name: "Move earlier: Evaluation" }));
    expect(order()).toEqual(["issue-2", "issue-1", "issue-3"]);
    await waitFor(() => expect(server.api.reorderKeyIssues).toHaveBeenCalledTimes(1));
    reject(new Error("Disk is full"));
    await waitFor(() => expect(order()).toEqual(["issue-1", "issue-2", "issue-3"]));
  });

  it("attaches several files one at a time, keeps going after a failure, and summarizes once", async () => {
    const server = createServer(createProject());
    const order: string[] = [];
    const attachAsset = vi.fn<ProjectAssetApi["attachAsset"]>(async (file, _target, onProgress) => {
      order.push(file.name);
      onProgress?.(0.5);
      if (file.name === "broken.exe") throw new Error("File type is not supported");
      const result = await server.api.createKnowledge({ title: file.name, targetKind: "topic", targetId: "topic-1" });
      return { ...result, asset: { id: file.name, path: `assets/${file.name}`, originalFilename: file.name, mimeType: "text/plain", byteSize: 1, sha256: "a".repeat(64), createdAt: timestamp }, extraction: "not-applicable" };
    });
    render(<App loadProject={async () => structuredClone(server.project)} api={server.api} assetApi={{ ...assetApi, attachAsset }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const input = screen.getByLabelText<HTMLInputElement>("Attach file");
    expect(input).toHaveAttribute("multiple");
    fireEvent.change(input, { target: { files: [new File(["a"], "one.txt"), new File(["b"], "broken.exe"), new File(["c"], "three.txt")] } });

    expect(await screen.findByText("2 attached, 1 failed")).toBeInTheDocument();
    expect(order).toEqual(["one.txt", "broken.exe", "three.txt"]);
    const list = screen.getByRole("list", { name: "Attachments" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByRole("alert")).toHaveTextContent("File type is not supported");
    expect(within(list).getAllByText("Attached")).toHaveLength(2);
    expect(document.querySelectorAll(".toast")).toHaveLength(1);
  });

  it("shows save status beside Undo and Redo, briefly confirms a save, and shows errors as text", async () => {
    const server = createServer(createProject());
    await openStudio(server);
    const status = within(document.querySelector<HTMLElement>(".studio-bar")!).getByRole("status");
    expect(status.closest(".save-state-slot")?.previousElementSibling).toHaveClass("studio-bar__history");
    expect(status).toHaveClass("save-state--idle");
    expect(status).toHaveTextContent("Autosaved");
    const label = status.querySelector(".save-state__label")!;
    expect(label).toHaveAttribute("aria-hidden", "true");
    expect(label).toHaveAttribute("data-visible", "false");

    const title = screen.getByLabelText("Title");
    fireEvent.change(title, { target: { value: "Renamed" } });
    await waitFor(() => expect(label).toHaveAttribute("data-visible", "true"), { timeout: 2000 });
    expect(label).toHaveTextContent("Saved");
    expect(status).toHaveClass("save-state--flash");
    await waitFor(() => expect(label).toHaveAttribute("data-visible", "false"), { timeout: 3000 });

    vi.mocked(server.api.updateTopic).mockRejectedValueOnce(new Error("Disk is full"));
    fireEvent.change(title, { target: { value: "Renamed again" } });
    await waitFor(() => expect(status).toHaveClass("save-state--error"), { timeout: 2000 });
    expect(label).toHaveAttribute("data-visible", "true");
    expect(label).toHaveTextContent("Could not save");
    expect(status).toHaveTextContent("Could not save");
  });

  it("adds a Key Issue from the inline field, whose Add action is enabled only with text", async () => {
    const server = createServer(createProject());
    const createKeyIssue = vi.fn(server.api.createKeyIssue);
    server.api.createKeyIssue = createKeyIssue;
    await openStudio(server);
    const input = screen.getByLabelText("Add Key Issue");
    const add = screen.getByRole("button", { name: "Add" });
    expect(input).toHaveAttribute("placeholder", "New Key Issue title");
    expect(add).toBeDisabled();
    fireEvent.change(input, { target: { value: "   " } });
    expect(add).toBeDisabled();
    fireEvent.change(input, { target: { value: "Safety" } });
    expect(add).toBeEnabled();
    expect(add.closest("form")).toBe(input.closest("form"));

    // Enter in the field submits its form natively; jsdom does not implement implicit submission, so submit directly.
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(createKeyIssue).toHaveBeenCalledWith({ topicId: "topic-1", title: "Safety" }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(add).toBeDisabled();
  });

  it("grows the description field with its content", async () => {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
      return this instanceof HTMLTextAreaElement ? 22 * this.value.split("\n").length : 0;
    });
    const server = createServer(createProject());
    const description = await openStudio(server);
    expect(description).toHaveClass("studio-description");
    fireEvent.change(description, { target: { value: Array.from({ length: 9 }, (_, index) => `Line ${index + 1}`).join("\n") } });
    expect(description.style.height).toBe(`${22 * 9}px`);
    fireEvent.change(description, { target: { value: "Short" } });
    expect(description.style.height).toBe("22px");
  });

  it("names the cover controls for empty, own, and inherited covers", async () => {
    const project = createProject();
    project.assets.push({ id: "asset-cover", path: "assets/asset-cover/cover.png", originalFilename: "cover.png", mimeType: "image/png", byteSize: 1, sha256: "a".repeat(64), createdAt: timestamp });
    const server = createServer(project);
    render(<App loadProject={async () => structuredClone(server.project)} api={server.api} assetApi={assetApi} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const upload = screen.getByRole("button", { name: "Upload cover" });
    expect(upload).toHaveClass("cover-upload");
    expect(within(upload).getByText("Upload cover")).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByLabelText("Title")).not.toBeInTheDocument());

    cleanup();
    project.topics[0].visualAssetId = "asset-cover";
    const covered = createServer(project);
    render(<App loadProject={async () => structuredClone(covered.project)} api={covered.api} assetApi={assetApi} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Replace cover" })).toHaveAttribute("data-tooltip", "Replace cover");
    expect(screen.getByRole("button", { name: "Remove cover" })).toHaveClass("icon-action", "icon-action--danger");
    expect(screen.queryByRole("button", { name: "Upload cover" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByLabelText("Title")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Key Issue: Issue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Set custom cover" })).toHaveClass("cover-upload");
  });
});
