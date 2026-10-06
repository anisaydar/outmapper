import { createHash } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { BlobReader, TextReader, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { createValidProject, timestamp } from "../test/project-fixtures.js";
import { FileSystemProjectStore } from "./filesystem-project-store.js";
import {
  PACKAGE_MANIFEST_PATH,
  ProjectPackageService,
  type ProjectPackageEntry,
  type ProjectPackageManifest
} from "./project-package.js";
import { serializeCanonicalJson } from "./serialization.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "outmapper-package-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createProject(projectDirectory: string, withAsset = true): Promise<void> {
  const project = createValidProject();
  project.projectLinks.push({ id: "portal-1", sourceTopicId: "topic-1", keyIssueId: "issue-1", targetProjectId: "external-project", cachedProjectTitle: "External Project", createdAt: timestamp, updatedAt: timestamp });
  if (withAsset) {
    const bytes = Buffer.from("portable evidence");
    project.assets.push({
      id: "asset-1",
      path: "assets/evidence.txt",
      originalFilename: "evidence.txt",
      mimeType: "text/plain",
      byteSize: bytes.length,
      sha256: sha256(bytes),
      createdAt: timestamp
    });
    project.knowledgeItems.push({
      id: "knowledge-1",
      type: "attachment",
      title: "Portable evidence",
      availability: "local",
      attachmentAssetIds: ["asset-1"],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    project.associations.push({
      id: "association-1",
      knowledgeItemId: "knowledge-1",
      targetKind: "topic",
      targetId: "topic-1"
    });
  }
  await new FileSystemProjectStore(projectDirectory).create(project);
  if (withAsset) {
    await mkdir(path.join(projectDirectory, "assets"), { recursive: true });
    await writeFile(path.join(projectDirectory, "assets", "evidence.txt"), "portable evidence", "utf8");
  }
  await mkdir(path.join(projectDirectory, ".outmapper"), { recursive: true });
  await writeFile(path.join(projectDirectory, ".outmapper", "runtime.sqlite"), "derived", "utf8");
}

async function zipEntries(archivePath: string): Promise<string[]> {
  const reader = new ZipReader(new BlobReader(await openAsBlob(archivePath)));
  try {
    return (await reader.getEntries()).map(({ filename }) => filename).sort();
  } finally {
    await reader.close();
  }
}

async function writeArchive(
  archivePath: string,
  entries: Array<{ name: string; value: string | Uint8Array; unixMode?: number }>
): Promise<void> {
  const writer = new ZipWriter(Writable.toWeb(createWriteStream(archivePath)), { zip64: true });
  for (const entry of entries) {
    const value = typeof entry.value === "string" ? entry.value : new TextDecoder().decode(entry.value);
    await writer.add(entry.name, new TextReader(value), {
      lastModDate: new Date("1980-01-01T00:00:00.000Z"),
      ...(entry.unixMode === undefined ? {} : { unixMode: entry.unixMode })
    });
  }
  await writer.close(undefined, { zip64: true });
}

async function collectFiles(root: string, directory = root): Promise<ProjectPackageEntry[]> {
  const entries: ProjectPackageEntry[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (relative === ".outmapper" || relative.startsWith(".outmapper/")) continue;
    if (item.isDirectory()) entries.push(...(await collectFiles(root, absolute)));
    if (item.isFile()) {
      const bytes = await readFile(absolute);
      entries.push({ path: relative, byteSize: bytes.length, sha256: sha256(bytes) });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function writeProjectArchive(projectDirectory: string, archivePath: string): Promise<void> {
  const project = await new FileSystemProjectStore(projectDirectory).open();
  const entries = await collectFiles(projectDirectory);
  const manifest: ProjectPackageManifest = {
    format: "outmapper-package",
    formatVersion: 1,
    projectId: project.manifest.id,
    projectRevision: project.manifest.revision,
    entries
  };
  const writer = new ZipWriter(Writable.toWeb(createWriteStream(archivePath)), { zip64: true });
  for (const entry of entries) {
    await writer.add(entry.path, new BlobReader(await openAsBlob(path.join(projectDirectory, ...entry.path.split("/")))));
  }
  await writer.add(PACKAGE_MANIFEST_PATH, new TextReader(serializeCanonicalJson(manifest)));
  await writer.close(undefined, { zip64: true });
}

describe("Project packages", () => {
  it("exports canonical files, stages validation, commits atomically, and rebuilds runtime state", async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, "source");
    const archive = path.join(root, "portable.outmapper");
    await createProject(source);
    const sourceBefore = await readFile(path.join(source, "project.json"), "utf8");
    const exporter = new ProjectPackageService({ projectDirectory: source, projectsDirectory: root });

    const manifest = await exporter.exportTo(archive);

    expect(manifest.entries.some(({ path: value }) => value === "assets/evidence.txt")).toBe(true);
    expect(manifest.entries.every(({ path: value }) => !value.startsWith(".outmapper/"))).toBe(true);
    expect(await zipEntries(archive)).not.toContain(".outmapper/runtime.sqlite");
    const importer = new ProjectPackageService({ projectDirectory: source, projectsDirectory: root });
    const plan = await importer.stageImport(archive);
    expect(plan).toMatchObject({ projectId: "project-1", assetCount: 1, missingAssets: [], warnings: [] });
    expect(await readFile(path.join(source, "project.json"), "utf8")).toBe(sourceBefore);

    const committed = await importer.commitImport(plan.id, "moved-project");
    const reopened = await new FileSystemProjectStore(committed.projectDirectory).open();
    expect(reopened).toEqual(await new FileSystemProjectStore(source).open());
    expect(reopened.projectLinks).toEqual([expect.objectContaining({ id: "portal-1", targetProjectId: "external-project" })]);
    expect(await readFile(path.join(committed.projectDirectory, "assets", "evidence.txt"), "utf8")).toBe(
      "portable evidence"
    );
    expect((await stat(path.join(committed.projectDirectory, ".outmapper", "runtime.sqlite"))).isFile()).toBe(true);
  });

  it("omits unused Asset records and files without deleting the local originals", async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, "source-with-unused-asset");
    const archive = path.join(root, "hygienic.outmapper");
    await createProject(source);
    const store = new FileSystemProjectStore(source);
    const project = await store.open();
    const unusedBytes = Buffer.from("unused local asset");
    project.assets.push({
      id: "asset-unused",
      path: "assets/unused.txt",
      originalFilename: "unused.txt",
      mimeType: "text/plain",
      byteSize: unusedBytes.length,
      sha256: sha256(unusedBytes),
      createdAt: timestamp
    });
    await writeFile(path.join(source, "assets", "unused.txt"), unusedBytes);
    await store.save(project);

    const service = new ProjectPackageService({ projectDirectory: source, projectsDirectory: root });
    const manifest = await service.exportTo(archive);

    expect(manifest.entries.map(({ path: value }) => value)).not.toContain("assets/unused.txt");
    expect(await zipEntries(archive)).not.toContain("assets/unused.txt");
    expect(await readFile(path.join(source, "assets", "unused.txt"), "utf8")).toBe("unused local asset");
    const plan = await service.stageImport(archive);
    expect(plan).toMatchObject({ assetCount: 1, missingAssets: [], warnings: [] });
  });

  it("imports a v1 package and applies the v2 Project migration", async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, "legacy-source");
    const archive = path.join(root, "legacy.outmapper");
    await createProject(source, false);
    await rm(path.join(source, "data", "project-links"), { recursive: true, force: true });
    const manifestPath = path.join(source, "project.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.formatVersion = 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeProjectArchive(source, archive);
    const service = new ProjectPackageService({ projectDirectory: source, projectsDirectory: root });

    const plan = await service.stageImport(archive);
    expect(plan.formatVersion).toBe(2);
    const committed = await service.commitImport(plan.id, "legacy-import");
    const imported = await new FileSystemProjectStore(committed.projectDirectory).open();
    expect(imported.manifest.formatVersion).toBe(2);
    expect(imported.projectLinks).toEqual([]);
  });

  it.each([
    ["parent traversal", "../escape.txt"],
    ["absolute path", "/absolute.txt"],
    ["Windows absolute path", "C:\\escape.txt"],
    ["reserved filename", "assets/CON.txt"]
  ])("rejects %s entries before extraction", async (_label, unsafePath) => {
    const root = await temporaryDirectory();
    const projectDirectory = path.join(root, "live");
    const archive = path.join(root, "hostile.outmapper");
    await createProject(projectDirectory, false);
    const before = await readFile(path.join(projectDirectory, "project.json"), "utf8");
    await writeArchive(archive, [
      { name: unsafePath, value: "hostile" },
      { name: PACKAGE_MANIFEST_PATH, value: "{}" }
    ]);
    const service = new ProjectPackageService({ projectDirectory, projectsDirectory: root });

    await expect(service.stageImport(archive)).rejects.toMatchObject({ name: "ProjectPackageError", code: "unsafe-path" });
    await expect(readFile(path.resolve(root, "escape.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(projectDirectory, "project.json"), "utf8")).toBe(before);
  });

  it("rejects case-colliding and symbolic-link archive entries", async () => {
    const root = await temporaryDirectory();
    const projectDirectory = path.join(root, "live");
    await createProject(projectDirectory, false);
    const service = new ProjectPackageService({ projectDirectory, projectsDirectory: root });
    const collision = path.join(root, "collision.outmapper");
    await writeArchive(collision, [
      { name: "assets/File.txt", value: "a" },
      { name: "assets/file.txt", value: "b" },
      { name: PACKAGE_MANIFEST_PATH, value: "{}" }
    ]);
    await expect(service.stageImport(collision)).rejects.toMatchObject({ code: "path-collision" });

    const link = path.join(root, "link.outmapper");
    await writeArchive(link, [
      { name: "assets/link", value: "target", unixMode: 0o120777 },
      { name: PACKAGE_MANIFEST_PATH, value: "{}" }
    ]);
    await expect(service.stageImport(link)).rejects.toMatchObject({ code: "special-entry" });
  });

  it("enforces archive size limits and cancellation without touching the live Project", async () => {
    const root = await temporaryDirectory();
    const projectDirectory = path.join(root, "live");
    const archive = path.join(root, "large.outmapper");
    await createProject(projectDirectory, false);
    const before = await readFile(path.join(projectDirectory, "project.json"), "utf8");
    await writeArchive(archive, [
      { name: "assets/large.txt", value: "x".repeat(2_048) },
      { name: PACKAGE_MANIFEST_PATH, value: "{}" }
    ]);
    const service = new ProjectPackageService({
      projectDirectory,
      projectsDirectory: root,
      limits: { maxEntryBytes: 1_024 }
    });
    await expect(service.stageImport(archive)).rejects.toMatchObject({ code: "archive-limit" });

    const controller = new AbortController();
    controller.abort();
    await expect(service.stageImport(archive, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(await readFile(path.join(projectDirectory, "project.json"), "utf8")).toBe(before);
  });

  it("rejects forged Asset MIME metadata after package integrity succeeds", async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, "forged-source");
    const archive = path.join(root, "forged.outmapper");
    const project = createValidProject();
    const executable = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    project.assets.push({
      id: "asset-forged",
      path: "assets/report.pdf",
      originalFilename: "report.pdf",
      mimeType: "application/pdf",
      byteSize: executable.length,
      sha256: sha256(executable),
      createdAt: timestamp
    });
    await new FileSystemProjectStore(source).create(project);
    await mkdir(path.join(source, "assets"), { recursive: true });
    await writeFile(path.join(source, "assets", "report.pdf"), executable);
    await writeProjectArchive(source, archive);
    const live = path.join(root, "live");
    await createProject(live, false);
    const service = new ProjectPackageService({ projectDirectory: live, projectsDirectory: root });

    await expect(service.stageImport(archive)).rejects.toMatchObject({ code: "forged-mime" });
  });

  it("does not overwrite an existing destination and can cancel a validated plan", async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, "source");
    const archive = path.join(root, "project.outmapper");
    await createProject(source, false);
    const service = new ProjectPackageService({ projectDirectory: source, projectsDirectory: root });
    await service.exportTo(archive);
    const plan = await service.stageImport(archive);
    await mkdir(path.join(root, "occupied"));

    await expect(service.commitImport(plan.id, "occupied")).rejects.toMatchObject({ code: "destination-exists" });
    await service.cancelImport(plan.id);
    await expect(service.commitImport(plan.id, "free")).rejects.toMatchObject({ code: "plan-not-found" });
  });
});
