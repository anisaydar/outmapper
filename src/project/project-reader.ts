import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { CanonicalProject } from "../domain/types.js";
import type { ProjectFingerprint, WorkspaceProjectStatus } from "../domain/workspace.js";
import { migrateProjectData } from "./migrations.js";
import { resolveProjectPath } from "./paths.js";
import { assertValidProject } from "./validation.js";
import { CANONICAL_PROJECT_FILES } from "./filesystem-project-store.js";

const recoveryCheckpoint = ".outmapper/runtime/canonical-recovery.json";

async function readJson(projectDirectory: string, logicalPath: string): Promise<unknown> {
  const content = await readFile(resolveProjectPath(projectDirectory, logicalPath), "utf8");
  return JSON.parse(content) as unknown;
}

async function fileFingerprint(filePath: string): Promise<{ size: number; mtimeMs: number }> {
  const details = await stat(filePath);
  if (!details.isFile()) throw new Error(`${filePath} is not a regular file`);
  return { size: details.size, mtimeMs: details.mtimeMs };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface ProjectProbe {
  status: Exclude<WorkspaceProjectStatus, "duplicate">;
  fingerprint?: ProjectFingerprint;
}

export interface ProjectReadResult extends ProjectProbe {
  project?: CanonicalProject;
  actualProjectId?: string;
  status: Exclude<WorkspaceProjectStatus, "duplicate">;
}

/** Reads canonical Project data without taking a write lock, recovering a write, or creating runtime files. */
export class ProjectReader {
  async probe(projectDirectory: string): Promise<ProjectProbe> {
    const directory = path.resolve(projectDirectory);
    try {
      const manifest = await fileFingerprint(resolveProjectPath(directory, CANONICAL_PROJECT_FILES.manifest));
      let projectLinks = null;
      try {
        projectLinks = await fileFingerprint(resolveProjectPath(directory, CANONICAL_PROJECT_FILES.projectLinks));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const fingerprint = { manifest, projectLinks };
      if (await exists(resolveProjectPath(directory, recoveryCheckpoint))) return { status: "needs-open", fingerprint };
      return { status: "available", fingerprint };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "unreadable" };
    }
  }

  async read(projectDirectory: string, expectedProjectId?: string): Promise<ProjectReadResult> {
    const directory = path.resolve(projectDirectory);
    const probe = await this.probe(directory);
    if (probe.status !== "available") return probe;
    try {
      const manifest = await readJson(directory, CANONICAL_PROJECT_FILES.manifest);
      const sourceVersion = (manifest as { formatVersion?: unknown }).formatVersion;
      const projectLinks = await readJson(directory, CANONICAL_PROJECT_FILES.projectLinks).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && sourceVersion === 1) return [];
        throw error;
      });
      const [topics, keyIssues, relationships, knowledgeItems, associations, assets, collections, snapshots] = await Promise.all([
        readJson(directory, CANONICAL_PROJECT_FILES.topics),
        readJson(directory, CANONICAL_PROJECT_FILES.keyIssues),
        readJson(directory, CANONICAL_PROJECT_FILES.relationships),
        readJson(directory, CANONICAL_PROJECT_FILES.knowledgeItems),
        readJson(directory, CANONICAL_PROJECT_FILES.associations),
        readJson(directory, CANONICAL_PROJECT_FILES.assets),
        readJson(directory, CANONICAL_PROJECT_FILES.collections),
        readJson(directory, CANONICAL_PROJECT_FILES.snapshots)
      ]);
      let theme: unknown;
      try {
        theme = await readJson(directory, CANONICAL_PROJECT_FILES.theme);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const migrated = migrateProjectData({
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
      });
      assertValidProject(migrated);
      if (expectedProjectId && migrated.manifest.id !== expectedProjectId) {
        return { status: "mismatch", fingerprint: probe.fingerprint, actualProjectId: migrated.manifest.id };
      }
      return { status: "available", fingerprint: probe.fingerprint, project: migrated };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", fingerprint: probe.fingerprint };
      return { status: "unreadable", fingerprint: probe.fingerprint };
    }
  }

  async topics(projectDirectory: string, expectedProjectId?: string): Promise<CanonicalProject["topics"]> {
    const result = await this.read(projectDirectory, expectedProjectId);
    if (result.status !== "available" || !result.project) throw new Error(`Project is ${result.status}`);
    return result.project.topics;
  }
}
