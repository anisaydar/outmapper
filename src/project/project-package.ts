import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import {
  BlobReader,
  TextReader,
  TextWriter,
  ZipReader,
  ZipWriter,
  type Entry,
  type FileEntry
} from "@zip.js/zip.js";
import type { CanonicalProject } from "../domain/types.js";
import { SqliteSearchAdapter } from "../search/sqlite-search-adapter.js";
import { AssetStoreError, assertMimeMatches, sniffAssetMime } from "./asset-store.js";
import { CANONICAL_PROJECT_FILES, FileSystemProjectStore } from "./filesystem-project-store.js";
import { normalizeProjectPath, resolveProjectPath } from "./paths.js";
import { serializeCanonicalJson } from "./serialization.js";

export const PACKAGE_MANIFEST_PATH = ".outmapper-package.json";

export interface ProjectPackageLimits {
  maxCompressedBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
  maxCompressionRatio: number;
  maxPathDepth: number;
  maxPathLength: number;
}

export const DEFAULT_PACKAGE_LIMITS: ProjectPackageLimits = {
  maxCompressedBytes: 512 * 1024 * 1024,
  maxEntries: 20_000,
  maxEntryBytes: 512 * 1024 * 1024,
  maxExpandedBytes: 2 * 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxPathDepth: 32,
  maxPathLength: 1_000
};

export interface ProjectPackageEntry {
  path: string;
  byteSize: number;
  sha256: string;
}

export interface ProjectPackageManifest {
  format: "outmapper-package";
  formatVersion: 1;
  projectId: string;
  projectRevision: number;
  entries: ProjectPackageEntry[];
}

export interface ImportPlan {
  id: string;
  projectId: string;
  projectTitle: string;
  projectRevision: number;
  formatVersion: number;
  compressedBytes: number;
  expandedBytes: number;
  entryCount: number;
  assetCount: number;
  missingAssets: string[];
  warnings: string[];
  suggestedDirectoryName: string;
}

interface StagedImport {
  plan: ImportPlan;
  stagingDirectory: string;
  extractedDirectory: string;
}

export class ProjectPackageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectPackageError";
    this.code = code;
  }
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProjectPackageError("cancelled", "Package operation was cancelled");
}

function archivePath(value: string, limits: ProjectPackageLimits): string {
  const replaced = value.normalize("NFC").replaceAll("\\", "/");
  let normalized: string;
  try {
    normalized = normalizeProjectPath(replaced);
  } catch (error) {
    throw new ProjectPackageError("unsafe-path", (error as Error).message);
  }
  if (normalized.length > limits.maxPathLength) {
    throw new ProjectPackageError("unsafe-path", `Archive path exceeds ${limits.maxPathLength} characters`);
  }
  const segments = normalized.split("/");
  if (segments.length > limits.maxPathDepth) {
    throw new ProjectPackageError("unsafe-path", `Archive path exceeds ${limits.maxPathDepth} segments`);
  }
  for (const segment of segments) {
    if (containsUnsafeFilenameCharacters(segment) || /[. ]$/u.test(segment)) {
      throw new ProjectPackageError("unsafe-path", `Archive path contains an unsafe filename: ${segment}`);
    }
    const stem = segment.split(".")[0]?.toUpperCase();
    if (stem && /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)) {
      throw new ProjectPackageError("unsafe-path", `Archive path contains a reserved filename: ${segment}`);
    }
  }
  return normalized;
}

function collisionKey(logicalPath: string): string {
  return logicalPath.normalize("NFKC").toLocaleLowerCase("en-US");
}

function containsUnsafeFilenameCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 || '<>:"|?*'.includes(character);
  });
}

function assertOrdinaryEntry(entry: Entry): void {
  if (entry.encrypted) throw new ProjectPackageError("encrypted-entry", `Encrypted entry is not supported: ${entry.filename}`);
  if (entry.diskNumberStart !== 0) {
    throw new ProjectPackageError("split-archive", "Split archives are not supported for Project import");
  }
  const type = (entry.unixMode ?? entry.unixExternalUpper ?? 0) & 0o170000;
  if (type !== 0 && type !== 0o100000 && type !== 0o040000) {
    throw new ProjectPackageError("special-entry", `Links and special archive entries are not allowed: ${entry.filename}`);
  }
  if (entry.setuid || entry.setgid) {
    throw new ProjectPackageError("special-entry", `Privileged archive entries are not allowed: ${entry.filename}`);
  }
}

async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath, { signal })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function sha256Text(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function referencedAssetIds(project: CanonicalProject): Set<string> {
  const ids = new Set<string>();
  for (const topic of project.topics) if (topic.visualAssetId) ids.add(topic.visualAssetId);
  for (const issue of project.keyIssues) if (issue.visualAssetId) ids.add(issue.visualAssetId);
  for (const item of project.knowledgeItems) for (const assetId of item.attachmentAssetIds ?? []) ids.add(assetId);
  for (const assetId of project.theme?.brandingAssetIds ?? []) ids.add(assetId);
  for (const snapshot of project.snapshots) for (const assetId of snapshot.assetIds) ids.add(assetId);
  return ids;
}

export function projectForExport(project: CanonicalProject): CanonicalProject {
  const used = referencedAssetIds(project);
  return { ...project, assets: project.assets.filter(({ id }) => used.has(id)) };
}

async function projectFiles(projectDirectory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string, relativeDirectory = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (relativePath === ".outmapper" || relativePath.startsWith(".outmapper/")) continue;
      if (relativePath === PACKAGE_MANIFEST_PATH || relativePath.endsWith(".tmp")) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new ProjectPackageError("special-entry", `Project export cannot follow a symbolic link: ${relativePath}`);
      }
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile()) files.push(normalizeProjectPath(relativePath));
      else throw new ProjectPackageError("special-entry", `Project export found a special file: ${relativePath}`);
    }
  };
  await visit(projectDirectory);
  return files.sort((left, right) => left.localeCompare(right));
}

function validatePackageManifest(value: unknown): asserts value is ProjectPackageManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectPackageError("invalid-manifest", "Package manifest must be an object");
  }
  const manifest = value as Partial<ProjectPackageManifest>;
  if (
    manifest.format !== "outmapper-package" ||
    manifest.formatVersion !== 1 ||
    typeof manifest.projectId !== "string" ||
    !Number.isInteger(manifest.projectRevision) ||
    !Array.isArray(manifest.entries)
  ) {
    throw new ProjectPackageError("invalid-manifest", "Package manifest is invalid or unsupported");
  }
  for (const entry of manifest.entries) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !Number.isSafeInteger(entry.byteSize) ||
      entry.byteSize < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new ProjectPackageError("invalid-manifest", "Package manifest contains an invalid entry");
    }
  }
}

async function readHeader(filePath: string): Promise<Buffer> {
  const handle = await import("node:fs/promises").then(({ open }) => open(filePath, "r"));
  try {
    const buffer = Buffer.alloc(1_024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function validateManagedFiles(
  projectDirectory: string,
  project: CanonicalProject,
  signal?: AbortSignal
): Promise<{ missingAssets: string[]; warnings: string[] }> {
  const missingAssets: string[] = [];
  const warnings: string[] = [];
  for (const asset of project.assets) {
    abortIfNeeded(signal);
    if (!asset.path.startsWith("assets/")) {
      throw new ProjectPackageError("invalid-asset", `Managed Asset path must be under assets/: ${asset.path}`);
    }
    const assetPath = resolveProjectPath(projectDirectory, asset.path);
    let assetStats;
    try {
      assetStats = await lstat(assetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missingAssets.push(asset.id);
        warnings.push(`Asset ${asset.originalFilename} is missing`);
        continue;
      }
      throw error;
    }
    if (!assetStats.isFile() || assetStats.isSymbolicLink()) {
      throw new ProjectPackageError("invalid-asset", `Managed Asset is not an ordinary file: ${asset.path}`);
    }
    if (assetStats.size !== asset.byteSize) {
      throw new ProjectPackageError("asset-integrity", `Asset byte size does not match metadata: ${asset.path}`);
    }
    if ((await sha256File(assetPath, signal)) !== asset.sha256) {
      throw new ProjectPackageError("asset-integrity", `Asset SHA-256 does not match metadata: ${asset.path}`);
    }
    try {
      assertMimeMatches(asset.mimeType, sniffAssetMime(await readHeader(assetPath)), asset.path);
    } catch (error) {
      if (error instanceof AssetStoreError) throw new ProjectPackageError(error.code, error.message);
      throw error;
    }
  }
  for (const item of project.knowledgeItems) {
    if (!item.contentPath) continue;
    try {
      const contentStats = await lstat(resolveProjectPath(projectDirectory, item.contentPath));
      if (!contentStats.isFile() || contentStats.isSymbolicLink()) {
        warnings.push(`Knowledge content is unavailable: ${item.contentPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") warnings.push(`Knowledge content is missing: ${item.contentPath}`);
      else throw error;
    }
  }
  for (const snapshot of project.snapshots) {
    try {
      const snapshotStats = await lstat(resolveProjectPath(projectDirectory, snapshot.manifestPath));
      if (!snapshotStats.isFile() || snapshotStats.isSymbolicLink()) throw new Error("not a regular file");
    } catch {
      throw new ProjectPackageError("snapshot-integrity", `Published Snapshot manifest is missing: ${snapshot.manifestPath}`);
    }
  }
  return { missingAssets, warnings };
}

function safeDirectoryName(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (
    !normalized ||
    normalized.length > 100 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    containsUnsafeFilenameCharacters(normalized) ||
    /[. ]$/u.test(normalized)
  ) {
    throw new ProjectPackageError("unsafe-destination", "Import directory name is invalid");
  }
  return normalized;
}

function slug(value: string): string {
  const result = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return result || "imported-project";
}

export class ProjectPackageService {
  readonly projectDirectory: string;
  readonly projectsDirectory: string;
  readonly limits: ProjectPackageLimits;
  private readonly imports = new Map<string, StagedImport>();

  constructor(options: {
    projectDirectory: string;
    projectsDirectory?: string;
    limits?: Partial<ProjectPackageLimits>;
  }) {
    this.projectDirectory = path.resolve(options.projectDirectory);
    this.projectsDirectory = path.resolve(options.projectsDirectory ?? path.dirname(this.projectDirectory));
    this.limits = { ...DEFAULT_PACKAGE_LIMITS, ...options.limits };
  }

  async exportTo(outputPath: string, signal?: AbortSignal): Promise<ProjectPackageManifest> {
    abortIfNeeded(signal);
    const project = await new FileSystemProjectStore(this.projectDirectory).open();
    const exportedProject = projectForExport(project);
    await validateManagedFiles(this.projectDirectory, exportedProject, signal);
    const usedAssetPaths = new Set(exportedProject.assets.map(({ path: assetPath }) => assetPath));
    const logicalPaths = (await projectFiles(this.projectDirectory)).filter((logicalPath) =>
      !logicalPath.startsWith("assets/") || usedAssetPaths.has(logicalPath));
    const assetRecords = serializeCanonicalJson(exportedProject.assets);
    const entries: ProjectPackageEntry[] = [];
    for (const logicalPath of logicalPaths) {
      abortIfNeeded(signal);
      if (logicalPath === CANONICAL_PROJECT_FILES.assets) {
        entries.push({ path: logicalPath, byteSize: Buffer.byteLength(assetRecords), sha256: sha256Text(assetRecords) });
      } else {
        const filePath = resolveProjectPath(this.projectDirectory, logicalPath);
        const fileStats = await stat(filePath);
        entries.push({ path: logicalPath, byteSize: fileStats.size, sha256: await sha256File(filePath, signal) });
      }
    }
    const manifest: ProjectPackageManifest = {
      format: "outmapper-package",
      formatVersion: 1,
      projectId: project.manifest.id,
      projectRevision: project.manifest.revision,
      entries
    };
    await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    const temporary = `${path.resolve(outputPath)}.${randomUUID()}.tmp`;
    try {
      const writer = new ZipWriter(Writable.toWeb(createWriteStream(temporary)), {
        zip64: true,
        signal,
        useUnicodeFileNames: true
      });
      for (const entry of entries) {
        abortIfNeeded(signal);
        const reader = entry.path === CANONICAL_PROJECT_FILES.assets
          ? new TextReader(assetRecords)
          : new BlobReader(await openAsBlob(resolveProjectPath(this.projectDirectory, entry.path)));
        await writer.add(entry.path, reader, {
          level: 6,
          lastModDate: new Date("1980-01-01T00:00:00.000Z"),
          signal,
          zip64: entry.byteSize >= 0xffff_ffff
        });
      }
      await writer.add(PACKAGE_MANIFEST_PATH, new TextReader(serializeCanonicalJson(manifest)), {
        lastModDate: new Date("1980-01-01T00:00:00.000Z"),
        signal
      });
      await writer.close(undefined, { zip64: true });
      await rename(temporary, path.resolve(outputPath));
      return manifest;
    } catch (error) {
      await rm(temporary, { force: true });
      if (signal?.aborted) throw new ProjectPackageError("cancelled", "Package export was cancelled");
      throw error;
    }
  }

  async stageImport(packagePath: string, signal?: AbortSignal): Promise<ImportPlan> {
    abortIfNeeded(signal);
    const packageStats = await stat(packagePath);
    if (!packageStats.isFile() || packageStats.size > this.limits.maxCompressedBytes) {
      throw new ProjectPackageError("archive-limit", "Package exceeds the compressed-size limit");
    }
    const id = randomUUID();
    const stagingDirectory = path.join(this.projectsDirectory, ".outmapper-imports", id);
    const extractedDirectory = path.join(stagingDirectory, "project");
    await mkdir(extractedDirectory, { recursive: true });
    const reader = new ZipReader(new BlobReader(await openAsBlob(packagePath)), {
      checkAmbiguity: true,
      signal
    });
    try {
      const archiveEntries = await reader.getEntries();
      if (archiveEntries.length > this.limits.maxEntries) {
        throw new ProjectPackageError("archive-limit", "Package exceeds the entry-count limit");
      }
      const seen = new Map<string, string>();
      const normalizedEntries: Array<{ entry: FileEntry; logicalPath: string }> = [];
      let expandedBytes = 0;
      for (const entry of archiveEntries) {
        abortIfNeeded(signal);
        assertOrdinaryEntry(entry);
        const logicalPath = archivePath(entry.filename.replace(/\/$/u, ""), this.limits);
        const key = collisionKey(logicalPath);
        const previous = seen.get(key);
        if (previous) {
          throw new ProjectPackageError("path-collision", `Archive paths collide: ${previous} and ${logicalPath}`);
        }
        seen.set(key, logicalPath);
        if (entry.directory) continue;
        if (entry.uncompressedSize > this.limits.maxEntryBytes) {
          throw new ProjectPackageError("archive-limit", `Archive entry exceeds the per-entry limit: ${logicalPath}`);
        }
        expandedBytes += entry.uncompressedSize;
        if (expandedBytes > this.limits.maxExpandedBytes) {
          throw new ProjectPackageError("archive-limit", "Package exceeds the expanded-size limit");
        }
        const ratio = entry.uncompressedSize / Math.max(1, entry.compressedSize);
        if (ratio > this.limits.maxCompressionRatio) {
          throw new ProjectPackageError("archive-limit", `Archive entry exceeds the compression-ratio limit: ${logicalPath}`);
        }
        normalizedEntries.push({ entry, logicalPath });
      }
      const packageEntry = normalizedEntries.find(({ logicalPath }) => logicalPath === PACKAGE_MANIFEST_PATH);
      if (!packageEntry) throw new ProjectPackageError("invalid-manifest", "Package manifest is missing");
      if (packageEntry.entry.uncompressedSize > 2 * 1024 * 1024) {
        throw new ProjectPackageError("invalid-manifest", "Package manifest is too large");
      }
      const manifestText = await packageEntry.entry.getData(new TextWriter(), { checkSignature: true, signal });
      let manifestValue: unknown;
      try {
        manifestValue = JSON.parse(manifestText) as unknown;
      } catch {
        throw new ProjectPackageError("invalid-manifest", "Package manifest contains invalid JSON");
      }
      validatePackageManifest(manifestValue);
      const packageManifest = manifestValue;

      for (const { entry, logicalPath } of normalizedEntries) {
        if (logicalPath === PACKAGE_MANIFEST_PATH) continue;
        abortIfNeeded(signal);
        const destination = resolveProjectPath(extractedDirectory, logicalPath);
        await mkdir(path.dirname(destination), { recursive: true });
        await entry.getData(Writable.toWeb(createWriteStream(destination)), { checkSignature: true, signal });
      }

      const archiveFiles = normalizedEntries
        .filter(({ logicalPath }) => logicalPath !== PACKAGE_MANIFEST_PATH)
        .map(({ logicalPath }) => logicalPath)
        .sort((left, right) => left.localeCompare(right));
      const declaredFiles = packageManifest.entries.map(({ path: value }) => archivePath(value, this.limits));
      if (
        archiveFiles.length !== declaredFiles.length ||
        archiveFiles.some((value, index) => value !== [...declaredFiles].sort((left, right) => left.localeCompare(right))[index])
      ) {
        throw new ProjectPackageError("integrity", "Package entries do not match the integrity manifest");
      }
      for (const declared of packageManifest.entries) {
        abortIfNeeded(signal);
        const logicalPath = archivePath(declared.path, this.limits);
        const filePath = resolveProjectPath(extractedDirectory, logicalPath);
        const fileStats = await stat(filePath);
        if (fileStats.size !== declared.byteSize || (await sha256File(filePath, signal)) !== declared.sha256) {
          throw new ProjectPackageError("integrity", `Package integrity check failed: ${logicalPath}`);
        }
      }
      const store = new FileSystemProjectStore(extractedDirectory);
      const project = await store.open();
      if (
        project.manifest.id !== packageManifest.projectId ||
        project.manifest.revision !== packageManifest.projectRevision
      ) {
        throw new ProjectPackageError("integrity", "Package and Project manifest identities do not match");
      }
      const managedFiles = await validateManagedFiles(extractedDirectory, project, signal);
      const runtime = SqliteSearchAdapter.open(extractedDirectory);
      try {
        runtime.reconcile(project);
      } finally {
        runtime.close();
      }
      const plan: ImportPlan = {
        id,
        projectId: project.manifest.id,
        projectTitle: project.manifest.title,
        projectRevision: project.manifest.revision,
        formatVersion: project.manifest.formatVersion,
        compressedBytes: packageStats.size,
        expandedBytes,
        entryCount: archiveFiles.length,
        assetCount: project.assets.length,
        missingAssets: managedFiles.missingAssets,
        warnings: managedFiles.warnings,
        suggestedDirectoryName: slug(project.manifest.title)
      };
      this.imports.set(id, { plan, stagingDirectory, extractedDirectory });
      return plan;
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      if (signal?.aborted) throw new ProjectPackageError("cancelled", "Package import was cancelled");
      if (error instanceof ProjectPackageError) throw error;
      if (error instanceof Error && /unsafe filename/iu.test(error.message)) {
        throw new ProjectPackageError("unsafe-path", error.message);
      }
      throw new ProjectPackageError("invalid-archive", error instanceof Error ? error.message : "Package is invalid");
    } finally {
      await reader.close().catch(() => undefined);
    }
  }

  async commitImport(planId: string, directoryName?: string): Promise<{ plan: ImportPlan; projectDirectory: string }> {
    const staged = this.imports.get(planId);
    if (!staged) throw new ProjectPackageError("plan-not-found", "Import plan was not found or has expired");
    const name = safeDirectoryName(directoryName ?? staged.plan.suggestedDirectoryName);
    const destination = path.resolve(this.projectsDirectory, name);
    const relative = path.relative(this.projectsDirectory, destination);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new ProjectPackageError("unsafe-destination", "Import destination escapes the Projects directory");
    }
    try {
      await lstat(destination);
      throw new ProjectPackageError("destination-exists", "Import destination already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(this.projectsDirectory, { recursive: true });
    await rename(staged.extractedDirectory, destination);
    await rm(staged.stagingDirectory, { recursive: true, force: true });
    this.imports.delete(planId);
    return { plan: staged.plan, projectDirectory: destination };
  }

  async cancelImport(planId: string): Promise<void> {
    const staged = this.imports.get(planId);
    if (!staged) return;
    this.imports.delete(planId);
    await rm(staged.stagingDirectory, { recursive: true, force: true });
  }

  async dispose(): Promise<void> {
    const staged = [...this.imports.values()];
    this.imports.clear();
    await Promise.all(staged.map(({ stagingDirectory }) => rm(stagingDirectory, { recursive: true, force: true })));
  }
}

export async function removePackageFile(filePath: string): Promise<void> {
  await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
