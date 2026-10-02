import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "../domain/errors.js";
import type { ProjectRepository } from "../domain/repository.js";
import type { CanonicalProject, EntityId, PublishedSnapshot } from "../domain/types.js";
import { resolveProjectPath } from "./paths.js";
import { serializeCanonicalJson } from "./serialization.js";
import { assertValidProject } from "./validation.js";

export interface PublishedSnapshotManifest {
  format: "outmapper-published-snapshot";
  formatVersion: 1;
  snapshot: PublishedSnapshot;
  project: CanonicalProject;
}

export interface SnapshotManifestStore {
  write(manifestPath: string, manifest: PublishedSnapshotManifest): Promise<void>;
  remove(manifestPath: string): Promise<void>;
}

export class FileSystemSnapshotManifestStore implements SnapshotManifestStore {
  readonly projectDirectory: string;

  constructor(projectDirectory: string) {
    this.projectDirectory = path.resolve(projectDirectory);
  }

  async write(manifestPath: string, manifest: PublishedSnapshotManifest): Promise<void> {
    const target = resolveProjectPath(this.projectDirectory, manifestPath);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp`;
    await writeFile(temporary, serializeCanonicalJson(manifest), "utf8");
    await rename(temporary, target);
  }

  async remove(manifestPath: string): Promise<void> {
    const target = resolveProjectPath(this.projectDirectory, manifestPath);
    await rm(path.dirname(target), { recursive: true, force: true });
  }
}

export class PublicationService {
  readonly repository: ProjectRepository;
  readonly snapshotStore: SnapshotManifestStore;
  readonly createId: () => EntityId;
  readonly now: () => string;
  readonly retainedPrevious: number;

  constructor(
    repository: ProjectRepository,
    snapshotStore: SnapshotManifestStore,
    options: {
      createId?: () => EntityId;
      now?: () => string;
      retainedPrevious?: number;
    } = {}
  ) {
    this.repository = repository;
    this.snapshotStore = snapshotStore;
    this.createId = options.createId ?? (() => globalThis.crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.retainedPrevious = options.retainedPrevious ?? 10;
  }

  async publish(input: { title?: string; note?: string } = {}): Promise<{
    project: CanonicalProject;
    snapshot: PublishedSnapshot;
  }> {
    const current = await this.repository.load();
    assertValidProject(current);
    if (current.topics.length === 0 || !current.manifest.homeTopicId) {
      throw new DomainError("invalid-command", "A home Topic is required before publishing", {
        path: "/manifest/homeTopicId"
      });
    }

    const snapshot: PublishedSnapshot = {
      id: this.createId(),
      revision: current.manifest.revision,
      publishedAt: this.now(),
      manifestPath: "",
      assetIds: [...new Set(current.assets.map(({ id }) => id))].sort(),
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(input.note?.trim() ? { note: input.note.trim() } : {})
    };
    snapshot.manifestPath = `snapshots/${snapshot.id}/manifest.json`;
    const snapshotManifest: PublishedSnapshotManifest = {
      format: "outmapper-published-snapshot",
      formatVersion: 1,
      snapshot: structuredClone(snapshot),
      project: structuredClone(current)
    };

    const next = structuredClone(current);
    next.snapshots.push(snapshot);
    const keepCount = this.retainedPrevious + 1;
    const removed = next.snapshots.length > keepCount ? next.snapshots.splice(0, next.snapshots.length - keepCount) : [];
    next.manifest.publishedSnapshotId = snapshot.id;
    next.manifest.revision = current.manifest.revision + 1;
    next.manifest.updatedAt = snapshot.publishedAt;
    assertValidProject(next);

    await this.snapshotStore.write(snapshot.manifestPath, snapshotManifest);
    try {
      await this.repository.save(next);
    } catch (error) {
      await this.snapshotStore.remove(snapshot.manifestPath).catch(() => undefined);
      throw error;
    }
    await Promise.allSettled(removed.map(({ manifestPath }) => this.snapshotStore.remove(manifestPath)));
    return { project: next, snapshot };
  }
}
