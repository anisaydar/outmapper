import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
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
  TopicRelationship,
  ProjectLink
} from "../domain/types.js";
import type { ProjectRepository } from "../domain/repository.js";
import { DomainError } from "../domain/errors.js";
import { migrateProjectData } from "./migrations.js";
import { resolveProjectPath } from "./paths.js";
import { serializeCanonicalJson } from "./serialization.js";
import { assertValidProject } from "./validation.js";

export const CANONICAL_PROJECT_FILES = {
  manifest: "project.json",
  topics: "data/topics/records.json",
  keyIssues: "data/issues/records.json",
  relationships: "data/relationships/records.json",
  projectLinks: "data/project-links/records.json",
  knowledgeItems: "data/knowledge/records.json",
  associations: "data/associations/records.json",
  assets: "data/assets/records.json",
  collections: "data/collections/records.json",
  theme: "theme/theme.json",
  snapshots: "snapshots/records.json"
} as const;

const files = CANONICAL_PROJECT_FILES;

const recoveryCheckpoint = ".outmapper/runtime/canonical-recovery.json";

/** Writes in flight in this process, by folder, so a read in this process waits for one instead of reading it half-way. */
const pendingWrites = new Map<string, Promise<void>>();

/** One key per folder however it was spelled: resolved, and case-folded on Windows, whose paths ignore case. */
export function pendingWriteKey(projectDirectory: string): string {
  const resolved = path.resolve(projectDirectory);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

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
  projectLinks?: ProjectLink[];
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
      projectLinks: input.projectLinks ?? [],
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

  /**
   * Reads the Project, finishing a checkpointed write first if one was interrupted. A plain read takes no write lock,
   * so it never collides with a save or with another read of the same folder (such as a Project switch while a
   * request is still in flight); only recovery, which writes, locks the folder.
   */
  async open(): Promise<CanonicalProject> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // A save in this process is never read half-way; one in another process shows up as a fingerprint change.
      await pendingWrites.get(pendingWriteKey(this.projectDirectory));
      if (await this.hasRecoveryCheckpoint()) break;
      const snapshot = await this.readCanonicalSnapshot();
      if (snapshot.fingerprint !== await this.diskFingerprint()) continue;
      // A writer in another process checkpoints before it touches the canonical files and removes the checkpoint
      // only after all of them are written; one paused part-way leaves stable but mixed files, which recovery finishes.
      if (await this.hasRecoveryCheckpoint()) break;
      this.fingerprint = snapshot.fingerprint;
      return snapshot.project;
    }
    return this.withWriteLock(async () => {
      await this.recoverPendingWrite();
      const { project } = await this.readCanonicalSnapshot();
      this.fingerprint = await this.diskFingerprint();
      return project;
    });
  }

  private async hasRecoveryCheckpoint(): Promise<boolean> {
    try {
      await stat(resolveProjectPath(this.projectDirectory, recoveryCheckpoint));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  /** Reads every canonical file once; the fingerprint is of exactly the bytes that were parsed. */
  private async readCanonicalSnapshot(): Promise<{ project: CanonicalProject; fingerprint: string }> {
    const contents = await Promise.all(Object.values(files).map(async (logicalPath) => {
      try { return await readFile(resolveProjectPath(this.projectDirectory, logicalPath)); }
      catch (error) {
        if ((logicalPath === files.theme || logicalPath === files.projectLinks) && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }));
    const hash = createHash("sha256");
    for (const content of contents) if (content) hash.update(content);
    const raw = new Map<string, Buffer | undefined>(Object.values(files).map((logicalPath, index) => [logicalPath, contents[index]]));
    const parse = (logicalPath: string): unknown => {
      try {
        return JSON.parse(raw.get(logicalPath)!.toString("utf8")) as unknown;
      } catch {
        throw new Error(`${logicalPath} contains invalid JSON`);
      }
    };
    const manifest = parse(files.manifest);
    const sourceVersion = (manifest as { formatVersion?: unknown }).formatVersion;
    // Only format 1 Projects may lack link records; for any other, reading again surfaces the missing-file error.
    if (!raw.get(files.projectLinks) && sourceVersion !== 1) await readFile(resolveProjectPath(this.projectDirectory, files.projectLinks));
    const projectLinks = raw.get(files.projectLinks) ? parse(files.projectLinks) : [];
    const [topics, keyIssues, relationships, knowledgeItems, associations, assets, collections, snapshots] = [
      files.topics, files.keyIssues, files.relationships, files.knowledgeItems, files.associations, files.assets, files.collections, files.snapshots
    ].map(parse);
    const theme = raw.get(files.theme) ? parse(files.theme) : undefined;

    const rawProject = {
      manifest,
      topics,
      keyIssues,
      relationships,
      projectLinks,
      knowledgeItems,
      associations,
      assets,
      collections,
      ...(theme ? { theme } : {}),
      snapshots
    };
    const migrated = migrateProjectData(rawProject);
    assertValidProject(migrated);
    return { project: migrated, fingerprint: hash.digest("hex") };
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

  async getDiskFingerprint(): Promise<string> {
    return this.diskFingerprint();
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
        if ((logicalPath !== files.theme && logicalPath !== files.projectLinks) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return hash.digest("hex");
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = pendingWriteKey(this.projectDirectory);
    const write = this.withFileLock(operation);
    const settled = write.then(() => undefined, () => undefined);
    pendingWrites.set(key, settled);
    void settled.then(() => { if (pendingWrites.get(key) === settled) pendingWrites.delete(key); });
    return write;
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
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
        return this.withFileLock(operation);
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
      writeJson(this.projectDirectory, files.projectLinks, project.projectLinks),
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
