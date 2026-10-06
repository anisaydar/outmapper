import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createValidProject } from "../test/project-fixtures.js";
import type { CanonicalProject } from "../domain/types.js";
import { FileSystemProjectStore, pendingWriteKey } from "./filesystem-project-store.js";
import { serializeCanonicalJson } from "./serialization.js";

describe("filesystem Project store", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("creates a canonical directory and reopens it with a fresh store", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "outmapper-store-"));
    directories.push(parent);
    const projectDirectory = path.join(parent, "project");
    const project = createValidProject();

    await new FileSystemProjectStore(projectDirectory).create(project);
    const reopened = await new FileSystemProjectStore(projectDirectory).open();

    expect(reopened).toEqual(project);
    const manifest = await readFile(path.join(projectDirectory, "project.json"), "utf8");
    expect(manifest).toContain('"formatVersion": 2');
    expect(JSON.parse(await readFile(path.join(projectDirectory, "data", "project-links", "records.json"), "utf8"))).toEqual([]);
    expect(manifest.endsWith("\n")).toBe(true);
  });

  it("opens the canonical multilingual fixture", async () => {
    const fixture = path.resolve("fixtures/projects/ai-landscape");
    const project = await new FileSystemProjectStore(fixture).open();

    expect(project.manifest.homeTopicId).toBe("topic-ai");
    expect(project.topics).toHaveLength(22);
    expect(project.relationships.filter(({ sourceTopicId, targetTopicId }) => sourceTopicId === "topic-ai" && targetTopicId === "topic-science")).toHaveLength(2);
  });

  it("does not overwrite a non-empty directory during creation", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "outmapper-store-"));
    directories.push(parent);
    const store = new FileSystemProjectStore(parent);
    await writeFile(path.join(parent, "existing.txt"), "keep", "utf8");

    await expect(store.create(createValidProject())).rejects.toThrow("Project directory is not empty");
  });

  it("rejects a stale save after another writer changes the canonical files", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "outmapper-store-"));
    directories.push(parent);
    const projectDirectory = path.join(parent, "project");
    const first = new FileSystemProjectStore(projectDirectory);
    await first.create(createValidProject());
    const second = new FileSystemProjectStore(projectDirectory);
    const stale = await second.open();
    const current = await first.load();
    current.topics[0].title = "Saved elsewhere";
    current.manifest.revision += 1;
    await first.save(current);
    stale.topics[0].title = "Stale edit";
    stale.manifest.revision += 1;

    await expect(second.save(stale)).rejects.toMatchObject({ code: "conflicting-save" });
    expect((await new FileSystemProjectStore(projectDirectory).open()).topics[0].title).toBe("Saved elsewhere");
  });

  it("finishes a checkpointed canonical write when the Project is reopened", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "outmapper-store-"));
    directories.push(parent);
    const projectDirectory = path.join(parent, "project");
    const store = new FileSystemProjectStore(projectDirectory);
    const project = createValidProject();
    await store.create(project);

    const recovered = structuredClone(project);
    recovered.topics[0].title = "Recovered title";
    recovered.manifest.revision = 1;
    const checkpoint = path.join(projectDirectory, ".outmapper", "runtime", "canonical-recovery.json");
    await mkdir(path.dirname(checkpoint), { recursive: true });
    await writeFile(checkpoint, serializeCanonicalJson(recovered), "utf8");

    const reopened = await new FileSystemProjectStore(projectDirectory).open();
    expect(reopened.topics[0].title).toBe("Recovered title");
    expect(reopened.manifest.revision).toBe(1);
    await expect(readFile(checkpoint, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates v1 in memory and persists v2 on the next save", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "outmapper-store-"));
    directories.push(parent);
    const projectDirectory = path.join(parent, "project");
    const store = new FileSystemProjectStore(projectDirectory);
    await store.create(createValidProject());
    const manifestPath = path.join(projectDirectory, "project.json");
    const oldManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    oldManifest.formatVersion = 1;
    await writeFile(manifestPath, serializeCanonicalJson(oldManifest), "utf8");
    const linksPath = path.join(projectDirectory, "data", "project-links", "records.json");
    await unlink(linksPath);

    const reopenedStore = new FileSystemProjectStore(projectDirectory);
    const migrated = await reopenedStore.open();
    expect(migrated.manifest.formatVersion).toBe(2);
    expect(migrated.projectLinks).toEqual([]);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(oldManifest);
    await expect(readFile(linksPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    migrated.manifest.revision += 1;
    await reopenedStore.save(migrated);
    expect(JSON.parse(await readFile(manifestPath, "utf8")).formatVersion).toBe(2);
    expect(JSON.parse(await readFile(linksPath, "utf8"))).toEqual([]);
  });

  it("finishes a write another process paused part-way, even when its checkpoint appears during a read", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "outmapper-store-"));
    directories.push(parent);
    const projectDirectory = path.join(parent, "project");
    await new FileSystemProjectStore(projectDirectory).create(createValidProject());
    const written = createValidProject();
    written.topics[0].title = "Written elsewhere";
    written.manifest.revision = 1;
    const store = new FileSystemProjectStore(projectDirectory);
    type Snapshot = { project: CanonicalProject; fingerprint: string };
    const internals = store as unknown as { readCanonicalSnapshot: () => Promise<Snapshot> };
    const read = internals.readCanonicalSnapshot.bind(store);
    // The other writer starts after the read checked for a checkpoint: it checkpoints, writes one file, then stalls.
    vi.spyOn(internals, "readCanonicalSnapshot").mockImplementationOnce(async () => {
      const checkpoint = path.join(projectDirectory, ".outmapper", "runtime", "canonical-recovery.json");
      await mkdir(path.dirname(checkpoint), { recursive: true });
      await writeFile(checkpoint, serializeCanonicalJson(written), "utf8");
      await writeFile(path.join(projectDirectory, "data", "topics", "records.json"), serializeCanonicalJson(written.topics), "utf8");
      return read();
    });

    const opened = await store.open();

    expect(opened.topics[0].title).toBe("Written elsewhere");
    expect(opened.manifest.revision).toBe(1);
    expect(JSON.parse(await readFile(path.join(projectDirectory, "project.json"), "utf8")).revision).toBe(1);
    await expect(readFile(path.join(projectDirectory, ".outmapper", "runtime", "canonical-recovery.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keys in-process writes by folder, however its path is spelled", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "outmapper-store-"));
    directories.push(parent);
    const projectDirectory = path.join(parent, "project");
    const writer = new FileSystemProjectStore(projectDirectory);
    await writer.create(createValidProject());
    const spelling = process.platform === "win32" ? projectDirectory.toUpperCase() : path.join(projectDirectory, "data", "..");
    expect(pendingWriteKey(spelling)).toBe(pendingWriteKey(projectDirectory));
    expect(pendingWriteKey(`${projectDirectory}${path.sep}`)).toBe(pendingWriteKey(projectDirectory));

    const reader = new FileSystemProjectStore(spelling);
    const internals = reader as unknown as { readCanonicalSnapshot: () => Promise<unknown> };
    const snapshots = vi.spyOn(internals, "readCanonicalSnapshot");
    const next = await writer.open();
    next.topics[0].title = "Saved first";
    next.manifest.revision += 1;

    // The read waits for the save under the other spelling, so it reads once and sees the saved Project.
    const [, opened] = await Promise.all([writer.save(next), reader.open()]);

    expect(opened.topics[0].title).toBe("Saved first");
    expect(snapshots).toHaveBeenCalledOnce();
  });
});
