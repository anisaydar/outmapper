import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { SqliteSearchAdapter } from "../dist/server/src/search/sqlite-search-adapter.js";
import { WorkspaceSearchService } from "../dist/server/src/search/workspace-search.js";

const root = await mkdtemp(path.join(os.tmpdir(), "outmapper-workspace-benchmark-"));
const timestamp = "2026-10-03T00:00:00.000Z";

function syntheticProject(index) {
  const id = `benchmark-project-${String(index).padStart(3, "0")}`;
  const topicId = `${id}-topic`;
  return {
    manifest: { format: "outmapper-project", formatVersion: 2, id, title: `Benchmark Project ${index}`, createdAt: timestamp, updatedAt: timestamp, revision: 1, homeTopicId: topicId },
    topics: [{ id: topicId, title: `Shared benchmark topic ${index}`, description: `Synthetic body for Project ${index}`, createdAt: timestamp, updatedAt: timestamp }],
    keyIssues: [],
    relationships: [],
    projectLinks: [],
    knowledgeItems: [],
    associations: [],
    assets: [],
    collections: [],
    snapshots: []
  };
}

async function measure(worker, projects) {
  const started = performance.now();
  const result = await worker.search({ query: { text: "shared benchmark", match: "prefix" }, projects, budgetMs: 60_000 });
  return { milliseconds: performance.now() - started, results: result.items.length, incomplete: Boolean(result.incomplete) };
}

try {
  const projects = [];
  for (let index = 0; index < 100; index += 1) {
    const project = syntheticProject(index);
    const directory = path.join(root, project.manifest.id);
    const adapter = SqliteSearchAdapter.open(directory);
    adapter.reconcile(project);
    adapter.close();
    projects.push({
      instanceId: `${project.manifest.id}-instance`,
      projectId: project.manifest.id,
      projectTitle: project.manifest.title,
      databasePath: adapter.databasePath,
      canonicalRevision: project.manifest.revision,
      current: index === 0,
      lastOpenedAt: new Date(Date.UTC(2026, 9, 3, 0, 0, 0) - index * 1_000).toISOString()
    });
  }

  const rows = [];
  for (const count of [10, 50, 100]) {
    const worker = new WorkspaceSearchService();
    try {
      const cold = await measure(worker, projects.slice(0, count));
      const warm = await measure(worker, projects.slice(0, count));
      rows.push({ Projects: count, "Cold ms": cold.milliseconds.toFixed(1), "Warm ms": warm.milliseconds.toFixed(1), Results: warm.results, Partial: cold.incomplete || warm.incomplete });
    } finally {
      await worker.close();
    }
  }
  console.table(rows);
} finally {
  await rm(root, { recursive: true, force: true });
}
