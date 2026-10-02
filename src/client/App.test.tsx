import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CanonicalProject } from "../domain/types.js";
import { createValidProject, timestamp } from "../test/project-fixtures.js";
import { App } from "./App.js";
import { localeNames, messages, type Locale } from "./locales.js";
import type { FolderImportApi, ProjectApi, ProjectAssetApi, ProjectMutationResponse, ProjectSearch, ProjectTransferApi } from "./api/project-client.js";

const pendingLoader = () => new Promise<CanonicalProject>(() => undefined);

function createMapProject(): CanonicalProject {
  const project = createValidProject();
  project.keyIssues[0].title = "Agents & Autonomy";
  project.keyIssues[0].description = "Systems that act through tools.";
  project.topics[0].title = "Artificial Intelligence";
  project.topics[1].title = "Science";
  project.topics[1].description = "Methods and institutions for discovery.";
  project.keyIssues.push({
    id: "issue-2",
    topicId: "topic-1",
    title: "Research & Evaluation",
    order: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  project.relationships.push({
    id: "relationship-2",
    sourceTopicId: "topic-1",
    keyIssueId: "issue-2",
    targetTopicId: "topic-2",
    order: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  project.keyIssues.push({
    id: "issue-science",
    topicId: "topic-2",
    title: "AI-enabled Discovery",
    order: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  project.relationships.push({
    id: "relationship-cycle",
    sourceTopicId: "topic-2",
    keyIssueId: "issue-science",
    targetTopicId: "topic-1",
    order: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  project.knowledgeItems.push(
    {
      id: "knowledge-topic",
      type: "article",
      title: "Topic brief",
      availability: "external",
      externalUrl: "https://example.org/topic",
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "knowledge-issue",
      type: "note",
      title: "Issue note",
      availability: "local",
      createdAt: timestamp,
      updatedAt: timestamp
    }
  );
  project.associations.push(
    {
      id: "association-topic",
      knowledgeItemId: "knowledge-topic",
      targetKind: "topic",
      targetId: "topic-1"
    },
    {
      id: "association-issue",
      knowledgeItemId: "knowledge-issue",
      targetKind: "keyIssue",
      targetId: "issue-1",
      pinned: true
    }
  );
  return project;
}

function apiFor(project: CanonicalProject, updateTopic?: ProjectApi["updateTopic"]): ProjectApi {
  const unchanged = async (): Promise<ProjectMutationResponse> => ({
    project,
    history: { canUndo: false, canRedo: false }
  });
  return {
    createTopic: unchanged,
    editKnowledge: unchanged,
    removeKnowledge: unchanged,
    updateTopic: updateTopic ?? unchanged,
    updateKeyIssue: unchanged,
    deleteTopic: unchanged,
    deleteKeyIssue: unchanged,
    createKeyIssue: unchanged,
    reorderKeyIssues: unchanged,
    connectTopics: unchanged,
    disconnectRelationship: unchanged,
    reorderRelationships: unchanged,
    createKnowledge: unchanged,
    updateKnowledgeAssociation: unchanged,
    undo: unchanged,
    redo: unchanged,
    publish: unchanged
  };
}

describe("application shell", () => {
  it("renders map and knowledge regions", () => {
    render(<App loadProject={pendingLoader} />);

    expect(screen.getByRole("region", { name: "Topic map" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Knowledge panel" })).toBeInTheDocument();
  });

  it("applies locale direction and theme", () => {
    const icon = document.createElement("link");
    icon.rel = "icon";
    document.head.append(icon);
    const themeColor = document.createElement("meta");
    themeColor.name = "theme-color";
    document.head.append(themeColor);
    render(<App loadProject={pendingLoader} />);
    expect(document.querySelector(".brand-mark")).toHaveAttribute("src", "/brand/outmapper-mark-light.svg");
    expect(icon).toHaveAttribute("href", "/brand/outmapper-mark-light.svg");
    expect(themeColor).toHaveAttribute("content", "#0b0b0d");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("Outmapper 0.1.0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Language: English" }));
    fireEvent.click(screen.getByRole("option", { name: "العربية" }));
    fireEvent.click(screen.getByRole("button", { name: "فاتح" }));

    expect(document.documentElement).toHaveAttribute("dir", "rtl");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.querySelector(".brand-mark")).toHaveAttribute("src", "/brand/outmapper-mark-dark.svg");
    expect(icon).toHaveAttribute("href", "/brand/outmapper-mark-dark.svg");
    expect(themeColor).toHaveAttribute("content", "#eceef2");
    expect(screen.getByRole("region", { name: "خريطة الموضوع" })).toBeInTheDocument();
    icon.remove();
    themeColor.remove();
  });

  it("exports and validates an import before committing it to a new Project folder", async () => {
    const importedProject = createMapProject();
    importedProject.topics[0].title = "Imported Home";
    const transferApi: ProjectTransferApi = {
      exportProject: vi.fn(async () => undefined),
      previewImport: vi.fn(async () => ({
        id: "plan-1",
        projectId: "project-portable",
        projectTitle: "Portable Project",
        projectRevision: 4,
        formatVersion: 1,
        compressedBytes: 120,
        expandedBytes: 400,
        entryCount: 9,
        assetCount: 2,
        missingAssets: [],
        warnings: [],
        suggestedDirectoryName: "portable-project"
      })),
      commitImport: vi.fn(async (_id, directoryName) => ({
        plan: {
          id: "plan-1",
          projectId: "project-portable",
          projectTitle: "Portable Project",
          projectRevision: 4,
          formatVersion: 1,
          compressedBytes: 120,
          expandedBytes: 400,
          entryCount: 9,
          assetCount: 2,
          missingAssets: [],
          warnings: [],
          suggestedDirectoryName: "portable-project"
        },
        projectDirectory: `C:\\Projects\\${directoryName}`,
        project: importedProject,
        history: { canUndo: false, canRedo: false }
      })),
      cancelImport: vi.fn(async () => undefined)
    };
    render(<App loadProject={pendingLoader} transferApi={transferApi} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    fireEvent.click(screen.getByRole("button", { name: "Export Project…" }));
    await waitFor(() => expect(transferApi.exportProject).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Import Project package…" }));
    const picker = screen.getByRole("dialog", { name: "Import Project package" });
    expect(within(picker).getByRole("button", { name: /Choose package to import/ })).toHaveClass("asset-dropzone");
    const input = within(picker).getByLabelText<HTMLInputElement>("Import Project package…");
    expect(input).not.toHaveAttribute("accept");
    fireEvent.change(input, { target: { files: [new File(["x"], "notes.zip")] } });
    expect(within(picker).getByRole("alert")).toHaveTextContent("Choose an .outmapper Project package.");
    expect(transferApi.previewImport).not.toHaveBeenCalled();
    const file = new File(["package"], "portable.outmapper", { type: "application/vnd.outmapper.package+zip" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByRole("dialog", { name: "Portable Project" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Import Project package" })).not.toBeInTheDocument();
    const directory = screen.getByLabelText("Project folder");
    expect(directory).toHaveFocus();
    fireEvent.change(directory, { target: { value: "portable-copy" } });
    fireEvent.click(screen.getByRole("button", { name: "Import Project" }));

    await waitFor(() => expect(transferApi.commitImport).toHaveBeenCalledWith("plan-1", "portable-copy"));
    expect(await screen.findByRole("button", { name: "Central Topic: Imported Home" })).toBeInTheDocument();
  });

  it("places imports before Export Project and keeps folder selection inside one dialog", async () => {
    const project = createMapProject();
    const folderApi: FolderImportApi = {
      preview: vi.fn<FolderImportApi["preview"]>(async () => ({
        id: "folder-plan",
        folder: "C:\\Research",
        files: [{ id: "file-1", path: "notes.md", bytes: 24, kind: "note", duplicate: false }]
      })),
      discard: vi.fn(async () => undefined),
      start: vi.fn<FolderImportApi["start"]>(async () => ({ id: "job-1", status: "running", processed: 0, total: 1, imported: 0, skipped: 0, failures: [] })),
      status: vi.fn<FolderImportApi["status"]>(async () => ({ job: { id: "job-1", status: "completed", processed: 1, total: 1, imported: 1, skipped: 0, failures: [] } })),
      cancel: vi.fn(async () => undefined)
    };
    render(<App loadProject={async () => project} folderApi={folderApi} />);
    await screen.findByRole("button", { name: "Central Topic: Artificial Intelligence" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const settings = screen.getByRole("dialog", { name: "Settings" });
    const importFolder = within(settings).getByRole("button", { name: "Import folder..." });
    const importPackage = within(settings).getByRole("button", { name: "Import Project package…" });
    const exportProject = within(settings).getByRole("button", { name: "Export Project…" });
    const actions = within(settings).getAllByRole("button");
    expect(actions.indexOf(importFolder)).toBeLessThan(actions.indexOf(exportProject));
    expect(actions.indexOf(importPackage)).toBeLessThan(actions.indexOf(exportProject));

    fireEvent.click(importFolder);
    const dialog = screen.getByRole("dialog", { name: "Import folder..." });
    const chooseFolder = within(dialog).getByRole("button", { name: /Choose folder to import/ });
    expect(chooseFolder).toHaveClass("asset-dropzone");
    expect(within(dialog).getByText(/review its supported files/)).toBeInTheDocument();
    fireEvent.click(chooseFolder);

    await waitFor(() => expect(folderApi.preview).toHaveBeenCalledOnce());
    expect(await within(dialog).findByText("C:\\Research")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Import files" })).toBeEnabled();
    expect(screen.getAllByRole("dialog", { name: "Import folder..." })).toHaveLength(1);
  });

  it("creates the first Topic from an empty Project", async () => {
    const empty = createValidProject();
    empty.topics = [];
    empty.keyIssues = [];
    empty.relationships = [];
    empty.knowledgeItems = [];
    empty.associations = [];
    delete empty.manifest.homeTopicId;
    const api = apiFor(empty);
    const createTopic = vi.spyOn(api, "createTopic").mockImplementation(async ({ title }) => {
      const next = structuredClone(empty);
      next.topics.push({ id: "topic-first", title, createdAt: timestamp, updatedAt: timestamp });
      next.manifest.homeTopicId = "topic-first";
      next.manifest.revision += 1;
      return { project: next, history: { canUndo: true, canRedo: false } };
    });
    render(<App loadProject={async () => empty} api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add Topic" }));
    const dialog = screen.getByRole("dialog", { name: "Add Topic" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "First Topic" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Topic" }));

    await waitFor(() => expect(createTopic).toHaveBeenCalledWith({ title: "First Topic" }));
    expect(await screen.findByRole("button", { name: "Central Topic: First Topic" })).toBeInTheDocument();
  });

  it("edits and removes shared Knowledge with an explicit scope", async () => {
    const project = createMapProject();
    project.associations.push({ id: "association-topic-shared", knowledgeItemId: "knowledge-topic", targetKind: "topic", targetId: "topic-2" });
    const api = apiFor(project);
    const editKnowledge = vi.spyOn(api, "editKnowledge");
    const removeKnowledge = vi.spyOn(api, "removeKnowledge").mockResolvedValue({ project, history: { canUndo: true, canRedo: false } });
    render(<App loadProject={async () => project} api={api} />);
    const item = await screen.findByRole("button", { name: /Topic brief/ });
    fireEvent.click(item);
    const article = item.closest("article")!;
    fireEvent.click(within(article).getByRole("button", { name: "Edit item" }));
    const editDialog = screen.getByRole("dialog", { name: "Edit item" });
    expect(within(editDialog).getByText("This item is used in multiple places.")).toBeInTheDocument();
    fireEvent.change(within(editDialog).getByLabelText("Item title"), { target: { value: "Updated brief" } });
    fireEvent.change(within(editDialog).getByLabelText("Apply to"), { target: { value: "all" } });
    fireEvent.click(within(editDialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(editKnowledge).toHaveBeenCalledWith("association-topic", expect.objectContaining({ title: "Updated brief", scope: "all" })));

    fireEvent.click(screen.getByRole("button", { name: /Topic brief/ }));
    fireEvent.click(within(article).getByRole("button", { name: "Remove item" }));
    const removeDialog = screen.getByRole("dialog", { name: "Remove item" });
    fireEvent.change(within(removeDialog).getByLabelText("Apply to"), { target: { value: "all" } });
    fireEvent.click(within(removeDialog).getByRole("button", { name: "Remove item" }));
    await waitFor(() => expect(removeKnowledge).toHaveBeenCalledWith("association-topic", "all"));
    expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("opens global search by keyboard, filters through the adapter, and restores contextual focus", async () => {
    const search = vi.fn<ProjectSearch>(async () => ({
      items: [
        {
          id: "issue-1",
          kind: "keyIssue",
          title: "Agents & Autonomy",
          summary: "Systems that act through tools.",
          contexts: [{ topicId: "topic-1", keyIssueId: "issue-1" }],
          score: 1
        }
      ],
      total: 1
    }));
    render(<App loadProject={async () => createMapProject()} search={search} />);
    await screen.findByRole("button", { name: "Central Topic: Artificial Intelligence" });

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("searchbox", { name: "Search" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "agents" } });
    const result = await within(screen.getByRole("dialog", { name: "Search" })).findByRole("button", { name: /Agents & Autonomy/ });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ text: "agents", match: "prefix" }));
    expect(result.lastElementChild).toHaveClass("search-result__type");
    expect(result.lastElementChild).toHaveTextContent("Key Issue");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(result).toHaveFocus();
    fireEvent.keyDown(result, { key: "ArrowUp" });
    expect(input).toHaveFocus();
    fireEvent.click(result);

    expect(await screen.findByRole("heading", { name: "Agents & Autonomy" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /Key Issue: Agents & Autonomy/ })).toHaveFocus());
    const searchButton = screen.getByRole("button", { name: "Search" });
    fireEvent.click(searchButton);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(searchButton).toHaveFocus());
  });
});

describe("attachment feedback", () => {
  it("keeps a failed attachment in Studio with an inline error and no duplicate toast", async () => {
    const initial = createMapProject();
    const attachAsset = vi.fn<ProjectAssetApi["attachAsset"]>(async () => { throw new Error("File type is not supported"); });
    render(<App loadProject={async () => initial} api={apiFor(initial)} assetApi={{ attachAsset }} />);
    await screen.findByRole("button", { name: "Central Topic: Artificial Intelligence" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Attach file"), { target: { files: [new File(["x"], "bad.exe")] } });

    expect(await screen.findByRole("alert")).toHaveTextContent("File type is not supported");
    expect(screen.getByRole("button", { name: /Attach file/ })).toBeEnabled();
    expect(document.querySelector(".toast")).not.toBeInTheDocument();
  });
});

describe("radial Map Viewer", () => {
  it("uses managed cover assets in the graph and panel, with a Topic fallback for Key Issues", async () => {
    const project = createMapProject();
    project.assets.push(
      { id: "asset-topic-cover", path: "assets/topic.png", originalFilename: "topic.png", mimeType: "image/png", byteSize: 1, sha256: "a".repeat(64), createdAt: timestamp },
      { id: "asset-issue-cover", path: "assets/issue.jpg", originalFilename: "issue.jpg", mimeType: "image/jpeg", byteSize: 1, sha256: "b".repeat(64), createdAt: timestamp }
    );
    project.topics[0].visualAssetId = "asset-topic-cover";
    project.keyIssues[1].visualAssetId = "asset-issue-cover";
    render(<App loadProject={async () => project} />);
    await screen.findByRole("button", { name: "Central Topic: Artificial Intelligence" });
    const centralImage = document.querySelector(".central-node image")!;
    expect(centralImage).toHaveAttribute("href", "/api/assets/asset-topic-cover");
    expect(centralImage).toHaveAttribute("preserveAspectRatio", "xMidYMid slice");
    expect(document.querySelector(".panel-cover")).toHaveAttribute("src", "/api/assets/asset-topic-cover");

    fireEvent.click(screen.getByRole("button", { name: /Key Issue: Agents & Autonomy/ }));
    expect(document.querySelector(".panel-cover")).toHaveAttribute("src", "/api/assets/asset-topic-cover");
    fireEvent.click(screen.getByRole("button", { name: /Key Issue: Research & Evaluation/ }));
    expect(document.querySelector(".panel-cover")).toHaveAttribute("src", "/api/assets/asset-issue-cover");
    expect(centralImage).toHaveAttribute("href", "/api/assets/asset-topic-cover");

    fireEvent.error(centralImage);
    fireEvent.error(document.querySelector(".panel-cover")!);
    expect(centralImage).toHaveStyle({ display: "none" });
    expect(document.querySelector(".panel-cover")).toHaveStyle({ display: "none" });
    expect(screen.getByRole("button", { name: "Central Topic: Artificial Intelligence" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Research & Evaluation" })).toBeInTheDocument();
  });

  it("keeps the fallback cover when a visual asset is unavailable or is not an inline image", async () => {
    const project = createMapProject();
    project.topics[0].visualAssetId = "asset-document";
    project.assets.push({ id: "asset-document", path: "assets/file.pdf", originalFilename: "file.pdf", mimeType: "application/pdf", byteSize: 1, sha256: "a".repeat(64), createdAt: timestamp });
    render(<App loadProject={async () => project} />);
    await screen.findByRole("button", { name: "Central Topic: Artificial Intelligence" });
    expect(document.querySelector(".central-node image")).not.toBeInTheDocument();
    expect(document.querySelector(".panel-cover")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Related Topic: Science/ }));
    expect(await screen.findByRole("button", { name: "Central Topic: Science" })).toHaveFocus();
    expect(document.querySelector(".central-node image")).not.toBeInTheDocument();
  });

  it("renders a real projection with one shared Related Topic and multiple SVG edges", async () => {
    render(<App loadProject={async () => createMapProject()} />);

    expect(await screen.findByRole("button", { name: "Central Topic: Artificial Intelligence" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Key Issue: Agents & Autonomy/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Key Issue: Research & Evaluation/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Related Topic: Science/ })).toHaveLength(1);
    expect(document.querySelectorAll("[data-edge-id]")).toHaveLength(2);
  });

  it("selects a Key Issue, highlights its relationships, and synchronizes context", async () => {
    render(<App loadProject={async () => createMapProject()} />);
    const issue = await screen.findByRole("button", { name: /Key Issue: Agents & Autonomy/ });

    fireEvent.click(issue);

    expect(issue).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector('[data-edge-id="relationship-1"]')).toHaveClass("is-highlighted");
    expect(document.querySelector('[data-edge-id="relationship-2"]')).toHaveClass("is-dimmed");
    expect(screen.getByRole("heading", { name: "Agents & Autonomy" })).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByRole("button", { name: /Related Topic: Science/ }));
    expect(issue).toHaveClass("is-selected");
    expect(document.querySelector('[data-edge-id="relationship-1"]')).toHaveClass("is-highlighted");
    expect(document.querySelector('[data-edge-id="relationship-2"]')).toHaveClass("is-dimmed");
  });

  it("opens a Related Topic directly from the outer ring", async () => {
    render(<App loadProject={async () => createMapProject()} />);
    const topic = await screen.findByRole("button", { name: /Related Topic: Science/ });

    fireEvent.click(topic);

    expect(await screen.findByRole("button", { name: "Central Topic: Science" })).toHaveFocus();
    expect(screen.queryByRole("region", { name: "Related Topic: Science" })).not.toBeInTheDocument();
  });

  it("promotes an unconnected Topic after a Key Issue selection without opening a preview", async () => {
    const project = createMapProject();
    project.topics.push({ id: "topic-3", title: "World Models", createdAt: timestamp, updatedAt: timestamp });
    project.relationships.push({
      id: "relationship-3",
      sourceTopicId: "topic-1",
      keyIssueId: "issue-2",
      targetTopicId: "topic-3",
      order: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    render(<App loadProject={async () => project} />);
    const issue = await screen.findByRole("button", { name: /Key Issue: Agents & Autonomy/ });
    fireEvent.click(issue);
    const topic = screen.getByRole("button", { name: /Related Topic: World Models/ });
    expect(topic).toHaveClass("is-dimmed");

    fireEvent.click(topic);

    expect(topic).toHaveClass("is-promoting", "is-selected");
    expect(topic).toHaveAttribute("aria-pressed", "true");
    expect(issue).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("region", { name: "Related Topic: World Models" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Central Topic: World Models" })).toHaveFocus();
  });

  it("provides a semantic relationship navigator from the same projection", async () => {
    render(<App loadProject={async () => createMapProject()} />);
    await screen.findByRole("button", { name: "Central Topic: Artificial Intelligence" });

    fireEvent.click(screen.getByRole("button", { name: "Semantic relationships" }));

    const navigator = screen.getByRole("region", { name: "Semantic relationships" });
    expect(navigator).toHaveTextContent("Agents & Autonomy");
    expect(navigator).toHaveTextContent("Research & Evaluation");
    expect(navigator).toHaveTextContent("Also via Research & Evaluation");
  });

  it("keeps graph coordinates unchanged when the interface switches to Arabic RTL", async () => {
    render(<App loadProject={async () => createMapProject()} />);
    const topic = await screen.findByRole("button", { name: /Related Topic: Science/ });
    const before = topic.getAttribute("style");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Language: English" }));
    fireEvent.click(screen.getByRole("option", { name: "العربية" }));

    await waitFor(() => expect(document.documentElement).toHaveAttribute("dir", "rtl"));
    expect(topic.getAttribute("style")).toBe(before);
    expect(topic).toHaveAttribute("aria-label", expect.stringContaining("موضوع ذو صلة"));
  });

  it("collapses and reopens the panel without clearing selection", async () => {
    render(<App loadProject={async () => createMapProject()} />);
    const issue = await screen.findByRole("button", { name: /Key Issue: Agents & Autonomy/ });
    fireEvent.click(issue);

    fireEvent.click(screen.getByRole("button", { name: "Hide Panel" }));
    expect(document.querySelector(".workspace")).toHaveClass("is-panel-closed");
    fireEvent.click(screen.getByRole("button", { name: "Show Panel" }));

    expect(issue).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Agents & Autonomy" })).toBeInTheDocument();
  });

  it("queries Topic and Key Issue Knowledge independently and keeps availability explicit", async () => {
    render(<App loadProject={async () => createMapProject()} />);

    expect(await screen.findByText("Topic brief")).toBeInTheDocument();
    expect(screen.getByText("External")).toBeInTheDocument();
    expect(screen.queryByText("Issue note")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Key Issue: Agents & Autonomy/ }));

    expect(screen.getByText("Issue note")).toBeInTheDocument();
    expect(screen.getByText("On device")).toBeInTheDocument();
    expect(screen.queryByText("Topic brief")).not.toBeInTheDocument();
  });

  it("opens Related Topics directly and supports cycles, back, home, and focus restoration", async () => {
    render(<App loadProject={async () => createMapProject()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Related Topic: Science/ }));

    const science = await screen.findByRole("button", { name: "Central Topic: Science" });
    expect(science).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: /Related Topic: Artificial Intelligence/ }));
    expect(await screen.findByRole("button", { name: "Central Topic: Artificial Intelligence" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: "Central Topic: Science" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(await screen.findByRole("button", { name: "Central Topic: Artificial Intelligence" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  });

  it("autosaves Studio edits through the canonical API and finishes with Done", async () => {
    const initial = createMapProject();
    const updateTopic = vi.fn<ProjectApi["updateTopic"]>(async (_id, patch) => {
      const next = structuredClone(initial);
      next.topics[0] = { ...next.topics[0], ...patch, updatedAt: timestamp };
      next.manifest.revision += 1;
      return { project: next, history: { canUndo: true, canRedo: false } };
    });
    render(<App loadProject={async () => initial} api={apiFor(initial, updateTopic)} />);
    await screen.findByRole("button", { name: "Central Topic: Artificial Intelligence" });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const title = screen.getByLabelText("Title");
    fireEvent.change(title, { target: { value: "Machine Intelligence" } });

    await waitFor(() => expect(updateTopic).toHaveBeenCalledWith("topic-1", expect.objectContaining({ title: "Machine Intelligence" })), { timeout: 1500 });
    expect(screen.getByText("Autosaved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(screen.queryByLabelText("Title")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Central Topic: Machine Intelligence" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toHaveFocus());
  });

  it.each([
    ["article", "publications", "topic"],
    ["research-paper", "publications", "keyIssue"],
    ["video", "videos", "topic"],
    ["dataset", "data", "keyIssue"],
    ["web-link", "publications", "topic"]
  ] as const)("adds %s through the knowledge form to %s in its active %s context", async (type, section, targetKind) => {
    const project = createMapProject();
    const api = apiFor(project);
    const createKnowledge = vi.spyOn(api, "createKnowledge").mockImplementation(async (input) => {
      const next = structuredClone(project);
      const { targetKind: kind, targetId, ...item } = input;
      next.knowledgeItems.push({ ...item, id: "added-resource", type: input.type!, availability: input.availability!, createdAt: timestamp, updatedAt: timestamp });
      next.associations.push({ id: "added-association", knowledgeItemId: "added-resource", targetKind: kind, targetId });
      next.manifest.revision += 1;
      return { project: next, history: { canUndo: true, canRedo: false } };
    });
    render(<App loadProject={async () => project} api={api} />);
    await screen.findByRole("button", { name: "Edit" });
    if (targetKind === "keyIssue") fireEvent.click(screen.getByRole("button", { name: /Key Issue: Agents & Autonomy/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form", { name: "Add knowledge" });
    fireEvent.change(within(form).getByLabelText("Type"), { target: { value: type } });
    fireEvent.change(within(form).getByLabelText("Item title"), { target: { value: "  Added resource  " } });
    fireEvent.change(within(form).getByLabelText("Resource URL"), { target: { value: "  https://example.org/resource  " } });
    fireEvent.change(within(form).getByLabelText("Description (optional)"), { target: { value: "A useful description." } });
    fireEvent.submit(form);

    await waitFor(() => expect(createKnowledge).toHaveBeenCalledOnce());
    expect(createKnowledge).toHaveBeenCalledWith({
      title: "Added resource", body: "A useful description.", type, availability: "external", externalUrl: "https://example.org/resource",
      targetKind, targetId: targetKind === "topic" ? "topic-1" : "issue-1"
    });
    await waitFor(() => expect(screen.getByLabelText("Item title")).toHaveValue(""));
    await waitFor(() => expect(screen.getByLabelText("Item title")).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Close Studio" }));
    const item = await screen.findByRole("button", { name: /Added resource/ });
    expect(item.closest("[data-section-kind]")).toHaveAttribute("data-section-kind", section);
    fireEvent.click(item);
    expect(within(item.closest("article")!).getByRole("link")).toHaveAttribute("href", "https://example.org/resource");
    expect(within(item.closest("article")!).getByRole("link")).toHaveAttribute("rel", "noreferrer");
  });

  it("keeps notes local when switching back from a linked knowledge type", async () => {
    const project = createMapProject();
    const api = apiFor(project);
    const createKnowledge = vi.spyOn(api, "createKnowledge");
    render(<App loadProject={async () => project} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form", { name: "Add knowledge" });
    expect(within(form).getByLabelText("Type")).toHaveValue("note");
    expect(within(form).queryByLabelText("Resource URL")).not.toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Add note" })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Type"), { target: { value: "video" } });
    fireEvent.change(within(form).getByLabelText("Resource URL"), { target: { value: "https://example.org/video" } });
    fireEvent.change(within(form).getByLabelText("Type"), { target: { value: "note" } });
    fireEvent.change(within(form).getByLabelText("Item title"), { target: { value: "Reading note" } });
    fireEvent.change(within(form).getByLabelText("Note body"), { target: { value: "My own notes." } });
    fireEvent.click(within(form).getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(createKnowledge).toHaveBeenCalledWith({ title: "Reading note", body: "My own notes.", type: "note", availability: "local", targetKind: "topic", targetId: "topic-1" }));
  });

  it.each(["en", "ar", "ru"] as const)("validates knowledge URLs accessibly in %s and preserves entries across locale changes", async (locale) => {
    const project = createMapProject();
    const api = apiFor(project);
    const createKnowledge = vi.spyOn(api, "createKnowledge");
    render(<App loadProject={async () => project} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "research-paper" } });
    fireEvent.change(screen.getByLabelText("Item title"), { target: { value: "Research draft" } });
    if (locale !== "en") {
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      fireEvent.click(screen.getByRole("button", { name: "Language: English" }));
      fireEvent.click(screen.getByRole("option", { name: localeNames[locale] }));
      fireEvent.click(screen.getByRole("button", { name: messages[locale].settings }));
    }
    const labels = messages[locale];
    const form = screen.getByRole("form", { name: labels.addKnowledge });
    expect(within(form).getByLabelText(labels.knowledgeTitle)).toHaveValue("Research draft");
    expect(within(form).getByLabelText(labels.knowledgeType)).toHaveDisplayValue(labels.researchPaperType);
    const url = within(form).getByLabelText(labels.knowledgeUrl);
    expect(url).toHaveAttribute("dir", "ltr");
    for (const invalid of ["", "not a URL", "https:example.org", "javascript:alert(1)", "file:///notes.pdf"]) {
      fireEvent.change(url, { target: { value: invalid } });
      fireEvent.submit(form);
      expect(url).toHaveFocus();
      expect(url).toHaveAttribute("aria-invalid", "true");
      expect(url).toHaveAccessibleDescription(labels.knowledgeUrlInvalid);
      expect(within(form).getByRole("alert")).toHaveTextContent(labels.knowledgeUrlInvalid);
      expect(createKnowledge).not.toHaveBeenCalled();
    }
    fireEvent.change(url, { target: { value: "https://example.org/paper" } });
    fireEvent.submit(form);
    await waitFor(() => expect(createKnowledge).toHaveBeenCalledOnce());
  });

  it("guards duplicate knowledge submissions and retains the draft for retry after a failed save", async () => {
    const project = createMapProject();
    const api = apiFor(project);
    let rejectSave!: (error: Error) => void;
    const createKnowledge = vi.spyOn(api, "createKnowledge")
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    render(<App loadProject={async () => project} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form", { name: "Add knowledge" });
    fireEvent.change(within(form).getByLabelText("Type"), { target: { value: "article" } });
    fireEvent.change(within(form).getByLabelText("Item title"), { target: { value: "Retry article" } });
    fireEvent.change(within(form).getByLabelText("Resource URL"), { target: { value: "https://example.org/article" } });
    fireEvent.change(within(form).getByLabelText("Description (optional)"), { target: { value: "Keep this description." } });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(createKnowledge).toHaveBeenCalledOnce();
    expect(form).toHaveAttribute("aria-busy", "true");
    expect(within(form).getByRole("button", { name: messages.en.knowledgeAdding })).toBeDisabled();
    expect(within(form).getByLabelText("Resource URL")).toBeDisabled();
    rejectSave(new Error("Unavailable"));
    expect(await within(form).findByRole("alert")).toHaveTextContent(messages.en.knowledgeAddError);
    expect(within(form).getByLabelText("Item title")).toHaveValue("Retry article");
    expect(within(form).getByLabelText("Resource URL")).toHaveValue("https://example.org/article");
    expect(within(form).getByLabelText("Description (optional)")).toHaveValue("Keep this description.");
    fireEvent.submit(form);
    await waitFor(() => expect(createKnowledge).toHaveBeenCalledTimes(2));
    expect(createKnowledge.mock.calls[1]).toEqual(createKnowledge.mock.calls[0]);
    await waitFor(() => expect(screen.getByLabelText("Item title")).toHaveValue(""));
  });

  it("flushes pending edits when closing Studio and returns focus to Edit", async () => {
    const project = createMapProject();
    const updateTopic = vi.fn<ProjectApi["updateTopic"]>(async (_id, patch) => {
      const next = structuredClone(project);
      Object.assign(next.topics[0], patch);
      next.manifest.revision += 1;
      return { project: next, history: { canUndo: true, canRedo: false } };
    });
    render(<App loadProject={async () => project} api={apiFor(project, updateTopic)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Updated before closing" } });
    fireEvent.click(screen.getByRole("button", { name: "Close Studio" }));

    await waitFor(() => expect(screen.queryByLabelText("Title")).not.toBeInTheDocument());
    expect(updateTopic).toHaveBeenCalledTimes(1);
    expect(updateTopic).toHaveBeenCalledWith("topic-1", expect.objectContaining({ title: "Updated before closing" }));
    expect(screen.getByRole("button", { name: "Central Topic: Updated before closing" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toHaveFocus());
  });

  it("requires confirmation to delete a Key Issue and restores it through Undo", async () => {
    const project = createMapProject();
    const deleted = structuredClone(project);
    deleted.keyIssues = deleted.keyIssues.filter(({ id }) => id !== "issue-1");
    deleted.relationships = deleted.relationships.filter(({ keyIssueId }) => keyIssueId !== "issue-1");
    deleted.associations = deleted.associations.filter(({ targetId }) => targetId !== "issue-1");
    deleted.manifest.revision += 1;
    const api = apiFor(project);
    api.deleteKeyIssue = vi.fn(async () => ({ project: deleted, history: { canUndo: true, canRedo: false } }));
    api.undo = vi.fn(async () => ({ project, history: { canUndo: false, canRedo: true } }));
    render(<App loadProject={async () => project} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /Key Issue: Agents & Autonomy/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Key Issue" }));
    const confirmation = screen.getByRole("dialog", { name: "Delete Key Issue" });
    expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(within(confirmation).getByRole("button", { name: "Cancel" }), { key: "Tab", shiftKey: true });
    expect(within(confirmation).getByRole("button", { name: "Delete Key Issue" })).toHaveFocus();
    fireEvent.keyDown(within(confirmation).getByRole("button", { name: "Delete Key Issue" }), { key: "Tab" });
    expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(api.deleteKeyIssue).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete Key Issue" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Delete Key Issue" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete Key Issue" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: /Key Issue: Agents & Autonomy/ })).not.toBeInTheDocument());
    expect(api.deleteKeyIssue).toHaveBeenCalledWith("issue-1");
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("button", { name: /Key Issue: Agents & Autonomy/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps deletion of the last Topic recoverable from the empty map", async () => {
    const project = createValidProject();
    project.topics = [project.topics[0]];
    project.relationships = [];
    const deleted = structuredClone(project);
    deleted.topics = [];
    deleted.keyIssues = [];
    delete deleted.manifest.homeTopicId;
    const api = apiFor(project);
    api.deleteTopic = vi.fn(async () => ({ project: deleted, history: { canUndo: true, canRedo: false } }));
    api.undo = vi.fn(async () => ({ project, history: { canUndo: false, canRedo: true } }));
    render(<App loadProject={async () => project} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Topic" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete Topic" }));
    await screen.findByText(messages.en.emptyMap);
    expect(api.deleteTopic).toHaveBeenCalledWith("topic-1");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("button", { name: "Central Topic: Center" })).toBeInTheDocument();
  });

  it("localizes Studio relationship choices and chips while preserving canonical edits and IDs", async () => {
    const project = createValidProject();
    project.manifest.id = "project-ai-landscape";
    project.manifest.homeTopicId = "topic-ai";
    project.topics = [
      { ...project.topics[0], id: "topic-ai", title: "Artificial Intelligence" },
      { ...project.topics[1], id: "topic-world-models", title: "World Models" },
      { ...project.topics[1], id: "topic-disinformation", title: "التضليل المعلوماتي · Disinformation" },
      { ...project.topics[1], id: "topic-interpretability", title: "Интерпретируемость моделей" },
      { ...project.topics[1], id: "topic-custom", title: "My research topic" }
    ];
    project.keyIssues[0] = { ...project.keyIssues[0], id: "issue-agents", topicId: "topic-ai", title: "Agents & Autonomy" };
    project.relationships[0] = { ...project.relationships[0], sourceTopicId: "topic-ai", keyIssueId: "issue-agents", targetTopicId: "topic-world-models" };
    const original = structuredClone(project);
    const api = apiFor(project);
    const connectTopics = vi.spyOn(api, "connectTopics");
    const updateKeyIssue = vi.spyOn(api, "updateKeyIssue");
    render(<App loadProject={async () => project} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /Key Issue: Agents & Autonomy/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Add relationship" }), { target: { value: "topic-disinformation" } });

    const variants: { locale: Locale; choices: string[]; chip: string; heading: string }[] = [
      { locale: "en", choices: ["Disinformation", "Model Interpretability"], chip: "World Models", heading: "Agents & Autonomy" },
      { locale: "ar", choices: ["التضليل المعلوماتي", "قابلية تفسير النماذج"], chip: "نماذج العالم", heading: "الوكلاء والاستقلالية" },
      { locale: "ru", choices: ["Дезинформация", "Интерпретируемость моделей"], chip: "Модели мира", heading: "Агенты и автономность" },
      { locale: "en", choices: ["Disinformation", "Model Interpretability"], chip: "World Models", heading: "Agents & Autonomy" }
    ];
    let current: Locale = "en";
    for (const variant of variants) {
      if (variant.locale !== current) {
        fireEvent.click(screen.getByRole("button", { name: messages[current].settings }));
        fireEvent.click(screen.getByRole("button", { name: `${messages[current].language}: ${localeNames[current]}` }));
        fireEvent.click(screen.getByRole("option", { name: localeNames[variant.locale] }));
        fireEvent.click(screen.getByRole("button", { name: messages[variant.locale].settings }));
        current = variant.locale;
      }
      const choices = screen.getByRole("combobox", { name: messages[current].addRelationship });
      expect(within(choices).getAllByRole("option").map(option => option.textContent)).toEqual([
        messages[current].addRelationship, ...variant.choices, "My research topic"
      ]);
      expect(choices).toHaveValue("topic-disinformation");
      expect(screen.getByText(variant.chip, { selector: ".relationship-chip" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: variant.heading })).toBeInTheDocument();
      expect(screen.getByLabelText(messages[current].title)).toHaveValue("Agents & Autonomy");
    }
    fireEvent.click(screen.getByRole("button", { name: "Add relationship" }));
    await waitFor(() => expect(connectTopics).toHaveBeenCalledWith({ sourceTopicId: "topic-ai", keyIssueId: "issue-agents", targetTopicId: "topic-disinformation" }));
    expect(updateKeyIssue).not.toHaveBeenCalled();
    expect(project).toEqual(original);
  });

  it("attaches a local file to the active context and exposes a safe Viewer link", async () => {
    const initial = createMapProject();
    const next = structuredClone(initial);
    next.manifest.revision += 1;
    next.assets.push({
      id: "asset-evidence",
      path: "assets/asset-evidence/evidence.txt",
      originalFilename: "evidence.txt",
      mimeType: "text/plain",
      byteSize: 8,
      sha256: "a".repeat(64),
      createdAt: timestamp
    });
    next.knowledgeItems.push({
      id: "knowledge-evidence",
      type: "attachment",
      title: "evidence.txt",
      availability: "local",
      attachmentAssetIds: ["asset-evidence"],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    next.associations.push({
      id: "association-evidence",
      knowledgeItemId: "knowledge-evidence",
      targetKind: "topic",
      targetId: "topic-1"
    });
    const attachAsset = vi.fn<ProjectAssetApi["attachAsset"]>(async () => ({
      project: next,
      history: { canUndo: true, canRedo: false },
      asset: next.assets.at(-1)!,
      extraction: "not-applicable"
    }));

    render(<App loadProject={async () => initial} api={apiFor(initial)} assetApi={{ attachAsset }} />);
    await screen.findByRole("button", { name: "Central Topic: Artificial Intelligence" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const file = new File(["evidence"], "evidence.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Attach file"), { target: { files: [file] } });

    await waitFor(() => expect(attachAsset).toHaveBeenCalledWith(file, { kind: "topic", id: "topic-1" }, expect.any(Function)));
    expect(await screen.findByText("File attached: evidence.txt")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    fireEvent.click(await screen.findByRole("button", { name: /evidence\.txt/ }));
    const link = screen.getByRole("link", { name: /evidence\.txt.*Open file/ });
    expect(link).toHaveAttribute("href", "/api/assets/asset-evidence");
    expect(link).toHaveAttribute("target", "_blank");
  });
});
