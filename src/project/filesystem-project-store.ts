import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Asset,
  CanonicalProject,
  Collection,
  KeyIssue,
  KnowledgeAssociation,
  KnowledgeItem,
  ProjectManifest,
  PublishedSnapshot,
  Theme,
  Topic,
  TopicRelationship
} from "../domain/types.js";
import type { ProjectRepository } from "../domain/repository.js";
import { DomainError } from "../domain/errors.js";
import { CURRENT_FORMAT_VERSION, migrateProjectData } from "./migrations.js";
import { resolveProjectPath } from "./paths.js";
import { serializeCanonicalJson } from "./serialization.js";
import { assertValidProject } from "./validation.js";

const files = {
  manifest: "project.json",
  topics: "data/topics/records.json",
  keyIssues: "data/issues/records.json",
  relationships: "data/relationships/records.json",
  knowledgeItems: "data/knowledge/records.json",
  associations: "data/associations/records.json",
  assets: "data/assets/records.json",
  collections: "data/collections/records.json",
  theme: "theme/theme.json",
  snapshots: "snapshots/records.json"
} as const;

const recoveryCheckpoint = ".outmapper/runtime/canonical-recovery.json";

async function readJson(projectDirectory: string, logicalPath: string): Promise<unknown> {
  const content = await readFile(resolveProjectPath(projectDirectory, logicalPath), "utf8");
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error(`${logicalPath} contains invalid JSON`);
  }
}

async function writeJson(projectDirectory: string, logicalPath: string, value: unknown): Promise<void> {
  const target = resolveProjectPath(projectDirectory, logicalPath);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, serializeCanonicalJson(value), "utf8");
  await rename(temporary, target);
}

export interface CreateProjectInput {
  manifest: ProjectManifest;
  topics?: Topic[];
  keyIssues?: KeyIssue[];
  relationships?: TopicRelationship[];
  knowledgeItems?: KnowledgeItem[];
  associations?: KnowledgeAssociation[];
  assets?: Asset[];
  collections?: Collection[];
  theme?: Theme;
  snapshots?: PublishedSnapshot[];
}

export class FileSystemProjectStore implements ProjectRepository {
  readonly projectDirectory: string;
  private fingerprint?: string;

  constructor(projectDirectory: string) {
    this.projectDirectory = path.resolve(projectDirectory);
  }

  async create(input: CreateProjectInput): Promise<CanonicalProject> {
    const project: CanonicalProject = {
      manifest: input.manifest,
      topics: input.topics ?? [],
      keyIssues: input.keyIssues ?? [],
      relationships: input.relationships ?? [],
      knowledgeItems: input.knowledgeItems ?? [],
      associations: input.associations ?? [],
      assets: input.assets ?? [],
      collections: input.collections ?? [],
      ...(input.theme ? { theme: input.theme } : {}),
      snapshots: input.snapshots ?? []
    };
    assertValidProject(project);
    try {
      const entries = await readdir(this.projectDirectory);
      if (entries.length > 0) throw new Error("Project directory is not empty");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(this.projectDirectory, { recursive: true });
    await this.save(project);
    return project;
  }

  async open(): Promise<CanonicalProject> {
    return this.withWriteLock(async () => {
      await this.recoverPendingWrite();
      const project = await this.readCanonicalProject();
      this.fingerprint = await this.diskFingerprint();
      return project;
    });
  }

  private async readCanonicalProject(): Promise<CanonicalProject> {
    const [manifest, topics, keyIssues, relationships, knowledgeItems, associations, assets, collections, snapshots] =
      await Promise.all([
        readJson(this.projectDirectory, files.manifest),
        readJson(this.projectDirectory, files.topics),
        readJson(this.projectDirectory, files.keyIssues),
        readJson(this.projectDirectory, files.relationships),
        readJson(this.projectDirectory, files.knowledgeItems),
        readJson(this.projectDirectory, files.associations),
        readJson(this.projectDirectory, files.assets),
        readJson(this.projectDirectory, files.collections),
        readJson(this.projectDirectory, files.snapshots)
      ]);

    let theme: unknown;
    try {
      theme = await readJson(this.projectDirectory, files.theme);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const rawProject = {
      manifest,
      topics,
      keyIssues,
      relationships,
      knowledgeItems,
      associations,
      assets,
      collections,
      ...(theme ? { theme } : {}),
      snapshots
    };
    const sourceVersion = (manifest as { formatVersion?: unknown }).formatVersion;
    if (Number.isInteger(sourceVersion) && (sourceVersion as number) < CURRENT_FORMAT_VERSION) {
      await this.backupBeforeMigration(rawProject, sourceVersion as number);
    }
    const migrated = migrateProjectData(rawProject);
    assertValidProject(migrated);
    if (Number.isInteger(sourceVersion) && (sourceVersion as number) < CURRENT_FORMAT_VERSION) {
      await this.saveUnlocked(migrated);
    }
    return migrated;
  }

  private async backupBeforeMigration(rawProject: unknown, sourceVersion: number): Promise<void> {
    const digest = createHash("sha256").update(serializeCanonicalJson(rawProject)).digest("hex").slice(0, 16);
    const backupRoot = resolveProjectPath(this.projectDirectory, ".outmapper/migration-backups");
    const target = path.join(backupRoot, `v${sourceVersion}-${digest}`);
    try {
      await readdir(target);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const runtime = resolveProjectPath(this.projectDirectory, ".outmapper/runtime");
    await mkdir(runtime, { recursive: true });
    await mkdir(backupRoot, { recursive: true });
    const staging = await mkdtemp(path.join(runtime, "migration-backup-"));
    try {
      for (const logicalPath of Object.values(files)) {
        try {
          const destination = path.join(staging, ...logicalPath.split("/"));
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(resolveProjectPath(this.projectDirectory, logicalPath), destination);
        } catch (error) {
          if (logicalPath === files.theme && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      try {
        await rename(staging, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async load(): Promise<CanonicalProject> {
    return this.open();
  }

  async save(project: CanonicalProject): Promise<void> {
    return this.withWriteLock(async () => {
      if (this.fingerprint !== undefined && this.fingerprint !== await this.diskFingerprint()) {
        throw new DomainError("conflicting-save", "Project changed on disk. Reopen the Project before saving.");
      }
      await this.saveUnlocked(project);
      this.fingerprint = await this.diskFingerprint();
    });
  }

  private async saveUnlocked(project: CanonicalProject): Promise<void> {
    assertValidProject(project);
    await writeJson(this.projectDirectory, recoveryCheckpoint, project);
    await this.writeCanonicalFiles(project);
    await unlink(resolveProjectPath(this.projectDirectory, recoveryCheckpoint));
  }

  private async diskFingerprint(): Promise<string> {
    const hash = createHash("sha256");
    for (const logicalPath of Object.values(files)) {
      try { hash.update(await readFile(resolveProjectPath(this.projectDirectory, logicalPath))); }
      catch (error) {
        if (logicalPath !== files.theme || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return hash.digest("hex");
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = resolveProjectPath(this.projectDirectory, ".outmapper/runtime/write.lock");
    await mkdir(path.dirname(lock), { recursive: true });
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(await readFile(lock, "utf8"));
      let stale = !owner && Date.now() - (await stat(lock)).mtimeMs > 30_000;
      if (owner) {
        try { process.kill(owner, 0); }
        catch (failure) { stale = (failure as NodeJS.ErrnoException).code === "ESRCH"; }
      }
      if (stale) {
        await unlink(lock);
        return this.withWriteLock(operation);
      }
      throw new DomainError("conflicting-save", "Another process is saving this Project. Try again after it finishes.");
    }
    try { return await operation(); }
    finally { await unlink(lock); }
  }

  private async writeCanonicalFiles(project: CanonicalProject): Promise<void> {
    await Promise.all([
      writeJson(this.projectDirectory, files.manifest, project.manifest),
      writeJson(this.projectDirectory, files.topics, project.topics),
      writeJson(this.projectDirectory, files.keyIssues, project.keyIssues),
      writeJson(this.projectDirectory, files.relationships, project.relationships),
      writeJson(this.projectDirectory, files.knowledgeItems, project.knowledgeItems),
      writeJson(this.projectDirectory, files.associations, project.associations),
      writeJson(this.projectDirectory, files.assets, project.assets),
      writeJson(this.projectDirectory, files.collections, project.collections),
      writeJson(this.projectDirectory, files.snapshots, project.snapshots),
      ...(project.theme ? [writeJson(this.projectDirectory, files.theme, project.theme)] : [])
    ]);
  }

  private async recoverPendingWrite(): Promise<void> {
    let checkpoint: unknown;
    try {
      checkpoint = await readJson(this.projectDirectory, recoveryCheckpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    assertValidProject(checkpoint);
    await this.writeCanonicalFiles(checkpoint);
    await unlink(resolveProjectPath(this.projectDirectory, recoveryCheckpoint));
  }
}
