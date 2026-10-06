import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectService } from "../domain/project-service.js";
import { FileSystemProjectStore } from "../project/filesystem-project-store.js";
import { createValidProject } from "../test/project-fixtures.js";
import { SessionHistoryManager } from "./session-history-manager.js";
import { instanceIdForDirectory } from "./workspace-registry.js";

async function makeProject(root: string, name: string) {
  const directory = path.join(root, name);
  const project = createValidProject();
  project.manifest.id = `project-${name}`;
  await new FileSystemProjectStore(directory).create(project);
  return { directory, instanceId: await instanceIdForDirectory(directory) };
}

describe("SessionHistoryManager", () => {
  it("keeps Undo by folder instance and clears it after an external edit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "outmapper-histories-"));
    try {
      const a = await makeProject(root, "a");
      const b = await makeProject(root, "b");
      const manager = new SessionHistoryManager();
      const first = await manager.activate(a.instanceId, a.directory);
      await first.history.run(() => new ProjectService(first.store).updateTopic("topic-1", { title: "Edited A" }));
      await manager.markCurrent(await first.store.load());
      await manager.activate(b.instanceId, b.directory);
      const returned = await manager.activate(a.instanceId, a.directory);
      expect(returned.historyCleared).toBe(false);
      expect(returned.history.state.canUndo).toBe(true);
      await returned.history.undo();
      expect((await returned.store.load()).topics[0]?.title).toBe("Center");

      await manager.markCurrent(await returned.store.load());
      await manager.activate(b.instanceId, b.directory);
      const manifestPath = path.join(a.directory, "project.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      manifest.revision = Number(manifest.revision) + 1;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      const changed = await manager.activate(a.instanceId, a.directory);
      expect(changed.historyCleared).toBe(true);
      expect(changed.history.state).toEqual({ canUndo: false, canRedo: false });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("evicts the least recently used history after five inactive instances", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "outmapper-history-lru-"));
    try {
      const manager = new SessionHistoryManager(5);
      const projects = await Promise.all(Array.from({ length: 7 }, (_, index) => makeProject(root, String(index))));
      for (const project of projects) await manager.activate(project.instanceId, project.directory);
      expect(manager.has(projects[0]!.instanceId)).toBe(false);
      expect(manager.has(projects[1]!.instanceId)).toBe(true);
      expect(manager.has(projects[6]!.instanceId)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
