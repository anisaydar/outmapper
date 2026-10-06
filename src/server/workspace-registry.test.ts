import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileSystemProjectStore } from "../project/filesystem-project-store.js";
import { ProjectReader } from "../project/project-reader.js";
import { createValidProject, timestamp } from "../test/project-fixtures.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

describe("WorkspaceRegistry", () => {
  let root = "";
  let projectDirectory = "";
  let stateDirectory = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "outmapper-registry-"));
    projectDirectory = path.join(root, "project-a");
    stateDirectory = path.join(root, "state");
    await new FileSystemProjectStore(projectDirectory).create(createValidProject());
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("rebuilds corrupt data from legacy recent Projects and the active Project", async () => {
    const legacyDirectory = path.join(root, "legacy");
    const legacy = createValidProject();
    legacy.manifest.id = "legacy-id";
    legacy.manifest.title = "Legacy";
    await new FileSystemProjectStore(legacyDirectory).create(legacy);
    await mkdir(path.join(stateDirectory, "workspace"), { recursive: true });
    await writeFile(path.join(stateDirectory, "workspace", "registry.json"), "not json", "utf8");
    await writeFile(path.join(stateDirectory, "recent-projects.json"), JSON.stringify([{ directory: legacyDirectory, title: "Legacy", id: "legacy-id" }]), "utf8");
    const active = await new FileSystemProjectStore(projectDirectory).open();

    const registry = new WorkspaceRegistry({ stateDirectory });
    await registry.initialize(projectDirectory, active);

    expect(Object.values(registry.list().projects).map(({ projectId }) => projectId).sort()).toEqual(["legacy-id", "project-1"]);
    await expect(readFile(path.join(stateDirectory, "recent-projects.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("tracks missing, mismatch, unreadable, needs-open, and duplicate instances", async () => {
    const active = await new FileSystemProjectStore(projectDirectory).open();
    const registry = new WorkspaceRegistry({ stateDirectory });
    await registry.initialize(projectDirectory, active);

    const duplicateDirectory = path.join(root, "project-copy");
    await cp(projectDirectory, duplicateDirectory, { recursive: true });
    const duplicate = await registry.registerDirectory(duplicateDirectory);
    expect(registry.get(duplicate.instanceId)?.status).toBe("duplicate");
    expect(registry.resolve(active.manifest.id).status).toBe("choose");
    await registry.setPreferred(active.manifest.id, duplicate.instanceId);
    expect(registry.resolve(active.manifest.id)).toMatchObject({ status: "resolved", project: { instanceId: duplicate.instanceId } });

    const marker = path.join(duplicateDirectory, ".outmapper", "runtime", "canonical-recovery.json");
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, JSON.stringify(active), "utf8");
    await registry.refresh();
    expect(registry.get(duplicate.instanceId)?.status).toBe("needs-open");
    await rm(marker);

    const manifestPath = path.join(duplicateDirectory, "project.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.id = "different-project";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await registry.refresh();
    expect(registry.get(duplicate.instanceId)?.status).toBe("mismatch");
    await expect(registry.registerDirectory(duplicateDirectory)).rejects.toThrow("Selected folder contains a different Project");

    await writeFile(manifestPath, "{", "utf8");
    await registry.refresh();
    expect(registry.get(duplicate.instanceId)?.status).toBe("unreadable");

    await rm(duplicateDirectory, { recursive: true });
    await registry.refresh();
    expect(registry.get(duplicate.instanceId)?.status).toBe("missing");
  });

  it("re-reads only entries whose canonical fingerprint changed and forgets without deleting files", async () => {
    class CountingReader extends ProjectReader {
      reads = 0;
      override async read(directory: string, expectedProjectId?: string) {
        this.reads += 1;
        return super.read(directory, expectedProjectId);
      }
    }
    const reader = new CountingReader();
    const active = await new FileSystemProjectStore(projectDirectory).open();
    const registry = new WorkspaceRegistry({ stateDirectory, reader });
    await registry.initialize(projectDirectory, active);
    reader.reads = 0;
    await registry.refresh();
    expect(reader.reads).toBe(0);
    const renamed = path.join(root, "moved-project");
    await rename(projectDirectory, renamed);
    await registry.refresh();
    const entry = Object.values(registry.list().projects)[0]!;
    expect(entry.status).toBe("missing");
    await registry.forget(entry.instanceId);
    expect(registry.list().projects).toEqual({});
    expect(await new FileSystemProjectStore(renamed).open()).toMatchObject({ manifest: { id: "project-1" } });
  });

  it("merges independently written registry entries before each atomic save", async () => {
    const active = await new FileSystemProjectStore(projectDirectory).open();
    const first = new WorkspaceRegistry({ stateDirectory });
    const second = new WorkspaceRegistry({ stateDirectory });
    await first.initialize(projectDirectory, active);
    await second.initialize(projectDirectory, active);
    const otherDirectory = path.join(root, "other");
    const other = createValidProject();
    other.manifest.id = "other-id";
    await new FileSystemProjectStore(otherDirectory).create(other);
    await first.registerDirectory(otherDirectory);
    await second.removeFromRecent(Object.keys(second.list().projects)[0]!);
    expect(Object.values(second.list().projects).map(({ projectId }) => projectId).sort()).toEqual(["other-id", "project-1"]);
  });

  it("derives incoming links from cached outgoing links and rebuilds them after sweeps, locate, register, and forget", async () => {
    const target = await new FileSystemProjectStore(projectDirectory).open();
    const registry = new WorkspaceRegistry({ stateDirectory });
    await registry.initialize(projectDirectory, target);
    const sourceDirectory = path.join(root, "source");
    const source = createValidProject();
    source.manifest.id = "source-project";
    source.manifest.title = "Source Project";
    source.topics[0]!.title = "Source Topic";
    source.keyIssues[0]!.title = "Source Issue";
    source.projectLinks = [{
      id: "incoming-1",
      sourceTopicId: "topic-1",
      keyIssueId: "issue-1",
      targetProjectId: target.manifest.id,
      cachedProjectTitle: target.manifest.title,
      createdAt: timestamp,
      updatedAt: timestamp
    }];
    const sourceStore = new FileSystemProjectStore(sourceDirectory);
    await sourceStore.create(source);
    const sourceEntry = await registry.register(sourceDirectory, source);

    expect(registry.incomingFor(target)).toEqual({
      projectId: "project-1",
      total: 1,
      groups: [{ topicId: "topic-1", links: [expect.objectContaining({
        linkId: "incoming-1",
        sourceInstanceId: sourceEntry.instanceId,
        sourceProjectTitle: "Source Project",
        sourceTopicTitle: "Source Topic",
        keyIssueTitle: "Source Issue",
        availability: "available"
      })] }]
    });

    target.manifest.homeTopicId = "topic-2";
    expect(registry.incomingFor(target).groups[0]?.topicId).toBe("topic-2");

    const movedDirectory = path.join(root, "source-moved");
    await rename(sourceDirectory, movedDirectory);
    const located = await registry.locate(sourceEntry.instanceId, movedDirectory);
    expect(registry.incomingFor(target).groups[0]?.links[0]?.sourceInstanceId).toBe(located.instanceId);

    const movedStore = new FileSystemProjectStore(movedDirectory);
    const changed = await movedStore.open();
    changed.projectLinks = [];
    await movedStore.save(changed);
    await registry.refresh();
    expect(registry.incomingFor(target).total).toBe(0);

    changed.projectLinks = source.projectLinks;
    await movedStore.save(changed);
    await registry.register(movedDirectory, changed);
    expect(registry.incomingFor(target).total).toBe(1);
    await registry.forget(located.instanceId);
    expect(registry.incomingFor(target).total).toBe(0);
  });

  it("aggregates the Universe by Project identity, preferred instance, direction, and link count", async () => {
    const target = await new FileSystemProjectStore(projectDirectory).open();
    const registry = new WorkspaceRegistry({ stateDirectory });
    await registry.initialize(projectDirectory, target);

    const duplicateDirectory = path.join(root, "target-copy");
    await cp(projectDirectory, duplicateDirectory, { recursive: true });
    const duplicate = await registry.registerDirectory(duplicateDirectory);
    await registry.setPreferred(target.manifest.id, duplicate.instanceId);

    const sourceDirectory = path.join(root, "universe-source");
    const source = createValidProject();
    source.manifest.id = "universe-source";
    source.manifest.title = "Universe Source";
    source.keyIssues.push({ id: "issue-2", topicId: "topic-1", title: "Second Issue", order: 1, createdAt: timestamp, updatedAt: timestamp });
    source.projectLinks = [0, 1].map((index) => ({
      id: `universe-link-${index}`,
      sourceTopicId: "topic-1",
      keyIssueId: index === 0 ? "issue-1" : "issue-2",
      targetProjectId: target.manifest.id,
      cachedProjectTitle: target.manifest.title,
      createdAt: timestamp,
      updatedAt: timestamp
    }));
    await new FileSystemProjectStore(sourceDirectory).create(source);
    const sourceEntry = await registry.register(sourceDirectory, source);
    await rm(sourceDirectory, { recursive: true });
    await registry.refresh();

    const universe = registry.universe(() => undefined);
    expect(universe.nodes).toHaveLength(2);
    expect(universe.nodes.find(({ projectId }) => projectId === target.manifest.id)).toMatchObject({
      instanceId: duplicate.instanceId,
      duplicateCount: 2,
      status: "duplicate"
    });
    expect(universe.nodes.find(({ projectId }) => projectId === source.manifest.id)).toMatchObject({
      instanceId: sourceEntry.instanceId,
      status: "missing"
    });
    expect(universe.edges).toEqual([{
      id: "universe-source:project-1",
      sourceProjectId: "universe-source",
      targetProjectId: "project-1",
      count: 2
    }]);
  });
});
