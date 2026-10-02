import { DomainError } from "./errors.js";
import type { CanonicalProject, EntityId } from "./types.js";

function assertReference(condition: boolean, path: string, message: string): asserts condition {
  if (!condition) throw new DomainError("invalid-reference", message, { path });
}

function assertUniqueIds(name: string, records: { id: EntityId }[]): void {
  const ids = new Set<EntityId>();
  for (const record of records) {
    if (ids.has(record.id)) {
      throw new DomainError("duplicate-id", `Duplicate ${name} ID ${record.id}`, {
        path: `/${name}/${record.id}`
      });
    }
    ids.add(record.id);
  }
}

export function assertLogicalProjectPath(value: string, path: string): void {
  const parts = value.split("/");
  const unsafe =
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    parts.some((part) => part === "" || part === "." || part === "..");
  if (unsafe) throw new DomainError("invalid-command", "Path must be a normalized Project-relative path", { path });
}

export function assertDomainInvariants(project: CanonicalProject): void {
  assertUniqueIds("topics", project.topics);
  assertUniqueIds("keyIssues", project.keyIssues);
  assertUniqueIds("relationships", project.relationships);
  assertUniqueIds("knowledgeItems", project.knowledgeItems);
  assertUniqueIds("associations", project.associations);
  assertUniqueIds("assets", project.assets);
  assertUniqueIds("collections", project.collections);
  assertUniqueIds("snapshots", project.snapshots);

  const topics = new Set(project.topics.map(({ id }) => id));
  const keyIssues = new Map(project.keyIssues.map((issue) => [issue.id, issue]));
  const knowledgeItems = new Set(project.knowledgeItems.map(({ id }) => id));
  const assets = new Set(project.assets.map(({ id }) => id));
  const collections = new Set(project.collections.map(({ id }) => id));
  const snapshots = new Set(project.snapshots.map(({ id }) => id));

  if (project.manifest.homeTopicId) {
    assertReference(topics.has(project.manifest.homeTopicId), "/manifest/homeTopicId", "Home Topic does not exist");
  }
  if (project.manifest.themeId) {
    assertReference(project.theme?.id === project.manifest.themeId, "/manifest/themeId", "Theme does not exist");
  }
  if (project.manifest.publishedSnapshotId) {
    assertReference(
      snapshots.has(project.manifest.publishedSnapshotId),
      "/manifest/publishedSnapshotId",
      "Published Snapshot does not exist"
    );
  }

  for (const topic of project.topics) {
    if (topic.visualAssetId) {
      assertReference(assets.has(topic.visualAssetId), `/topics/${topic.id}/visualAssetId`, "Visual Asset does not exist");
    }
  }

  for (const issue of project.keyIssues) {
    assertReference(topics.has(issue.topicId), `/keyIssues/${issue.id}/topicId`, "Parent Topic does not exist");
    if (issue.visualAssetId) {
      assertReference(assets.has(issue.visualAssetId), `/keyIssues/${issue.id}/visualAssetId`, "Visual Asset does not exist");
    }
  }

  for (const relationship of project.relationships) {
    const issue = keyIssues.get(relationship.keyIssueId);
    assertReference(
      topics.has(relationship.sourceTopicId),
      `/relationships/${relationship.id}/sourceTopicId`,
      "Source Topic does not exist"
    );
    assertReference(
      topics.has(relationship.targetTopicId),
      `/relationships/${relationship.id}/targetTopicId`,
      "Target Topic does not exist"
    );
    assertReference(Boolean(issue), `/relationships/${relationship.id}/keyIssueId`, "Key Issue does not exist");
    assertReference(
      issue?.topicId === relationship.sourceTopicId,
      `/relationships/${relationship.id}/keyIssueId`,
      "Key Issue must belong to the source Topic"
    );
  }

  for (const item of project.knowledgeItems) {
    if (item.availability === "external") {
      const valid = (() => {
        try {
          const url = new URL(item.externalUrl ?? "");
          return url.protocol === "https:" || url.protocol === "http:";
        } catch {
          return false;
        }
      })();
      if (!valid) {
        throw new DomainError("invalid-command", "External Knowledge Item requires an HTTP(S) URL", {
          path: `/knowledgeItems/${item.id}/externalUrl`
        });
      }
    }
    if (item.contentPath) assertLogicalProjectPath(item.contentPath, `/knowledgeItems/${item.id}/contentPath`);
    for (const assetId of item.attachmentAssetIds ?? []) {
      assertReference(assets.has(assetId), `/knowledgeItems/${item.id}/attachmentAssetIds`, `Asset ${assetId} does not exist`);
    }
  }

  for (const association of project.associations) {
    assertReference(
      knowledgeItems.has(association.knowledgeItemId),
      `/associations/${association.id}/knowledgeItemId`,
      "Knowledge Item does not exist"
    );
    const targetExists =
      association.targetKind === "topic" ? topics.has(association.targetId) : keyIssues.has(association.targetId);
    assertReference(targetExists, `/associations/${association.id}/targetId`, "Association target does not exist");
    for (const collectionId of association.collectionIds ?? []) {
      assertReference(
        collections.has(collectionId),
        `/associations/${association.id}/collectionIds`,
        `Collection ${collectionId} does not exist`
      );
    }
  }

  for (const asset of project.assets) assertLogicalProjectPath(asset.path, `/assets/${asset.id}/path`);
  for (const snapshot of project.snapshots) {
    assertLogicalProjectPath(snapshot.manifestPath, `/snapshots/${snapshot.id}/manifestPath`);
    for (const assetId of snapshot.assetIds) {
      assertReference(assets.has(assetId), `/snapshots/${snapshot.id}/assetIds`, `Asset ${assetId} does not exist`);
    }
  }
}
