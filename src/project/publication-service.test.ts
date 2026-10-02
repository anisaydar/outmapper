import type { ProjectRepository } from "../domain/repository.js";
import type { CanonicalProject } from "../domain/types.js";
import { createValidProject } from "../test/project-fixtures.js";
import {
  PublicationService,
  type PublishedSnapshotManifest,
  type SnapshotManifestStore
} from "./publication-service.js";

class MemoryRepository implements ProjectRepository {
  project: CanonicalProject;
  failSave = false;

  constructor(project = createValidProject()) {
    this.project = structuredClone(project);
  }

  async load(): Promise<CanonicalProject> {
    return structuredClone(this.project);
  }

  async save(project: CanonicalProject): Promise<void> {
    if (this.failSave) throw new Error("save failed");
    this.project = structuredClone(project);
  }
}

class MemorySnapshotStore implements SnapshotManifestStore {
  manifests = new Map<string, PublishedSnapshotManifest>();

  async write(path: string, manifest: PublishedSnapshotManifest): Promise<void> {
    this.manifests.set(path, structuredClone(manifest));
  }

  async remove(path: string): Promise<void> {
    this.manifests.delete(path);
  }
}

function createPublicationService(repository: MemoryRepository, snapshots: MemorySnapshotStore) {
  let sequence = 0;
  return new PublicationService(repository, snapshots, {
    createId: () => `snapshot-${++sequence}`,
    now: () => `2026-10-${String(sequence + 1).padStart(2, "0")}T00:00:00.000Z`
  });
}

describe("publication snapshots", () => {
  it("records an immutable working revision and references assets without copying bytes", async () => {
    const project = createValidProject();
    project.assets.push({
      id: "asset-large",
      path: "assets/large.bin",
      originalFilename: "large.bin",
      mimeType: "application/octet-stream",
      byteSize: 9_000_000_000,
      sha256: "a".repeat(64),
      createdAt: "2026-09-30T00:00:00.000Z"
    });
    const repository = new MemoryRepository(project);
    const snapshots = new MemorySnapshotStore();
    const service = createPublicationService(repository, snapshots);

    const result = await service.publish();
    const manifest = snapshots.manifests.get(result.snapshot.manifestPath);

    expect(result.snapshot.revision).toBe(0);
    expect(result.snapshot.assetIds).toEqual(["asset-large"]);
    expect(manifest?.project.assets[0]).toMatchObject({ id: "asset-large", byteSize: 9_000_000_000 });
    expect(manifest?.project.assets[0]).not.toHaveProperty("bytes");
    expect(repository.project.manifest.publishedSnapshotId).toBe(result.snapshot.id);
  });

  it("retains the current snapshot and ten previous snapshots deterministically", async () => {
    const repository = new MemoryRepository();
    const snapshots = new MemorySnapshotStore();
    const service = createPublicationService(repository, snapshots);

    for (let index = 0; index < 12; index += 1) await service.publish();

    expect(repository.project.snapshots.map(({ id }) => id)).toEqual([
      "snapshot-2",
      "snapshot-3",
      "snapshot-4",
      "snapshot-5",
      "snapshot-6",
      "snapshot-7",
      "snapshot-8",
      "snapshot-9",
      "snapshot-10",
      "snapshot-11",
      "snapshot-12"
    ]);
    expect(snapshots.manifests).toHaveLength(11);
  });

  it("preserves prior publication state when publishing fails", async () => {
    const repository = new MemoryRepository();
    const snapshots = new MemorySnapshotStore();
    const service = createPublicationService(repository, snapshots);
    await service.publish();
    const publishedSnapshotId = repository.project.manifest.publishedSnapshotId;
    const snapshotCount = repository.project.snapshots.length;
    repository.failSave = true;

    await expect(service.publish()).rejects.toThrow("save failed");

    expect(repository.project.manifest.publishedSnapshotId).toBe(publishedSnapshotId);
    expect(repository.project.snapshots).toHaveLength(snapshotCount);
    expect(snapshots.manifests).toHaveLength(1);
  });
});
