import { loadServerConfig } from "./config.js";
import { buildServer } from "./server.js";
import path from "node:path";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { Buffer } from "node:buffer";
import { FileSystemProjectStore } from "../project/filesystem-project-store.js";
import { createValidProject, timestamp } from "../test/project-fixtures.js";

describe("local server", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function createServerProject(project = createValidProject(), options: NonNullable<Parameters<typeof buildServer>[1]> = {}) {
    const parent = await mkdtemp(path.join(os.tmpdir(), "outmapper-server-"));
    directories.push(parent);
    const projectDirectory = path.join(parent, "project");
    await new FileSystemProjectStore(projectDirectory).create(project);
    const server = await buildServer({
      ...loadServerConfig({}, process.cwd()),
      projectDirectory,
      projectsDirectory: parent,
      stateDirectory: path.join(parent, "state"),
      clientDirectory: path.join(parent, "missing-client")
    }, options);
    return { parent, projectDirectory, server };
  }
  it("binds only to loopback addresses", async () => {
    const { server } = await createServerProject();

    await server.listen({ host: "127.0.0.1", port: 0 });

    expect(server.addresses()[0]?.address).toBe("127.0.0.1");
    await server.close();
  });

  it("rejects a non-loopback host", () => {
    expect(() => loadServerConfig({ OUTMAPPER_HOST: "0.0.0.0" })).toThrow(
      "OUTMAPPER_HOST must be a loopback address"
    );
  });

  it("opens the configured canonical Project", async () => {
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "outmapper-demo-state-"));
    directories.push(stateDirectory);
    const config = {
      ...loadServerConfig({}, process.cwd()),
      projectDirectory: path.resolve("fixtures/projects/ai-landscape"),
      projectsDirectory: path.join(stateDirectory, "Projects"),
      stateDirectory
    };
    const server = await buildServer(config);

    const response = await server.inject({ method: "GET", url: "/api/project" });

    expect(response.statusCode).toBe(200);
    expect(response.json().manifest.id).toBe("project-ai-landscape");
    await server.close();
  });

  it("creates, opens, and remembers user Projects in the managed Projects directory", async () => {
    const { parent, server } = await createServerProject();
    const created = await server.inject({ method: "POST", url: "/api/projects/new", payload: { title: "Research Atlas", locale: "en" } });
    expect(created.statusCode).toBe(201);
    expect(created.json().project.manifest).toMatchObject({ title: "Research Atlas", defaultLocale: "en" });
    expect(created.json().project.topics).toEqual([]);
    expect((await realpath(path.dirname(created.json().directory))).toLowerCase()).toBe((await realpath(parent)).toLowerCase());

    const recent = await server.inject({ method: "GET", url: "/api/projects/recent" });
    expect(recent.json().projects[0]).toMatchObject({ directory: created.json().directory, title: "Research Atlas" });

    const original = recent.json().projects.find(({ projectId }: { projectId: string }) => projectId === "project-1");
    const reopened = await server.inject({ method: "POST", url: `/api/workspace/projects/${original.instanceId}/activate`, payload: {} });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().project.manifest.id).toBe("project-1");
    await server.close();
  });

  it("rejects cross-origin mutation requests", async () => {
    const { server } = await createServerProject();

    const response = await server.inject({
      method: "POST",
      url: "/api/project",
      headers: { origin: "https://example.org", "sec-fetch-site": "cross-site" },
      payload: { title: "Injected" }
    });

    expect(response.statusCode).toBe(403);
    await server.close();
  });

  it("applies restrictive response security headers", async () => {
    const { server } = await createServerProject();
    const response = await server.inject({ method: "GET", url: "/api/project" });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    await server.close();
  });

  it("releases the API queue when an in-flight PATCH is aborted", async () => {
    let pickerStarted!: () => void;
    let finishPicker!: (directory: string | null) => void;
    const started = new Promise<void>((resolve) => { pickerStarted = resolve; });
    const picker = new Promise<string | null>((resolve) => { finishPicker = resolve; });
    const { server } = await createServerProject(createValidProject(), {
      selectFolder: () => {
        pickerStarted();
        return picker;
      }
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.addresses()[0];
    if (!address) throw new Error("Test server did not bind");
    const origin = `http://127.0.0.1:${address.port}`;

    const open = fetch(`${origin}/api/projects/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    await started;
    const controller = new AbortController();
    const patch = fetch(`${origin}/api/topics/topic-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Interrupted autosave" }),
      signal: controller.signal
    });
    controller.abort();
    await expect(patch).rejects.toMatchObject({ name: "AbortError" });
    finishPicker(null);
    expect((await open).status).toBe(200);

    const health = await Promise.race([
      fetch(`${origin}/api/health`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("API queue remained locked")), 2_000))
    ]);
    expect(health.status).toBe(200);
    await server.close();
  });

  it("autosaves domain commands to canonical files and supports bounded undo", async () => {
    const { projectDirectory, server } = await createServerProject();

    const update = await server.inject({
      method: "PATCH",
      url: "/api/topics/topic-1",
      payload: { title: "Edited Topic", description: "Saved to the Project." }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().project.manifest.revision).toBe(1);
    expect(update.json().project.topics[0]).toMatchObject({ id: "topic-1", title: "Edited Topic" });
    expect(update.json().history).toEqual({ canUndo: true, canRedo: false });
    expect((await new FileSystemProjectStore(projectDirectory).open()).topics[0].title).toBe("Edited Topic");

    const undo = await server.inject({ method: "POST", url: "/api/history/undo", payload: {} });
    expect(undo.statusCode).toBe(200);
    expect(undo.json().project.manifest.revision).toBe(2);
    expect(undo.json().project.topics[0]).toMatchObject({ id: "topic-1", title: "Center" });
    expect(undo.json().history).toEqual({ canUndo: false, canRedo: true });
    await server.close();
  });

  it("reads the active Project while a Project switch opens it, without a transient conflict", async () => {
    const { projectDirectory, server } = await createServerProject();
    const instanceA = (await server.inject({ method: "GET", url: "/api/workspace/projects" })).json().activeInstanceId as string;
    const instanceB = (await server.inject({ method: "POST", url: "/api/projects/new", payload: { title: "Project B", locale: "en" } })).json().instanceId as string;
    // A read left in flight by a closing page runs beside the next request, as these direct reads of folder A do.
    const reader = new FileSystemProjectStore(projectDirectory);
    let switching = true;
    const readErrors: unknown[] = [];
    const readLoop = async () => {
      while (switching) await reader.load().catch((error: unknown) => { readErrors.push(error); });
    };
    const readers = [readLoop(), readLoop(), readLoop()];
    const statuses: number[] = [];
    for (let round = 0; round < 12; round += 1) {
      const [toA, project] = await Promise.all([
        server.inject({ method: "POST", url: `/api/workspace/projects/${instanceA}/activate`, payload: {} }),
        reader.load()
      ]);
      statuses.push(toA.statusCode);
      expect(project.manifest.id).toBe("project-1");
      statuses.push((await server.inject({ method: "POST", url: `/api/workspace/projects/${instanceB}/activate`, payload: {} })).statusCode);
    }
    switching = false;
    await Promise.all(readers);

    expect(statuses.every((status) => status === 200), JSON.stringify(statuses)).toBe(true);
    expect(readErrors).toEqual([]);
    await server.close();
  });

  it("keeps Undo per folder instance, clears externally changed history, and reloads conflicts", async () => {
    const { parent, projectDirectory, server } = await createServerProject();
    const workspace = (await server.inject({ method: "GET", url: "/api/workspace/projects" })).json();
    const instanceA = workspace.activeInstanceId as string;
    await server.inject({ method: "PATCH", url: "/api/topics/topic-1", payload: { title: "Edited in A" } });
    const createdB = await server.inject({ method: "POST", url: "/api/projects/new", payload: { title: "Project B", locale: "en" } });
    const instanceB = createdB.json().instanceId as string;

    const returnedA = await server.inject({ method: "POST", url: `/api/workspace/projects/${instanceA}/activate`, payload: {} });
    expect(returnedA.json()).toMatchObject({ history: { canUndo: true }, historyCleared: false });
    expect((await server.inject({ method: "POST", url: "/api/history/undo", payload: {} })).json().project.topics[0].title).toBe("Center");
    await server.inject({ method: "PATCH", url: "/api/topics/topic-1", payload: { title: "Second edit" } });
    await server.inject({ method: "POST", url: `/api/workspace/projects/${instanceB}/activate`, payload: {} });

    const manifestPath = path.join(projectDirectory, "project.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.title = "Externally renamed";
    manifest.revision = Number(manifest.revision) + 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const changedA = await server.inject({ method: "POST", url: `/api/workspace/projects/${instanceA}/activate`, payload: {} });
    expect(changedA.json()).toMatchObject({ historyCleared: true, history: { canUndo: false, canRedo: false }, project: { manifest: { title: "Externally renamed" } } });

    const external = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    external.title = "Reloaded title";
    external.revision = Number(external.revision) + 1;
    await writeFile(manifestPath, `${JSON.stringify(external, null, 2)}\n`, "utf8");
    expect((await server.inject({ method: "PATCH", url: "/api/topics/topic-1", headers: { "x-outmapper-project-id": "project-1", "x-outmapper-revision": String(changedA.json().project.manifest.revision) }, payload: { title: "Conflict" } })).statusCode).toBe(409);
    const reloaded = await server.inject({ method: "POST", url: "/api/project/reload", payload: {} });
    expect(reloaded.json()).toMatchObject({ historyCleared: true, project: { manifest: { title: "Reloaded title" } } });
    expect(await realpath(parent)).toBeTruthy();
    await server.close();
  });

  it("registers copied folders as duplicate instances and can give one a new identity", async () => {
    let selected = "";
    const { parent, projectDirectory, server } = await createServerProject(createValidProject(), { selectFolder: async () => selected });
    const copyDirectory = path.join(parent, "copied-folder");
    await cp(projectDirectory, copyDirectory, { recursive: true });
    selected = copyDirectory;
    const opened = await server.inject({ method: "POST", url: "/api/projects/open", payload: {} });
    expect(opened.statusCode).toBe(200);
    const workspace = (await server.inject({ method: "GET", url: "/api/workspace/projects" })).json();
    const copies = Object.values(workspace.projects as Record<string, { projectId: string; status: string }>).filter((entry) => entry.projectId === "project-1");
    expect(copies.every((entry) => entry.status === "duplicate")).toBe(true);
    expect((await server.inject({ method: "GET", url: "/api/workspace/resolve/project-1" })).json().status).toBe("choose");
    const identity = await server.inject({ method: "POST", url: `/api/workspace/projects/${opened.json().instanceId}/new-identity`, payload: {} });
    expect(identity.json().project.manifest.id).not.toBe("project-1");
    expect((await new FileSystemProjectStore(projectDirectory).open()).manifest.id).toBe("project-1");

    const savedCopy = await server.inject({ method: "POST", url: "/api/project/save-copy", payload: {} });
    expect(savedCopy.json().project.projectId).not.toBe(identity.json().project.manifest.id);
    expect((await new FileSystemProjectStore(savedCopy.json().project.directory).open()).manifest.id).toBe(savedCopy.json().project.projectId);
    await server.close();
  });

  it.each(["topics/topic-1", "key-issues/issue-1"])("deletes %s with references as one recoverable command", async (entityPath) => {
    const project = createValidProject();
    project.knowledgeItems.push({ id: "evidence", type: "note", title: "Evidence", availability: "local", createdAt: timestamp, updatedAt: timestamp });
    project.associations.push({ id: "association-1", knowledgeItemId: "evidence", targetKind: "keyIssue", targetId: "issue-1" });
    const { server, projectDirectory } = await createServerProject(project);
    try {
      const guarded = await server.inject({ method: "DELETE", url: `/api/${entityPath}`, payload: {} });
      expect(guarded.statusCode).toBe(409);
      const removed = await server.inject({ method: "DELETE", url: `/api/${entityPath}`, payload: { removeReferences: true } });
      expect(removed.statusCode).toBe(200);
      expect(removed.json().project.keyIssues).toEqual([]);
      expect(removed.json().project.relationships).toEqual([]);
      expect(removed.json().project.associations).toEqual([]);
      expect(removed.json().project.knowledgeItems).toEqual(project.knowledgeItems);
      expect(removed.json().history).toEqual({ canUndo: true, canRedo: false });
      expect((await new FileSystemProjectStore(projectDirectory).open()).manifest.revision).toBe(1);
      const restored = await server.inject({ method: "POST", url: "/api/history/undo", payload: {} });
      expect(restored.statusCode).toBe(200);
      expect(restored.json().project.topics).toEqual(project.topics);
      expect(restored.json().project.keyIssues).toEqual(project.keyIssues);
      expect(restored.json().project.relationships).toEqual(project.relationships);
      expect(restored.json().project.associations).toEqual(project.associations);
      expect(restored.json().project.manifest.homeTopicId).toBe("topic-1");
    } finally { await server.close(); }
  });

  it.each([
    { type: "video", targetKind: "topic", targetId: "topic-1" },
    { type: "research-paper", targetKind: "keyIssue", targetId: "issue-1" }
  ])("persists external knowledge of type $type with its context and restores it through undo and redo", async (context) => {
    const { projectDirectory, server } = await createServerProject();
    try {
      const input = { ...context, title: "Linked resource", body: "Reading description", availability: "external", externalUrl: "https://example.org/resource" };
      const response = await server.inject({ method: "POST", url: "/api/knowledge", payload: input });
      expect(response.statusCode).toBe(201);
      const created = response.json().project.knowledgeItems.at(-1);
      expect(created).toMatchObject({ type: context.type, title: input.title, body: input.body, availability: "external", externalUrl: input.externalUrl });
      const persisted = await new FileSystemProjectStore(projectDirectory).open();
      expect(persisted.knowledgeItems.at(-1)).toEqual(created);
      expect(persisted.associations.at(-1)).toMatchObject({ knowledgeItemId: created.id, targetKind: context.targetKind, targetId: context.targetId });
      const undone = await server.inject({ method: "POST", url: "/api/history/undo", payload: {} });
      expect(undone.statusCode).toBe(200);
      expect(undone.json().project.knowledgeItems).toEqual([]);
      expect(undone.json().project.associations).toEqual([]);
      const redone = await server.inject({ method: "POST", url: "/api/history/redo", payload: {} });
      expect(redone.statusCode).toBe(200);
      expect(redone.json().project.knowledgeItems.at(-1)).toEqual(created);
      expect((await new FileSystemProjectStore(projectDirectory).open()).associations).toEqual(persisted.associations);
    } finally { await server.close(); }
  });

  it("publishes a stable snapshot and leaves asset bytes outside the snapshot directory", async () => {
    const { projectDirectory, server } = await createServerProject();

    const response = await server.inject({ method: "POST", url: "/api/publish", payload: {} });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.snapshot).toMatchObject({ revision: 0, assetIds: [] });
    expect(body.project.manifest.publishedSnapshotId).toBe(body.snapshot.id);
    const manifest = JSON.parse(
      await readFile(path.join(projectDirectory, body.snapshot.manifestPath), "utf8")
    );
    expect(manifest).toMatchObject({
      format: "outmapper-published-snapshot",
      snapshot: { id: body.snapshot.id, revision: 0 },
      project: { manifest: { revision: 0 } }
    });
    await server.close();
  });

  it("reconciles native SQLite and exposes search only through the adapter contract", async () => {
    const project = createValidProject();
    project.knowledgeItems.push({
      id: "knowledge-runtime",
      type: "note",
      title: "Runtime recovery",
      availability: "local",
      body: "Derived SQLite can be rebuilt from canonical files.",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    project.associations.push({
      id: "association-runtime",
      knowledgeItemId: "knowledge-runtime",
      targetKind: "topic",
      targetId: "topic-1"
    });
    const { server } = await createServerProject(project);

    const response = await server.inject({ method: "GET", url: "/api/search?q=canonical" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      total: 1,
      items: [{ id: "knowledge-runtime", kind: "knowledgeItem", contexts: [{ topicId: "topic-1" }] }]
    });
    const filtered = await server.inject({
      method: "GET",
      url: "/api/search?q=run&match=prefix&kinds=knowledgeItem&topics=topic-1"
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items.map(({ id }: { id: string }) => id)).toEqual(["knowledge-runtime"]);
    expect((await server.inject({ method: "GET", url: "/api/search?match=raw-fts" })).statusCode).toBe(400);
    await server.close();
  });

  it("exports, previews, and commits portable Project packages through bounded local APIs", async () => {
    const { parent, projectDirectory, server } = await createServerProject();
    const before = await readFile(path.join(projectDirectory, "project.json"), "utf8");

    const exported = await server.inject({ method: "GET", url: "/api/packages/export" });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/vnd.outmapper.package+zip");
    expect(exported.headers["content-disposition"]).toContain("test-project.outmapper");

    const preview = await server.inject({
      method: "POST",
      url: "/api/packages/import/preview",
      headers: {
        "content-type": "application/vnd.outmapper.package+zip",
        "x-outmapper-filename": "backup.outmapper"
      },
      payload: exported.rawPayload
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ projectId: "project-1", projectTitle: "Test Project" });
    expect(await readFile(path.join(projectDirectory, "project.json"), "utf8")).toBe(before);

    const committed = await server.inject({
      method: "POST",
      url: `/api/packages/import/${preview.json().id}/commit`,
      payload: { directoryName: "imported-project" }
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json().projectDirectory).toBe(path.join(parent, "imported-project"));
    expect((await new FileSystemProjectStore(path.join(parent, "imported-project")).open()).manifest.id).not.toBe("project-1");
    expect(committed.json().importMode).toBe("copy");

    const secondPreview = await server.inject({ method: "POST", url: "/api/packages/import/preview", headers: { "content-type": "application/vnd.outmapper.package+zip", "x-outmapper-filename": "backup.outmapper" }, payload: exported.rawPayload });
    const importedAnyway = await server.inject({ method: "POST", url: `/api/packages/import/${secondPreview.json().id}/commit`, payload: { directoryName: "imported-anyway", mode: "anyway" } });
    expect(importedAnyway.json().importMode).toBe("anyway");
    expect((await new FileSystemProjectStore(path.join(parent, "imported-anyway")).open()).manifest.id).toBe("project-1");
    await server.close();
  });

  it("serves incoming links, the cached Universe, federated search, and stable workspace error codes", async () => {
    const target = createValidProject();
    target.manifest.title = "Target Project";
    const parent = await mkdtemp(path.join(os.tmpdir(), "outmapper-workspace-server-"));
    directories.push(parent);
    const targetDirectory = path.join(parent, "target");
    const sourceDirectory = path.join(parent, "source");
    await new FileSystemProjectStore(targetDirectory).create(target);
    const source = createValidProject();
    source.manifest.id = "source-project";
    source.manifest.title = "Source Project";
    source.topics[0]!.title = "Source Alpha";
    source.keyIssues[0]!.title = "Source Issue";
    source.projectLinks = [{ id: "source-link", sourceTopicId: "topic-1", keyIssueId: "issue-1", targetProjectId: target.manifest.id, cachedProjectTitle: target.manifest.title, createdAt: timestamp, updatedAt: timestamp }];
    await new FileSystemProjectStore(sourceDirectory).create(source);
    const server = await buildServer({
      ...loadServerConfig({}, process.cwd()),
      projectDirectory: targetDirectory,
      projectsDirectory: parent,
      stateDirectory: path.join(parent, "state"),
      clientDirectory: path.join(parent, "missing-client")
    }, { selectFolder: async () => sourceDirectory });
    const initialWorkspace = (await server.inject({ method: "GET", url: "/api/workspace/projects" })).json();
    const targetInstance = initialWorkspace.activeInstanceId as string;
    const opened = await server.inject({ method: "POST", url: "/api/projects/open", payload: {} });
    const sourceInstance = opened.json().instanceId as string;
    await server.inject({ method: "POST", url: `/api/workspace/projects/${targetInstance}/activate`, payload: {} });

    const incoming = await server.inject({ method: "GET", url: "/api/workspace/incoming" });
    expect(incoming.statusCode).toBe(200);
    expect(incoming.json()).toMatchObject({ total: 1, groups: [{ topicId: "topic-1", links: [{ sourceInstanceId: sourceInstance, sourceProjectTitle: "Source Project", sourceTopicTitle: "Source Alpha", keyIssueTitle: "Source Issue" }] }] });
    const universe = await server.inject({ method: "GET", url: "/api/workspace/universe" });
    expect(universe.json()).toMatchObject({
      nodes: expect.arrayContaining([expect.objectContaining({ projectId: "project-1" }), expect.objectContaining({ projectId: "source-project" })]),
      edges: [{ sourceProjectId: "source-project", targetProjectId: "project-1", count: 1 }]
    });
    const search = await server.inject({ method: "GET", url: "/api/search?scope=workspace&q=source&match=prefix" });
    expect(search.statusCode).toBe(200);
    expect(search.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Source Alpha", sourceInstanceId: sourceInstance, sourceProjectId: "source-project" })]));

    const invalidScope = await server.inject({ method: "GET", url: "/api/search?scope=everywhere&q=source" });
    expect(invalidScope.json()).toMatchObject({ code: "search-scope-invalid" });
    const activeForget = await server.inject({ method: "DELETE", url: `/api/workspace/projects/${targetInstance}` });
    expect(activeForget.json()).toMatchObject({ code: "active-project-forget" });
    await server.inject({ method: "DELETE", url: `/api/workspace/projects/${sourceInstance}` });
    expect((await server.inject({ method: "GET", url: "/api/workspace/incoming" })).json().total).toBe(0);
    await server.close();
  });

  it("previews and imports a selected folder without modifying its originals", async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), "outmapper-folder-source-"));
    directories.push(source);
    await mkdir(path.join(source, "notes"));
    await writeFile(path.join(source, "notes", "brief.md"), "# Original research note", "utf8");
    await writeFile(path.join(source, "reference.url"), "[InternetShortcut]\nURL=https://example.org/research\n", "utf8");
    const { projectDirectory, server } = await createServerProject(createValidProject(), { selectFolder: async () => source });

    const preview = await server.inject({ method: "POST", url: "/api/folder-import/preview", payload: {} });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "notes/brief.md", kind: "note" }),
      expect.objectContaining({ path: "reference.url", kind: "link" })
    ]));

    const started = await server.inject({
      method: "POST",
      url: `/api/folder-import/plans/${preview.json().id}/start`,
      payload: { fileIds: preview.json().files.map(({ id }: { id: string }) => id), target: { kind: "topic", id: "topic-1" }, duplicates: "skip" }
    });
    expect(started.statusCode).toBe(202);
    let status = await server.inject({ method: "GET", url: `/api/folder-import/jobs/${started.json().id}` });
    for (let attempt = 0; status.json().job.status === "running" && attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      status = await server.inject({ method: "GET", url: `/api/folder-import/jobs/${started.json().id}` });
    }

    expect(status.json().job).toMatchObject({ status: "completed", imported: 2, skipped: 0, failures: [] });
    expect(status.json().project.knowledgeItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "brief", type: "note", body: "# Original research note" }),
      expect.objectContaining({ title: "reference", type: "web-link", externalUrl: "https://example.org/research" })
    ]));
    const importedAsset = status.json().project.assets.find(({ originalFilename }: { originalFilename: string }) => originalFilename === "brief.md");
    expect(await readFile(path.join(projectDirectory, importedAsset.path), "utf8")).toBe("# Original research note");
    expect(await readFile(path.join(source, "notes", "brief.md"), "utf8")).toBe("# Original research note");
    await server.close();
  });

  it("streams a managed Asset into canonical context and serves bounded byte ranges", async () => {
    const { projectDirectory, server } = await createServerProject();
    const bytes = Buffer.from("local supporting evidence", "utf8");

    const attached = await server.inject({
      method: "POST",
      url: "/api/assets",
      headers: {
        "content-type": "application/vnd.outmapper.asset",
        "x-outmapper-filename": encodeURIComponent("evidence.txt"),
        "x-outmapper-mime": "text/plain",
        "x-outmapper-target-kind": "topic",
        "x-outmapper-target-id": "topic-1"
      },
      payload: bytes
    });

    expect(attached.statusCode).toBe(201);
    const asset = attached.json().asset;
    expect(asset).toMatchObject({ originalFilename: "evidence.txt", mimeType: "text/plain", byteSize: bytes.length });
    expect(attached.json().project.knowledgeItems.at(-1).attachmentAssetIds).toEqual([asset.id]);
    expect(await readFile(path.join(projectDirectory, asset.path))).toEqual(bytes);

    const range = await server.inject({
      method: "GET",
      url: `/api/assets/${asset.id}`,
      headers: { range: "bytes=6-15" }
    });
    expect(range.statusCode).toBe(206);
    expect(range.headers["content-range"]).toBe(`bytes 6-15/${bytes.length}`);
    expect(range.rawPayload.toString("utf8")).toBe("supporting");

    const persisted = await new FileSystemProjectStore(projectDirectory).open();
    expect(persisted.assets.some(({ id }) => id === asset.id)).toBe(true);
    await server.close();
  });

  it("rejects forged PDF metadata before canonical mutation", async () => {
    const { projectDirectory, server } = await createServerProject();
    const response = await server.inject({
      method: "POST",
      url: "/api/assets",
      headers: {
        "content-type": "application/vnd.outmapper.asset",
        "x-outmapper-filename": "forged.pdf",
        "x-outmapper-mime": "application/pdf",
        "x-outmapper-target-kind": "topic",
        "x-outmapper-target-id": "topic-1"
      },
      payload: Buffer.from("not a pdf")
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("forged-mime");
    expect((await new FileSystemProjectStore(projectDirectory).open()).assets).toHaveLength(0);
    await server.close();
  });

  it("forces active SVG downloads into a sandboxed non-sniffable response", async () => {
    const { server } = await createServerProject();
    const attached = await server.inject({
      method: "POST",
      url: "/api/assets",
      headers: {
        "content-type": "application/vnd.outmapper.asset",
        "x-outmapper-filename": "active.svg",
        "x-outmapper-mime": "image/svg+xml",
        "x-outmapper-target-kind": "topic",
        "x-outmapper-target-id": "topic-1"
      },
      payload: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    });
    expect(attached.statusCode).toBe(201);

    const response = await server.inject({ method: "GET", url: `/api/assets/${attached.json().asset.id}` });
    expect(response.headers["content-type"]).toContain("application/octet-stream");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain("sandbox");
    await server.close();
  });

  it("reports canonical Assets whose managed bytes are missing", async () => {
    const project = createValidProject();
    project.assets.push({
      id: "missing-asset",
      path: "assets/missing-asset/file.pdf",
      originalFilename: "file.pdf",
      mimeType: "application/pdf",
      byteSize: 10,
      sha256: "0".repeat(64),
      createdAt: timestamp
    });
    const { server } = await createServerProject(project);

    const response = await server.inject({ method: "GET", url: "/api/assets/missing-asset" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toContain("missing");
    await server.close();
  });
});

describe("local server authoring routes", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function createServer(project = createValidProject()) {
    const parent = await mkdtemp(path.join(os.tmpdir(), "outmapper-authoring-"));
    directories.push(parent);
    const projectDirectory = path.join(parent, "project");
    await new FileSystemProjectStore(projectDirectory).create(project);
    const server = await buildServer({
      ...loadServerConfig({}, process.cwd()),
      projectDirectory,
      projectsDirectory: parent,
      stateDirectory: path.join(parent, "state"),
      clientDirectory: path.join(parent, "missing-client")
    });
    return { projectDirectory, server };
  }

  function png(width: number, height: number) {
    const bytes = Buffer.alloc(64);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
  }

  const coverHeaders = { "content-type": "application/vnd.outmapper.asset", "x-outmapper-filename": encodeURIComponent("cover.png") };

  it("sets a cover as one Undo step without a Knowledge Item, and removes it back to the inherited cover", async () => {
    const { projectDirectory, server } = await createServer();
    const set = await server.inject({ method: "PUT", url: "/api/key-issues/issue-1/cover", headers: coverHeaders, payload: png(1200, 630) });
    expect(set.statusCode).toBe(200);
    const asset = set.json().asset;
    expect(asset).toMatchObject({ mimeType: "image/png", width: 1200, height: 630 });
    expect(set.json().project.keyIssues[0].visualAssetId).toBe(asset.id);
    expect(set.json().project.knowledgeItems).toEqual([]);
    expect(set.json().project.associations).toEqual([]);
    expect(await readFile(path.join(projectDirectory, asset.path))).toHaveLength(64);

    const removed = await server.inject({ method: "DELETE", url: "/api/key-issues/issue-1/cover", payload: {} });
    expect(removed.json().project.keyIssues[0].visualAssetId).toBeUndefined();
    await server.inject({ method: "POST", url: "/api/history/undo", payload: {} });
    const undone = await server.inject({ method: "POST", url: "/api/history/undo", payload: {} });
    expect(undone.json().project.keyIssues[0].visualAssetId).toBeUndefined();
    expect(undone.json().project.assets).toEqual([]);
    expect(undone.json().history.canUndo).toBe(false);
    await server.close();
  });

  it("rejects animated WebP and GIF covers by their bytes before any canonical change", async () => {
    const { projectDirectory, server } = await createServer();
    const animated = Buffer.alloc(40);
    animated.write("RIFF", 0, "ascii");
    animated.write("WEBPVP8X", 8, "ascii");
    animated[20] = 0x02;
    for (const payload of [animated, Buffer.from("GIF89a\x01\x00\x01\x00", "latin1")]) {
      const response = await server.inject({ method: "PUT", url: "/api/topics/topic-1/cover", headers: { ...coverHeaders, "x-outmapper-mime": "image/png" }, payload });
      expect(response.statusCode).toBe(415);
      expect(response.json().code).toBe("unsupported-cover");
    }
    const persisted = await new FileSystemProjectStore(projectDirectory).open();
    expect(persisted.assets).toEqual([]);
    expect(persisted.topics[0].visualAssetId).toBeUndefined();
    expect((await server.inject({ method: "PUT", url: "/api/topics/missing/cover", headers: coverHeaders, payload: png(1, 1) })).statusCode).toBe(404);
    await server.close();
  });

  it("creates and links a Topic as a single Undo step", async () => {
    const { server } = await createServer();
    const created = await server.inject({ method: "POST", url: "/api/relationships/new-topic", payload: { sourceTopicId: "topic-1", keyIssueId: "issue-1", title: "Policy" } });
    expect(created.statusCode).toBe(201);
    const topic = created.json().project.topics.find(({ title }: { title: string }) => title === "Policy");
    expect(created.json().project.relationships.some(({ targetTopicId }: { targetTopicId: string }) => targetTopicId === topic.id)).toBe(true);

    const undone = await server.inject({ method: "POST", url: "/api/history/undo", payload: {} });
    expect(undone.json().project.topics).toHaveLength(2);
    expect(undone.json().project.relationships).toHaveLength(1);
    expect(undone.json().history.canUndo).toBe(false);
    await server.close();
  });

  it("authors an outgoing Project portal as one Undo step", async () => {
    const { server } = await createServer();
    const linked = await server.inject({ method: "POST", url: "/api/project-links", payload: { sourceTopicId: "topic-1", keyIssueId: "issue-1", targetProjectId: "external-project", cachedProjectTitle: "External Atlas", note: "Follow-up" } });
    expect(linked.statusCode).toBe(201);
    expect(linked.json().project.projectLinks).toEqual([expect.objectContaining({ targetProjectId: "external-project", cachedProjectTitle: "External Atlas", note: "Follow-up" })]);
    const undone = await server.inject({ method: "POST", url: "/api/history/undo", payload: {} });
    expect(undone.json().project.projectLinks).toEqual([]);
    expect(undone.json().history.canUndo).toBe(false);
    await server.close();
  });

  it("groups text autosaves, reverts an editing session to its checkpoint, and refuses unknown checkpoints", async () => {
    const { server } = await createServer();
    const { checkpoint } = (await server.inject({ method: "POST", url: "/api/history/checkpoint", payload: {} })).json();
    expect(checkpoint).toEqual({ depth: 0, revision: 0 });
    for (const title of ["M", "Ma", "Machine"]) {
      await server.inject({ method: "PATCH", url: "/api/topics/topic-1", payload: { title } });
    }
    await server.inject({ method: "PATCH", url: "/api/key-issues/issue-1", payload: { order: 3 } });

    const reverted = await server.inject({ method: "POST", url: "/api/history/revert", payload: { checkpoint } });
    expect(reverted.statusCode).toBe(200);
    expect(reverted.json().project.topics[0].title).toBe("Center");
    expect(reverted.json().project.keyIssues[0].order).toBe(0);

    const undoRevert = await server.inject({ method: "POST", url: "/api/history/undo", payload: {} });
    expect(undoRevert.json().project.keyIssues[0].order).toBe(3);
    await server.inject({ method: "POST", url: "/api/history/undo", payload: {} });
    const undoText = await server.inject({ method: "POST", url: "/api/history/undo", payload: {} });
    expect(undoText.json().project.topics[0].title).toBe("Center");
    expect(undoText.json().history.canUndo).toBe(false);

    const missing = await server.inject({ method: "POST", url: "/api/history/revert", payload: { checkpoint: { depth: 7, revision: 99 } } });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().code).toBe("checkpoint-unavailable");
    expect((await server.inject({ method: "POST", url: "/api/history/revert", payload: {} })).statusCode).toBe(400);
    await server.close();
  });

  it("updates Project metadata and the Home Topic through PATCH /api/project as undoable steps", async () => {
    const { server } = await createServer();
    const renamed = await server.inject({ method: "PATCH", url: "/api/project", payload: { title: "Atlas", description: "Research map" } });
    expect(renamed.json().project.manifest).toMatchObject({ title: "Atlas", description: "Research map" });
    const home = await server.inject({ method: "PATCH", url: "/api/project", payload: { homeTopicId: "topic-2" } });
    expect(home.json().project.manifest.homeTopicId).toBe("topic-2");
    expect((await server.inject({ method: "PATCH", url: "/api/project", payload: { title: " " } })).statusCode).toBe(400);

    expect((await server.inject({ method: "POST", url: "/api/history/undo", payload: {} })).json().project.manifest.homeTopicId).toBe("topic-1");
    expect((await server.inject({ method: "POST", url: "/api/history/undo", payload: {} })).json().project.manifest.title).toBe("Test Project");
    await server.close();
  });
});
