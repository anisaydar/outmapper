import { loadServerConfig } from "./config.js";
import { buildServer } from "./server.js";
import path from "node:path";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
    const { parent, projectDirectory, server } = await createServerProject();
    const created = await server.inject({ method: "POST", url: "/api/projects/new", payload: { title: "Research Atlas", locale: "en" } });
    expect(created.statusCode).toBe(201);
    expect(created.json().project.manifest).toMatchObject({ title: "Research Atlas", defaultLocale: "en" });
    expect(created.json().project.topics).toEqual([]);
    expect((await realpath(path.dirname(created.json().directory))).toLowerCase()).toBe((await realpath(parent)).toLowerCase());

    const recent = await server.inject({ method: "GET", url: "/api/projects/recent" });
    expect(recent.json().projects[0]).toMatchObject({ directory: created.json().directory, title: "Research Atlas" });

    const reopened = await server.inject({ method: "POST", url: "/api/projects/open", payload: { directory: projectDirectory } });
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
    expect((await new FileSystemProjectStore(path.join(parent, "imported-project")).open()).manifest.id).toBe("project-1");
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
