import type { ProjectRepository } from "./repository.js";
import { ProjectService } from "./project-service.js";
import type { CanonicalProject } from "./types.js";
import { createValidProject, timestamp } from "../test/project-fixtures.js";

class MemoryProjectRepository implements ProjectRepository {
  project: CanonicalProject;

  constructor(project = createValidProject()) {
    this.project = structuredClone(project);
  }

  async load(): Promise<CanonicalProject> {
    return structuredClone(this.project);
  }

  async save(project: CanonicalProject): Promise<void> {
    this.project = structuredClone(project);
  }
}

function createService(repository = new MemoryProjectRepository()) {
  let sequence = 0;
  return {
    repository,
    service: new ProjectService(repository, {
      createId: () => `generated-${++sequence}`,
      now: () => "2026-10-01T00:00:00.000Z"
    })
  };
}

describe("domain commands", () => {
  it("allows cycles and multiple Key Issues to connect one Related Topic", async () => {
    const { repository, service } = createService();
    const secondIssue = await service.createKeyIssue({ topicId: "topic-1", title: "Second Issue" });
    await service.connectTopics({
      sourceTopicId: "topic-1",
      keyIssueId: secondIssue.id,
      targetTopicId: "topic-2"
    });
    const reverseIssue = await service.createKeyIssue({ topicId: "topic-2", title: "Reverse Issue" });
    await service.connectTopics({
      sourceTopicId: "topic-2",
      keyIssueId: reverseIssue.id,
      targetTopicId: "topic-1"
    });

    expect(repository.project.relationships.filter(({ targetTopicId }) => targetTopicId === "topic-2")).toHaveLength(2);
    expect(repository.project.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceTopicId: "topic-1", targetTopicId: "topic-2" }),
        expect.objectContaining({ sourceTopicId: "topic-2", targetTopicId: "topic-1" })
      ])
    );
    expect(repository.project.manifest.revision).toBe(4);
  });

  it("enforces the Key Issue parent invariant", async () => {
    const { repository, service } = createService();

    await expect(
      service.connectTopics({
        sourceTopicId: "topic-2",
        keyIssueId: "issue-1",
        targetTopicId: "topic-1"
      })
    ).rejects.toMatchObject({ code: "invalid-reference" });
    expect(repository.project.manifest.revision).toBe(0);
  });

  it("creates and updates Knowledge, assets, collections, theme, and publication metadata", async () => {
    const { repository, service } = createService();
    const asset = await service.addAsset({
      path: "assets/report.pdf",
      originalFilename: "report.pdf",
      mimeType: "application/pdf",
      byteSize: 12,
      sha256: "a".repeat(64)
    });
    await service.updateAssetMetadata(asset.id, { originalFilename: "evaluation-report.pdf" });
    const collection = await service.createCollection({ title: "Research" });
    const item = await service.createKnowledgeItem({
      type: "pdf",
      title: "Evaluation report",
      availability: "local",
      attachmentAssetIds: [asset.id]
    });
    const association = await service.associateKnowledge({
      knowledgeItemId: item.id,
      targetKind: "keyIssue",
      targetId: "issue-1",
      collectionIds: [collection.id]
    });
    await service.updateKnowledgeAssociation(association.id, { pinned: true });
    const theme = await service.setTheme({ name: "Research", tokens: { accent: "#4c9dff" } });
    const snapshot = await service.recordPublishedSnapshot({
      manifestPath: "snapshots/revision-7/manifest.json",
      assetIds: [asset.id]
    });

    expect(repository.project.associations[0]).toMatchObject({ pinned: true, targetId: "issue-1" });
    expect(repository.project.theme).toEqual(theme);
    expect(repository.project.manifest.publishedSnapshotId).toBe(snapshot.id);
    expect(snapshot.assetIds).toEqual([asset.id]);
  });

  it("edits a shared Knowledge item in one context without changing the other context", async () => {
    const project = createValidProject();
    project.knowledgeItems.push({ id: "knowledge-shared", type: "note", title: "Shared note", body: "Original", availability: "local", createdAt: timestamp, updatedAt: timestamp });
    project.associations.push(
      { id: "association-first", knowledgeItemId: "knowledge-shared", targetKind: "topic", targetId: "topic-1" },
      { id: "association-second", knowledgeItemId: "knowledge-shared", targetKind: "topic", targetId: "topic-2" }
    );
    const { repository, service } = createService(new MemoryProjectRepository(project));

    await service.editAssociatedKnowledge("association-first", { title: "Context note", body: "Changed" }, "context");

    const first = repository.project.associations.find(({ id }) => id === "association-first")!;
    const second = repository.project.associations.find(({ id }) => id === "association-second")!;
    expect(first.knowledgeItemId).not.toBe(second.knowledgeItemId);
    expect(repository.project.knowledgeItems.find(({ id }) => id === first.knowledgeItemId)).toMatchObject({ title: "Context note", body: "Changed" });
    expect(repository.project.knowledgeItems.find(({ id }) => id === second.knowledgeItemId)).toMatchObject({ title: "Shared note", body: "Original" });
  });

  it("removes shared Knowledge from one context or every context according to scope", async () => {
    const project = createValidProject();
    project.knowledgeItems.push({ id: "knowledge-shared", type: "note", title: "Shared note", availability: "local", createdAt: timestamp, updatedAt: timestamp });
    project.associations.push(
      { id: "association-first", knowledgeItemId: "knowledge-shared", targetKind: "topic", targetId: "topic-1" },
      { id: "association-second", knowledgeItemId: "knowledge-shared", targetKind: "topic", targetId: "topic-2" }
    );
    const { repository, service } = createService(new MemoryProjectRepository(project));

    await service.removeAssociatedKnowledge("association-first", "context");
    expect(repository.project.associations.map(({ id }) => id)).toEqual(["association-second"]);
    expect(repository.project.knowledgeItems.some(({ id }) => id === "knowledge-shared")).toBe(true);

    await service.removeAssociatedKnowledge("association-second", "all");
    expect(repository.project.associations).toEqual([]);
    expect(repository.project.knowledgeItems.some(({ id }) => id === "knowledge-shared")).toBe(false);
  });

  it("keeps published snapshots immutable by exposing no snapshot update command", () => {
    const { service } = createService();
    expect("updatePublishedSnapshot" in service).toBe(false);
  });

  it("reports dependent references before Topic or Key Issue deletion", async () => {
    const { service } = createService();

    const topicImpact = await service.getTopicDeletionImpact("topic-2");
    expect(topicImpact.relationshipIds).toEqual(["relationship-1"]);
    await expect(service.deleteTopic("topic-2")).rejects.toMatchObject({
      code: "dependent-references",
      references: ["relationship-1"]
    });

    const issueImpact = await service.getKeyIssueDeletionImpact("issue-1");
    expect(issueImpact.relationshipIds).toEqual(["relationship-1"]);
    await expect(service.deleteKeyIssue("issue-1")).rejects.toMatchObject({ code: "dependent-references" });
  });

  it("deletes an unreferenced Topic without cascading", async () => {
    const project = createValidProject();
    project.topics.push({ id: "topic-isolated", title: "Isolated", createdAt: timestamp, updatedAt: timestamp });
    const { repository, service } = createService(new MemoryProjectRepository(project));

    await service.deleteTopic("topic-isolated");

    expect(repository.project.topics.some(({ id }) => id === "topic-isolated")).toBe(false);
    expect(repository.project.relationships).toHaveLength(1);
  });

  it("removes Key Issue references only when explicitly requested and keeps Knowledge", async () => {
    const project = createValidProject();
    project.knowledgeItems.push({ id: "knowledge-1", type: "note", title: "Shared evidence", availability: "local", createdAt: timestamp, updatedAt: timestamp });
    project.associations.push(
      { id: "association-issue", knowledgeItemId: "knowledge-1", targetKind: "keyIssue", targetId: "issue-1" },
      { id: "association-topic", knowledgeItemId: "knowledge-1", targetKind: "topic", targetId: "topic-2" }
    );
    const { repository, service } = createService(new MemoryProjectRepository(project));

    await expect(service.deleteKeyIssue("issue-1")).rejects.toMatchObject({ code: "dependent-references" });
    await service.deleteKeyIssue("issue-1", { removeReferences: true });

    expect(repository.project.keyIssues).toEqual([]);
    expect(repository.project.relationships).toEqual([]);
    expect(repository.project.associations).toEqual([project.associations[1]]);
    expect(repository.project.knowledgeItems).toEqual(project.knowledgeItems);
    expect(repository.project.topics).toEqual(project.topics);
    expect(repository.project.manifest.revision).toBe(project.manifest.revision + 1);
  });

  it("explicitly deletes a home Topic with incoming and outgoing links in one revision", async () => {
    const project = createValidProject();
    project.keyIssues.push({ ...project.keyIssues[0], id: "issue-other", topicId: "topic-2" });
    project.relationships.push({ ...project.relationships[0], id: "relationship-incoming", sourceTopicId: "topic-2", keyIssueId: "issue-other", targetTopicId: "topic-1" });
    project.knowledgeItems.push({ id: "knowledge-1", type: "note", title: "Shared evidence", availability: "local", createdAt: timestamp, updatedAt: timestamp });
    project.associations.push(
      { id: "association-issue", knowledgeItemId: "knowledge-1", targetKind: "keyIssue", targetId: "issue-1" },
      { id: "association-home", knowledgeItemId: "knowledge-1", targetKind: "topic", targetId: "topic-1" },
      { id: "association-other", knowledgeItemId: "knowledge-1", targetKind: "topic", targetId: "topic-2" }
    );
    const { repository, service } = createService(new MemoryProjectRepository(project));

    await service.deleteTopic("topic-1", { removeReferences: true });

    expect(repository.project.topics).toEqual([project.topics[1]]);
    expect(repository.project.keyIssues).toEqual([project.keyIssues[1]]);
    expect(repository.project.relationships).toEqual([]);
    expect(repository.project.associations).toEqual([project.associations[2]]);
    expect(repository.project.knowledgeItems).toEqual(project.knowledgeItems);
    expect(repository.project.assets).toEqual(project.assets);
    expect(repository.project.manifest.homeTopicId).toBe("topic-2");
    expect(repository.project.manifest.revision).toBe(project.manifest.revision + 1);
  });

  it("clears the home reference when explicitly deleting the last Topic", async () => {
    const project = createValidProject();
    project.topics = [project.topics[0]];
    project.relationships = [];
    const { repository, service } = createService(new MemoryProjectRepository(project));

    await service.deleteTopic("topic-1", { removeReferences: true });

    expect(repository.project.topics).toEqual([]);
    expect(repository.project.keyIssues).toEqual([]);
    expect(repository.project.manifest.homeTopicId).toBeUndefined();
  });

  it("reorders authored Key Issues and relationships through domain commands", async () => {
    const project = createValidProject();
    project.keyIssues.push({
      id: "issue-2",
      topicId: "topic-1",
      title: "Second",
      order: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    project.relationships.push({
      id: "relationship-2",
      sourceTopicId: "topic-1",
      keyIssueId: "issue-1",
      targetTopicId: "topic-2",
      order: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const { repository, service } = createService(new MemoryProjectRepository(project));

    await service.reorderKeyIssues("topic-1", ["issue-2", "issue-1"]);
    await service.reorderRelationships("issue-1", ["relationship-2", "relationship-1"]);

    expect(repository.project.keyIssues.map(({ id, order }) => ({ id, order }))).toEqual([
      { id: "issue-1", order: 1 },
      { id: "issue-2", order: 0 }
    ]);
    expect(repository.project.relationships.map(({ id, order }) => ({ id, order }))).toEqual([
      { id: "relationship-1", order: 1 },
      { id: "relationship-2", order: 0 }
    ]);
  });

  it("keeps replacement Asset identity separate while preserving Published Snapshot references", async () => {
    const project = createValidProject();
    project.assets.push({
      id: "asset-original",
      path: "assets/asset-original/report.pdf",
      originalFilename: "report.pdf",
      mimeType: "application/pdf",
      byteSize: 10,
      sha256: "a".repeat(64),
      createdAt: timestamp
    });
    project.knowledgeItems.push({
      id: "knowledge-asset",
      type: "pdf",
      title: "Report",
      availability: "local",
      attachmentAssetIds: ["asset-original"],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    project.snapshots.push({
      id: "snapshot-asset",
      revision: 0,
      publishedAt: timestamp,
      manifestPath: "snapshots/snapshot-asset/manifest.json",
      assetIds: ["asset-original"]
    });
    const { repository, service } = createService(new MemoryProjectRepository(project));

    await service.replaceManagedAsset("asset-original", {
      id: "asset-replacement",
      path: "assets/asset-replacement/report.pdf",
      originalFilename: "report.pdf",
      mimeType: "application/pdf",
      byteSize: 12,
      sha256: "b".repeat(64),
      createdAt: "2026-10-01T00:00:00.000Z"
    });

    expect(repository.project.assets.map(({ id }) => id)).toEqual(["asset-original", "asset-replacement"]);
    expect(repository.project.knowledgeItems[0].attachmentAssetIds).toEqual(["asset-replacement"]);
    expect(repository.project.snapshots[0].assetIds).toEqual(["asset-original"]);
  });
});
