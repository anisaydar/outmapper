import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createValidProject } from "../test/project-fixtures.js";
import { SqliteSearchAdapter } from "./sqlite-search-adapter.js";
import { WorkspaceSearchError, WorkspaceSearchService, type WorkspaceSearchProject } from "./workspace-search.js";

describe("WorkspaceSearchService", () => {
  let root = "";
  const services: WorkspaceSearchService[] = [];

  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "outmapper-workspace-search-")); });
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
    await rm(root, { recursive: true, force: true });
  });

  const indexedProject = (id: string, title: string, topicTitle: string, description = "", revision = 0): WorkspaceSearchProject => {
    const directory = path.join(root, id);
    const project = createValidProject();
    project.manifest.id = id;
    project.manifest.title = title;
    project.manifest.revision = revision;
    project.topics[0]!.id = `${id}-topic`;
    project.topics[0]!.title = topicTitle;
    project.topics[0]!.description = description;
    project.manifest.homeTopicId = project.topics[0]!.id;
    project.keyIssues[0]!.topicId = project.topics[0]!.id;
    project.relationships = [];
    const adapter = SqliteSearchAdapter.open(directory);
    adapter.reconcile(project);
    adapter.close();
    return {
      instanceId: `${id}-instance`,
      projectId: id,
      projectTitle: title,
      databasePath: adapter.databasePath,
      canonicalRevision: revision,
      current: false,
      lastOpenedAt: `2026-10-0${revision + 1}T00:00:00.000Z`
    };
  };

  const service = () => {
    const value = new WorkspaceSearchService();
    services.push(value);
    return value;
  };

  it("orders deterministic title tiers before body matches and carries source identity", async () => {
    const projects = [
      indexedProject("exact", "Exact Project", "alpha"),
      indexedProject("prefix", "Prefix Project", "alphabet"),
      indexedProject("contains", "Contains Project", "the alpha field"),
      indexedProject("body", "Body Project", "unrelated", "alpha appears in the summary")
    ];
    projects[0]!.current = true;

    const result = await service().search({ query: { text: "alpha", match: "prefix" }, projects, budgetMs: 2_000 });

    expect(result.items.slice(0, 4).map(({ sourceProjectId }) => sourceProjectId)).toEqual(["exact", "prefix", "contains", "body"]);
    expect(result.items[0]).toMatchObject({ title: "alpha", sourceInstanceId: "exact-instance", sourceProjectTitle: "Exact Project" });
  });

  it("flags stale indexes, skips missing and mismatched databases, and never creates or modifies them", async () => {
    const stale = indexedProject("stale", "Stale Project", "alpha", "", 1);
    stale.canonicalRevision = 2;
    const mismatchDatabase = indexedProject("actual", "Actual Project", "alpha");
    const mismatch = { ...mismatchDatabase, instanceId: "mismatch-instance", projectId: "expected", projectTitle: "Expected Project" };
    const missingRevision = indexedProject("missing-revision", "Missing Revision", "alpha");
    const editable = new DatabaseSync(missingRevision.databasePath);
    editable.prepare("DELETE FROM runtime_meta WHERE key = 'canonicalRevision'").run();
    editable.close();
    const missingPath = path.join(root, "missing", ".outmapper", "runtime.sqlite");
    const missing: WorkspaceSearchProject = { instanceId: "missing-instance", projectId: "missing", projectTitle: "Missing", databasePath: missingPath, canonicalRevision: 0, current: false };
    const before = await stat(stale.databasePath);

    const result = await service().search({ query: { text: "alpha", match: "prefix" }, projects: [stale, mismatch, missingRevision, missing], budgetMs: 2_000 });
    const after = await stat(stale.databasePath);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ sourceProjectId: "stale", mayBeOutOfDate: true });
    expect(result.staleProjectCount).toBe(1);
    expect(result.notSearchableCount).toBe(3);
    expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({ size: before.size, mtimeMs: before.mtimeMs });
    expect(existsSync(missingPath)).toBe(false);
  });

  it("returns a continuation when the budget expires and searches the remaining Projects", async () => {
    const projects = [
      indexedProject("first", "First", "alpha first"),
      indexedProject("second", "Second", "alpha second"),
      indexedProject("third", "Third", "alpha third")
    ];
    const worker = service();
    const first = await worker.search({ query: { text: "alpha", match: "prefix" }, projects, budgetMs: 0 });
    expect(first).toMatchObject({ incomplete: true, continuation: "1" });
    expect(first.items.every(({ sourceProjectId }) => sourceProjectId === "first")).toBe(true);

    const remaining = await worker.search({ query: { text: "alpha", match: "prefix" }, projects, startIndex: Number(first.continuation), budgetMs: 2_000 });
    expect(remaining.incomplete).toBeUndefined();
    expect(new Set(remaining.items.map(({ sourceProjectId }) => sourceProjectId))).toEqual(new Set(["second", "third"]));
  });

  it("cancels an older query when a newer one starts", async () => {
    const project = indexedProject("cancel", "Cancel", "alpha");
    const worker = service();
    const older = worker.search({ query: { text: "alpha", match: "prefix" }, projects: Array.from({ length: 100 }, () => project), budgetMs: 10_000 }).catch((error: unknown) => error);
    const newer = worker.search({ query: { text: "alpha", match: "prefix" }, projects: [project], budgetMs: 2_000 });

    expect(await older).toBeInstanceOf(WorkspaceSearchError);
    await expect(newer).resolves.toMatchObject({ items: [expect.objectContaining({ sourceProjectId: "cancel" })] });
  });
});
