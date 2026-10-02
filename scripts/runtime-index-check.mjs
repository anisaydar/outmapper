import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileSystemProjectStore } from "../dist/server/src/project/filesystem-project-store.js";
import { ProjectService } from "../dist/server/src/domain/project-service.js";
import { serializeCanonicalJson } from "../dist/server/src/project/serialization.js";
import { RUNTIME_DATABASE_PATH, SqliteSearchAdapter } from "../dist/server/src/search/sqlite-search-adapter.js";

const timestamp = "2026-09-30T00:00:00.000Z";
const directory = await mkdtemp(path.join(os.tmpdir(), "outmapper-runtime-check-"));
const projectDirectory = path.join(directory, "project");

function project() {
  return {
    manifest: { format: "outmapper-project", formatVersion: 1, id: "runtime-index-check", title: "Runtime Index Check", createdAt: timestamp, updatedAt: timestamp, revision: 0, homeTopicId: "topic-home" },
    topics: [{ id: "topic-home", title: "Canonical Runtime", createdAt: timestamp, updatedAt: timestamp }, { id: "topic-delete", title: "Delete Me", createdAt: timestamp, updatedAt: timestamp }],
    keyIssues: [], relationships: [],
    knowledgeItems: Array.from({ length: 250 }, (_, index) => ({ id: `knowledge-${index}`, type: "note", title: `Runtime record ${index}`, availability: "local", body: `Canonical rebuild evidence ${index}`, createdAt: timestamp, updatedAt: timestamp })),
    associations: Array.from({ length: 250 }, (_, index) => ({ id: `association-${index}`, knowledgeItemId: `knowledge-${index}`, targetKind: "topic", targetId: "topic-home" })),
    assets: [], collections: [], snapshots: []
  };
}

const measures = {};
try {
  const store = new FileSystemProjectStore(projectDirectory);
  await store.create(project());
  let canonical = await store.open();
  let before = serializeCanonicalJson(canonical);
  let adapter = SqliteSearchAdapter.open(projectDirectory);
  let started = performance.now();
  const initial = adapter.reconcile(canonical);
  measures.initialRebuildMs = Number((performance.now() - started).toFixed(1));
  measures.initialHits = (await adapter.search({ text: "evidence" })).total;

  const service = new ProjectService(store, { now: () => timestamp, createId: () => "unused" });
  await service.updateTopic("topic-home", { title: "Edited Canonical Runtime" });
  await service.deleteTopic("topic-delete");
  canonical = await store.open();
  started = performance.now();
  const stale = adapter.reconcile(canonical);
  measures.staleRebuildMs = Number((performance.now() - started).toFixed(1));
  measures.updatedHits = (await adapter.search({ text: "edited" })).total;

  const imported = structuredClone(canonical);
  imported.manifest.revision += 1;
  imported.knowledgeItems.push({ id: "knowledge-imported", type: "note", title: "Imported canonical item", availability: "local", createdAt: timestamp, updatedAt: timestamp });
  imported.associations.push({ id: "association-imported", knowledgeItemId: "knowledge-imported", targetKind: "topic", targetId: "topic-home" });
  await store.save(imported);
  canonical = await store.open();
  const importedStatus = adapter.reconcile(canonical);
  measures.importedHits = (await adapter.search({ text: "imported" })).total;
  adapter.close();

  const databasePath = path.join(projectDirectory, RUNTIME_DATABASE_PATH);
  await unlink(databasePath);
  adapter = SqliteSearchAdapter.open(projectDirectory);
  started = performance.now();
  const deleted = adapter.reconcile(canonical);
  measures.deletedRebuildMs = Number((performance.now() - started).toFixed(1));
  adapter.close();

  await writeFile(databasePath, "corrupted derived database", "utf8");
  adapter = SqliteSearchAdapter.open(projectDirectory);
  started = performance.now();
  const corrupted = adapter.reconcile(canonical);
  measures.corruptedRebuildMs = Number((performance.now() - started).toFixed(1));
  measures.corruptedRecoveryHits = (await adapter.search({ text: "imported" })).total;
  adapter.close();

  const after = serializeCanonicalJson(await store.open());
  before = serializeCanonicalJson(canonical);
  const result = { ...measures, initial: initial.action, stalePreviousRevision: stale.previousRuntimeRevision, imported: importedStatus.action, deleted: deleted.action, corrupted: corrupted.action, canonicalUnchangedByRuntime: before === after };
  result.accepted = result.initial === "rebuilt" && result.stalePreviousRevision === 0 && result.imported === "rebuilt" && result.deleted === "rebuilt" && result.corrupted === "rebuilt" && result.initialHits === 250 && result.updatedHits === 1 && result.importedHits === 1 && result.corruptedRecoveryHits === 1 && result.canonicalUnchangedByRuntime;
  console.log(JSON.stringify(result));
  if (!result.accepted) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
