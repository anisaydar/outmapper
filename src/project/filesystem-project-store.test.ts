import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createValidProject } from "../test/project-fixtures.js";
import { FileSystemProjectStore } from "./filesystem-project-store.js";
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
    expect(manifest).toContain('"formatVersion": 1');
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

  it("retains an exact pre-migration backup when an old-format migration cannot proceed", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "outmapper-store-"));
    directories.push(parent);
    const projectDirectory = path.join(parent, "project");
    const store = new FileSystemProjectStore(projectDirectory);
    await store.create(createValidProject());
    const manifestPath = path.join(projectDirectory, "project.json");
    const oldManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    oldManifest.formatVersion = 0;
    await writeFile(manifestPath, serializeCanonicalJson(oldManifest), "utf8");

    await expect(new FileSystemProjectStore(projectDirectory).open()).rejects.toThrow("No migration is registered");
    const backupsRoot = path.join(projectDirectory, ".outmapper", "migration-backups");
    const backups = await readdir(backupsRoot);
    expect(backups).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(backupsRoot, backups[0], "project.json"), "utf8"))).toEqual(oldManifest);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(oldManifest);
  });
});
