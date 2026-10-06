import { DomainError } from "./errors.js";
import { assertDomainInvariants } from "./invariants.js";
import type { ProjectRepository } from "./repository.js";
import type {
  Asset,
  CanonicalProject,
  Collection,
  EntityId,
  JsonObject,
  KeyIssue,
  KnowledgeAssociation,
  KnowledgeItem,
  PublishedSnapshot,
  ProjectLink,
  Theme,
  Topic,
  TopicRelationship
} from "./types.js";

export interface DomainDependencies {
  createId: () => EntityId;
  now: () => string;
}

export interface TopicDeletionImpact {
  keyIssueIds: EntityId[];
  relationshipIds: EntityId[];
  projectLinkIds: EntityId[];
  associationIds: EntityId[];
  isHomeTopic: boolean;
}

export interface KeyIssueDeletionImpact {
  relationshipIds: EntityId[];
  projectLinkIds: EntityId[];
  associationIds: EntityId[];
}

const defaultDependencies: DomainDependencies = {
  createId: () => globalThis.crypto.randomUUID(),
  now: () => new Date().toISOString()
};

function requireTitle(title: string, path: string): string {
  const value = title.trim();
  if (!value) throw new DomainError("invalid-command", "Title is required", { path });
  return value;
}

function requireRecord<T extends { id: EntityId }>(records: T[], id: EntityId, name: string): T {
  const record = records.find((candidate) => candidate.id === id);
  if (!record) throw new DomainError("not-found", `${name} ${id} does not exist`);
  return record;
}

export class ProjectService {
  readonly repository: ProjectRepository;
  readonly dependencies: DomainDependencies;

  constructor(repository: ProjectRepository, dependencies: Partial<DomainDependencies> = {}) {
    this.repository = repository;
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  private async mutate<T>(change: (project: CanonicalProject, timestamp: string) => T): Promise<T> {
    const current = await this.repository.load();
    const project = structuredClone(current);
    const timestamp = this.dependencies.now();
    const result = change(project, timestamp);
    assertDomainInvariants(project);
    project.manifest.revision = current.manifest.revision + 1;
    project.manifest.updatedAt = timestamp;
    await this.repository.save(project);
    return result;
  }

  async createTopic(input: {
    title: string;
    description?: string;
    tags?: string[];
    metadata?: JsonObject;
  }): Promise<Topic> {
    return this.mutate((project, timestamp) => {
      const topic: Topic = {
        id: this.dependencies.createId(),
        title: requireTitle(input.title, "/topic/title"),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.tags ? { tags: [...input.tags] } : {}),
        ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {}),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      project.topics.push(topic);
      if (!project.manifest.homeTopicId) project.manifest.homeTopicId = topic.id;
      return topic;
    });
  }

  async updateTopic(
    topicId: EntityId,
    patch: { title?: string; description?: string; tags?: string[]; visualAssetId?: EntityId | null }
  ): Promise<Topic> {
    return this.mutate((project, timestamp) => {
      const topic = requireRecord(project.topics, topicId, "Topic");
      if (patch.title !== undefined) topic.title = requireTitle(patch.title, `/topics/${topicId}/title`);
      if (patch.description !== undefined) topic.description = patch.description;
      if (patch.tags !== undefined) topic.tags = [...patch.tags];
      if (patch.visualAssetId === null) delete topic.visualAssetId;
      else if (patch.visualAssetId !== undefined) topic.visualAssetId = patch.visualAssetId;
      topic.updatedAt = timestamp;
      return topic;
    });
  }

  async createKeyIssue(input: {
    topicId: EntityId;
    title: string;
    description?: string;
    order?: number;
  }): Promise<KeyIssue> {
    return this.mutate((project, timestamp) => {
      requireRecord(project.topics, input.topicId, "Topic");
      const siblingOrders = project.keyIssues.filter(({ topicId }) => topicId === input.topicId).map(({ order }) => order);
      const issue: KeyIssue = {
        id: this.dependencies.createId(),
        topicId: input.topicId,
        title: requireTitle(input.title, "/keyIssue/title"),
        order: input.order ?? (siblingOrders.length === 0 ? 0 : Math.max(...siblingOrders) + 1),
        ...(input.description !== undefined ? { description: input.description } : {}),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      project.keyIssues.push(issue);
      return issue;
    });
  }

  async updateKeyIssue(
    keyIssueId: EntityId,
    patch: { title?: string; description?: string; order?: number; visualAssetId?: EntityId | null }
  ): Promise<KeyIssue> {
    return this.mutate((project, timestamp) => {
      const issue = requireRecord(project.keyIssues, keyIssueId, "Key Issue");
      if (patch.title !== undefined) issue.title = requireTitle(patch.title, `/keyIssues/${keyIssueId}/title`);
      if (patch.description !== undefined) issue.description = patch.description;
      if (patch.order !== undefined) issue.order = patch.order;
      if (patch.visualAssetId === null) delete issue.visualAssetId;
      else if (patch.visualAssetId !== undefined) issue.visualAssetId = patch.visualAssetId;
      issue.updatedAt = timestamp;
      return issue;
    });
  }

  async reorderKeyIssues(topicId: EntityId, orderedIds: EntityId[]): Promise<void> {
    return this.mutate((project, timestamp) => {
      requireRecord(project.topics, topicId, "Topic");
      const issues = project.keyIssues.filter(({ topicId: parentId }) => parentId === topicId);
      const expected = [...issues.map(({ id }) => id)].sort();
      const provided = [...orderedIds].sort();
      if (expected.length !== provided.length || expected.some((id, index) => id !== provided[index])) {
        throw new DomainError("invalid-command", "Key Issue order must contain every child exactly once");
      }
      const positions = new Map(orderedIds.map((id, index) => [id, index]));
      for (const issue of issues) {
        issue.order = positions.get(issue.id)!;
        issue.updatedAt = timestamp;
      }
    });
  }

  async connectTopics(input: {
    sourceTopicId: EntityId;
    keyIssueId: EntityId;
    targetTopicId: EntityId;
    order?: number;
    relationType?: string;
    note?: string;
  }): Promise<TopicRelationship> {
    return this.mutate((project, timestamp) => {
      requireRecord(project.topics, input.sourceTopicId, "Source Topic");
      requireRecord(project.topics, input.targetTopicId, "Target Topic");
      const issue = requireRecord(project.keyIssues, input.keyIssueId, "Key Issue");
      if (issue.topicId !== input.sourceTopicId) {
        throw new DomainError("invalid-reference", "Key Issue must belong to the source Topic", {
          path: "/relationship/keyIssueId"
        });
      }
      const relationship: TopicRelationship = {
        id: this.dependencies.createId(),
        sourceTopicId: input.sourceTopicId,
        keyIssueId: input.keyIssueId,
        targetTopicId: input.targetTopicId,
        order: input.order ?? nextTargetOrder(project, input.keyIssueId),
        ...(input.relationType ? { relationType: input.relationType } : {}),
        ...(input.note ? { note: input.note } : {}),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      project.relationships.push(relationship);
      return relationship;
    });
  }

  /** Creates a Topic and links it from a Key Issue in one mutation, so it is one Undo step and never orphaned. */
  async createAndConnectTopic(input: {
    sourceTopicId: EntityId;
    keyIssueId: EntityId;
    title: string;
  }): Promise<{ topic: Topic; relationship: TopicRelationship }> {
    return this.mutate((project, timestamp) => {
      requireRecord(project.topics, input.sourceTopicId, "Source Topic");
      const issue = requireRecord(project.keyIssues, input.keyIssueId, "Key Issue");
      if (issue.topicId !== input.sourceTopicId) {
        throw new DomainError("invalid-reference", "Key Issue must belong to the source Topic", {
          path: "/relationship/keyIssueId"
        });
      }
      const topic: Topic = {
        id: this.dependencies.createId(),
        title: requireTitle(input.title, "/topic/title"),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const relationship: TopicRelationship = {
        id: this.dependencies.createId(),
        sourceTopicId: input.sourceTopicId,
        keyIssueId: input.keyIssueId,
        targetTopicId: topic.id,
        order: nextTargetOrder(project, input.keyIssueId),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      project.topics.push(topic);
      project.relationships.push(relationship);
      return { topic, relationship };
    });
  }

  async setHomeTopic(topicId: EntityId): Promise<void> {
    return this.mutate((project) => {
      requireRecord(project.topics, topicId, "Topic");
      project.manifest.homeTopicId = topicId;
    });
  }

  async updateProjectMetadata(patch: { title?: string; description?: string }): Promise<void> {
    return this.mutate((project) => {
      if (patch.title !== undefined) project.manifest.title = requireTitle(patch.title, "/manifest/title");
      if (patch.description !== undefined) {
        if (patch.description) project.manifest.description = patch.description;
        else delete project.manifest.description;
      }
    });
  }

  /** Sets or clears a Topic or Key Issue cover. A new cover Asset record is added in the same mutation. */
  async setVisualAsset(target: { kind: "topic" | "keyIssue"; id: EntityId }, asset: Asset | null): Promise<void> {
    return this.mutate((project, timestamp) => {
      const entity: Topic | KeyIssue = target.kind === "topic"
        ? requireRecord(project.topics, target.id, "Topic")
        : requireRecord(project.keyIssues, target.id, "Key Issue");
      if (asset) {
        if (project.assets.some(({ id }) => id === asset.id)) {
          throw new DomainError("invalid-command", `Asset ${asset.id} already exists`);
        }
        project.assets.push(structuredClone(asset));
        entity.visualAssetId = asset.id;
      } else {
        delete entity.visualAssetId;
      }
      entity.updatedAt = timestamp;
    });
  }

  async disconnectRelationship(relationshipId: EntityId): Promise<void> {
    return this.mutate((project) => {
      requireRecord(project.relationships, relationshipId, "Relationship");
      project.relationships = project.relationships.filter(({ id }) => id !== relationshipId);
    });
  }

  async linkProject(input: {
    sourceTopicId: EntityId;
    keyIssueId: EntityId;
    targetProjectId: EntityId;
    targetTopicId?: EntityId;
    cachedProjectTitle: string;
    cachedTopicTitle?: string;
    order?: number;
    note?: string;
    metadata?: JsonObject;
  }): Promise<ProjectLink> {
    return this.mutate((project, timestamp) => {
      requireRecord(project.topics, input.sourceTopicId, "Source Topic");
      const issue = requireRecord(project.keyIssues, input.keyIssueId, "Key Issue");
      if (issue.topicId !== input.sourceTopicId) {
        throw new DomainError("invalid-reference", "Key Issue must belong to the source Topic", { path: "/projectLink/keyIssueId" });
      }
      const link: ProjectLink = {
        id: this.dependencies.createId(),
        sourceTopicId: input.sourceTopicId,
        keyIssueId: input.keyIssueId,
        targetProjectId: input.targetProjectId,
        ...(input.targetTopicId ? { targetTopicId: input.targetTopicId } : {}),
        cachedProjectTitle: requireTitle(input.cachedProjectTitle, "/projectLink/cachedProjectTitle"),
        ...(input.cachedTopicTitle ? { cachedTopicTitle: input.cachedTopicTitle.trim() } : {}),
        order: input.order ?? nextTargetOrder(project, input.keyIssueId),
        ...(input.note ? { note: input.note } : {}),
        ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {}),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      project.projectLinks.push(link);
      return link;
    });
  }

  async updateProjectLink(
    projectLinkId: EntityId,
    patch: {
      targetProjectId?: EntityId;
      targetTopicId?: EntityId | null;
      cachedProjectTitle?: string;
      cachedTopicTitle?: string | null;
      order?: number;
      note?: string | null;
      metadata?: JsonObject | null;
    }
  ): Promise<ProjectLink> {
    return this.mutate((project, timestamp) => {
      const link = requireRecord(project.projectLinks, projectLinkId, "Project Link");
      if (patch.targetProjectId !== undefined) link.targetProjectId = patch.targetProjectId;
      if (patch.targetTopicId === null) delete link.targetTopicId;
      else if (patch.targetTopicId !== undefined) link.targetTopicId = patch.targetTopicId;
      if (patch.cachedProjectTitle !== undefined) link.cachedProjectTitle = requireTitle(patch.cachedProjectTitle, `/projectLinks/${projectLinkId}/cachedProjectTitle`);
      if (patch.cachedTopicTitle === null) delete link.cachedTopicTitle;
      else if (patch.cachedTopicTitle !== undefined) link.cachedTopicTitle = requireTitle(patch.cachedTopicTitle, `/projectLinks/${projectLinkId}/cachedTopicTitle`);
      if (patch.order !== undefined) link.order = patch.order;
      if (patch.note === null) delete link.note;
      else if (patch.note !== undefined) link.note = patch.note;
      if (patch.metadata === null) delete link.metadata;
      else if (patch.metadata !== undefined) link.metadata = structuredClone(patch.metadata);
      link.updatedAt = timestamp;
      return link;
    });
  }

  async unlinkProject(projectLinkId: EntityId): Promise<void> {
    return this.mutate((project) => {
      requireRecord(project.projectLinks, projectLinkId, "Project Link");
      project.projectLinks = project.projectLinks.filter(({ id }) => id !== projectLinkId);
    });
  }

  async reorderKeyIssueTargets(keyIssueId: EntityId, orderedIds: EntityId[]): Promise<void> {
    return this.mutate((project, timestamp) => {
      requireRecord(project.keyIssues, keyIssueId, "Key Issue");
      reorderTargets(project, keyIssueId, orderedIds, timestamp);
    });
  }

  async reorderRelationships(keyIssueId: EntityId, orderedIds: EntityId[]): Promise<void> {
    return this.mutate((project, timestamp) => {
      requireRecord(project.keyIssues, keyIssueId, "Key Issue");
      const relationships = project.relationships.filter(({ keyIssueId: issueId }) => issueId === keyIssueId);
      const expected = [...relationships.map(({ id }) => id)].sort();
      const provided = [...orderedIds].sort();
      if (expected.length !== provided.length || expected.some((id, index) => id !== provided[index])) {
        throw new DomainError("invalid-command", "Relationship order must contain every relationship exactly once");
      }
      const relationshipIds = new Set(relationships.map(({ id }) => id));
      const combined = targetsForIssue(project, keyIssueId);
      let relationshipIndex = 0;
      const merged = combined.map(({ id }) => relationshipIds.has(id) ? orderedIds[relationshipIndex++]! : id);
      reorderTargets(project, keyIssueId, merged, timestamp);
    });
  }

  async updateRelationship(
    relationshipId: EntityId,
    patch: { keyIssueId?: EntityId; targetTopicId?: EntityId; order?: number; relationType?: string; note?: string }
  ): Promise<TopicRelationship> {
    return this.mutate((project, timestamp) => {
      const relationship = requireRecord(project.relationships, relationshipId, "Relationship");
      if (patch.keyIssueId !== undefined) relationship.keyIssueId = patch.keyIssueId;
      if (patch.targetTopicId !== undefined) relationship.targetTopicId = patch.targetTopicId;
      if (patch.order !== undefined) relationship.order = patch.order;
      if (patch.relationType !== undefined) relationship.relationType = patch.relationType;
      if (patch.note !== undefined) relationship.note = patch.note;
      relationship.updatedAt = timestamp;
      return relationship;
    });
  }

  async createKnowledgeItem(
    input: Omit<KnowledgeItem, "id" | "createdAt" | "updatedAt">
  ): Promise<KnowledgeItem> {
    return this.mutate((project, timestamp) => {
      const item: KnowledgeItem = {
        ...structuredClone(input),
        id: this.dependencies.createId(),
        title: requireTitle(input.title, "/knowledgeItem/title"),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      project.knowledgeItems.push(item);
      return item;
    });
  }

  async updateKnowledgeItem(
    knowledgeItemId: EntityId,
    patch: Partial<Omit<KnowledgeItem, "id" | "createdAt" | "updatedAt">>
  ): Promise<KnowledgeItem> {
    return this.mutate((project, timestamp) => {
      const item = requireRecord(project.knowledgeItems, knowledgeItemId, "Knowledge Item");
      Object.assign(item, structuredClone(patch));
      if (patch.title !== undefined) item.title = requireTitle(patch.title, `/knowledgeItems/${knowledgeItemId}/title`);
      item.updatedAt = timestamp;
      return item;
    });
  }

  async editAssociatedKnowledge(associationId: EntityId, patch: Pick<KnowledgeItem, "title" | "body" | "summary" | "externalUrl">, scope: "context" | "all"): Promise<void> {
    return this.mutate((project, timestamp) => {
      const association = requireRecord(project.associations, associationId, "Knowledge Association");
      let item = requireRecord(project.knowledgeItems, association.knowledgeItemId, "Knowledge Item");
      if (scope === "context" && project.associations.filter(({ knowledgeItemId }) => knowledgeItemId === item.id).length > 1) {
        item = { ...structuredClone(item), id: this.dependencies.createId(), createdAt: timestamp };
        project.knowledgeItems.push(item);
        association.knowledgeItemId = item.id;
      }
      item.title = requireTitle(patch.title, "/knowledgeItem/title");
      if (patch.body !== undefined) item.body = patch.body;
      if (patch.summary !== undefined) item.summary = patch.summary;
      if (patch.externalUrl !== undefined) item.externalUrl = patch.externalUrl;
      item.updatedAt = timestamp;
    });
  }

  async removeAssociatedKnowledge(associationId: EntityId, scope: "context" | "all"): Promise<void> {
    return this.mutate((project) => {
      const association = requireRecord(project.associations, associationId, "Knowledge Association");
      project.associations = project.associations.filter((candidate) => scope === "all"
        ? candidate.knowledgeItemId !== association.knowledgeItemId : candidate.id !== associationId);
      if (!project.associations.some(({ knowledgeItemId }) => knowledgeItemId === association.knowledgeItemId)) {
        project.knowledgeItems = project.knowledgeItems.filter(({ id }) => id !== association.knowledgeItemId);
      }
    });
  }

  async importKnowledge(entries: Array<{ asset: Asset; item: Omit<KnowledgeItem, "id" | "createdAt" | "updatedAt"> }>, target: { kind: "topic" | "keyIssue"; id: string }): Promise<void> {
    return this.mutate((project, timestamp) => {
      requireRecord(target.kind === "topic" ? project.topics : project.keyIssues, target.id, "Import destination");
      for (const entry of entries) {
        const item: KnowledgeItem = { ...structuredClone(entry.item), id: this.dependencies.createId(), createdAt: timestamp, updatedAt: timestamp };
        project.assets.push(structuredClone(entry.asset));
        project.knowledgeItems.push(item);
        project.associations.push({ id: this.dependencies.createId(), knowledgeItemId: item.id, targetKind: target.kind, targetId: target.id });
      }
    });
  }

  async associateKnowledge(
    input: Omit<KnowledgeAssociation, "id">
  ): Promise<KnowledgeAssociation> {
    return this.mutate((project) => {
      const association: KnowledgeAssociation = {
        ...structuredClone(input),
        id: this.dependencies.createId()
      };
      project.associations.push(association);
      return association;
    });
  }

  async createAndAssociateKnowledge(input: {
    item: Omit<KnowledgeItem, "id" | "createdAt" | "updatedAt">;
    association: Omit<KnowledgeAssociation, "id" | "knowledgeItemId">;
  }): Promise<{ item: KnowledgeItem; association: KnowledgeAssociation }> {
    return this.mutate((project, timestamp) => {
      const item: KnowledgeItem = {
        ...structuredClone(input.item),
        id: this.dependencies.createId(),
        title: requireTitle(input.item.title, "/knowledgeItem/title"),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const association: KnowledgeAssociation = {
        ...structuredClone(input.association),
        id: this.dependencies.createId(),
        knowledgeItemId: item.id
      };
      project.knowledgeItems.push(item);
      project.associations.push(association);
      return { item, association };
    });
  }

  async updateKnowledgeAssociation(
    associationId: EntityId,
    patch: Partial<Omit<KnowledgeAssociation, "id" | "knowledgeItemId" | "targetKind" | "targetId">>
  ): Promise<KnowledgeAssociation> {
    return this.mutate((project) => {
      const association = requireRecord(project.associations, associationId, "Knowledge Association");
      Object.assign(association, structuredClone(patch));
      return association;
    });
  }

  async addAsset(input: Omit<Asset, "id" | "createdAt">): Promise<Asset> {
    return this.mutate((project, timestamp) => {
      const asset: Asset = {
        ...structuredClone(input),
        id: this.dependencies.createId(),
        createdAt: timestamp
      };
      project.assets.push(asset);
      return asset;
    });
  }

  async attachManagedAsset(input: {
    asset: Asset;
    item: Omit<KnowledgeItem, "id" | "createdAt" | "updatedAt" | "attachmentAssetIds">;
    association: Omit<KnowledgeAssociation, "id" | "knowledgeItemId">;
  }): Promise<{ asset: Asset; item: KnowledgeItem; association: KnowledgeAssociation }> {
    return this.mutate((project, timestamp) => {
      if (project.assets.some(({ id }) => id === input.asset.id)) {
        throw new DomainError("invalid-command", `Asset ${input.asset.id} already exists`);
      }
      const asset = structuredClone(input.asset);
      const item: KnowledgeItem = {
        ...structuredClone(input.item),
        id: this.dependencies.createId(),
        title: requireTitle(input.item.title, "/knowledgeItem/title"),
        attachmentAssetIds: [asset.id],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const association: KnowledgeAssociation = {
        ...structuredClone(input.association),
        id: this.dependencies.createId(),
        knowledgeItemId: item.id
      };
      project.assets.push(asset);
      project.knowledgeItems.push(item);
      project.associations.push(association);
      return { asset, item, association };
    });
  }

  async replaceManagedAsset(assetId: EntityId, replacement: Asset): Promise<Asset> {
    return this.mutate((project, timestamp) => {
      requireRecord(project.assets, assetId, "Asset");
      if (replacement.id === assetId || project.assets.some(({ id }) => id === replacement.id)) {
        throw new DomainError("invalid-command", "Asset replacement requires a new stable identity");
      }
      project.assets.push(structuredClone(replacement));
      for (const topic of project.topics) if (topic.visualAssetId === assetId) {
        topic.visualAssetId = replacement.id;
        topic.updatedAt = timestamp;
      }
      for (const issue of project.keyIssues) if (issue.visualAssetId === assetId) {
        issue.visualAssetId = replacement.id;
        issue.updatedAt = timestamp;
      }
      for (const item of project.knowledgeItems) {
        if (item.attachmentAssetIds?.includes(assetId)) {
          item.attachmentAssetIds = item.attachmentAssetIds.map((id) => id === assetId ? replacement.id : id);
          item.updatedAt = timestamp;
        }
      }
      if (project.theme?.brandingAssetIds?.includes(assetId)) {
        project.theme.brandingAssetIds = project.theme.brandingAssetIds.map((id) => id === assetId ? replacement.id : id);
      }
      return replacement;
    });
  }

  async updateAssetMetadata(
    assetId: EntityId,
    patch: Partial<Pick<Asset, "originalFilename" | "mimeType" | "width" | "height" | "durationSeconds" | "metadata">>
  ): Promise<Asset> {
    return this.mutate((project) => {
      const asset = requireRecord(project.assets, assetId, "Asset");
      Object.assign(asset, structuredClone(patch));
      return asset;
    });
  }

  async createCollection(input: Omit<Collection, "id">): Promise<Collection> {
    return this.mutate((project) => {
      const collection: Collection = {
        ...structuredClone(input),
        id: this.dependencies.createId(),
        title: requireTitle(input.title, "/collection/title")
      };
      project.collections.push(collection);
      return collection;
    });
  }

  async updateCollection(
    collectionId: EntityId,
    patch: Partial<Omit<Collection, "id">>
  ): Promise<Collection> {
    return this.mutate((project) => {
      const collection = requireRecord(project.collections, collectionId, "Collection");
      Object.assign(collection, structuredClone(patch));
      if (patch.title !== undefined) collection.title = requireTitle(patch.title, `/collections/${collectionId}/title`);
      return collection;
    });
  }

  async setTheme(input: Omit<Theme, "id"> & { id?: EntityId }): Promise<Theme> {
    return this.mutate((project) => {
      const theme: Theme = {
        ...structuredClone(input),
        id: input.id ?? project.theme?.id ?? this.dependencies.createId(),
        name: requireTitle(input.name, "/theme/name")
      };
      project.theme = theme;
      project.manifest.themeId = theme.id;
      return theme;
    });
  }

  async recordPublishedSnapshot(
    input: Omit<PublishedSnapshot, "id" | "revision" | "publishedAt"> & { id?: EntityId }
  ): Promise<PublishedSnapshot> {
    return this.mutate((project, timestamp) => {
      const snapshot: PublishedSnapshot = {
        ...structuredClone(input),
        id: input.id ?? this.dependencies.createId(),
        revision: project.manifest.revision,
        publishedAt: timestamp
      };
      project.snapshots.push(snapshot);
      project.manifest.publishedSnapshotId = snapshot.id;
      return snapshot;
    });
  }

  async getTopicDeletionImpact(topicId: EntityId): Promise<TopicDeletionImpact> {
    const project = await this.repository.load();
    requireRecord(project.topics, topicId, "Topic");
    const keyIssueIds = project.keyIssues.filter(({ topicId: parentId }) => parentId === topicId).map(({ id }) => id);
    const keyIssueSet = new Set(keyIssueIds);
    return {
      keyIssueIds,
      relationshipIds: project.relationships
        .filter(
          ({ sourceTopicId, targetTopicId, keyIssueId }) =>
            sourceTopicId === topicId || targetTopicId === topicId || keyIssueSet.has(keyIssueId)
        )
        .map(({ id }) => id),
      projectLinkIds: project.projectLinks
        .filter(({ sourceTopicId, keyIssueId }) => sourceTopicId === topicId || keyIssueSet.has(keyIssueId))
        .map(({ id }) => id),
      associationIds: project.associations
        .filter(
          ({ targetKind, targetId }) =>
            (targetKind === "topic" && targetId === topicId) || (targetKind === "keyIssue" && keyIssueSet.has(targetId))
        )
        .map(({ id }) => id),
      isHomeTopic: project.manifest.homeTopicId === topicId
    };
  }

  async deleteTopic(topicId: EntityId, options: { removeReferences?: boolean } = {}): Promise<void> {
    const impact = await this.getTopicDeletionImpact(topicId);
    const references = [...impact.keyIssueIds, ...impact.relationshipIds, ...impact.projectLinkIds, ...impact.associationIds];
    if (impact.isHomeTopic) references.push("manifest.homeTopicId");
    if (references.length > 0 && !options.removeReferences) {
      throw new DomainError("dependent-references", "Topic has dependent references", { references });
    }
    await this.mutate((project) => {
      project.topics = project.topics.filter(({ id }) => id !== topicId);
      if (options.removeReferences) {
        const issueIds = new Set(impact.keyIssueIds);
        const relationshipIds = new Set(impact.relationshipIds);
        const projectLinkIds = new Set(impact.projectLinkIds);
        const associationIds = new Set(impact.associationIds);
        project.keyIssues = project.keyIssues.filter(({ id }) => !issueIds.has(id));
        project.relationships = project.relationships.filter(({ id }) => !relationshipIds.has(id));
        project.projectLinks = project.projectLinks.filter(({ id }) => !projectLinkIds.has(id));
        project.associations = project.associations.filter(({ id }) => !associationIds.has(id));
        if (impact.isHomeTopic) {
          if (project.topics[0]) project.manifest.homeTopicId = project.topics[0].id;
          else delete project.manifest.homeTopicId;
        }
      }
    });
  }

  async getKeyIssueDeletionImpact(keyIssueId: EntityId): Promise<KeyIssueDeletionImpact> {
    const project = await this.repository.load();
    requireRecord(project.keyIssues, keyIssueId, "Key Issue");
    return {
      relationshipIds: project.relationships.filter(({ keyIssueId: id }) => id === keyIssueId).map(({ id }) => id),
      projectLinkIds: project.projectLinks.filter(({ keyIssueId: id }) => id === keyIssueId).map(({ id }) => id),
      associationIds: project.associations
        .filter(({ targetKind, targetId }) => targetKind === "keyIssue" && targetId === keyIssueId)
        .map(({ id }) => id)
    };
  }

  async deleteKeyIssue(keyIssueId: EntityId, options: { removeReferences?: boolean } = {}): Promise<void> {
    const impact = await this.getKeyIssueDeletionImpact(keyIssueId);
    const references = [...impact.relationshipIds, ...impact.projectLinkIds, ...impact.associationIds];
    if (references.length > 0 && !options.removeReferences) {
      throw new DomainError("dependent-references", "Key Issue has dependent references", { references });
    }
    await this.mutate((project) => {
      project.keyIssues = project.keyIssues.filter(({ id }) => id !== keyIssueId);
      if (options.removeReferences) {
        const relationshipIds = new Set(impact.relationshipIds);
        const projectLinkIds = new Set(impact.projectLinkIds);
        const associationIds = new Set(impact.associationIds);
        project.relationships = project.relationships.filter(({ id }) => !relationshipIds.has(id));
        project.projectLinks = project.projectLinks.filter(({ id }) => !projectLinkIds.has(id));
        project.associations = project.associations.filter(({ id }) => !associationIds.has(id));
      }
    });
  }
}

function targetsForIssue(project: CanonicalProject, keyIssueId: EntityId): Array<{ id: EntityId; order?: number }> {
  return [
    ...project.relationships.filter(({ keyIssueId: id }) => id === keyIssueId),
    ...project.projectLinks.filter(({ keyIssueId: id }) => id === keyIssueId)
  ].sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id));
}

function nextTargetOrder(project: CanonicalProject, keyIssueId: EntityId): number {
  const targets = targetsForIssue(project, keyIssueId);
  const orders = targets.map(({ order }) => order ?? -1);
  return targets.length ? Math.max(targets.length - 1, ...orders) + 1 : 0;
}

function reorderTargets(project: CanonicalProject, keyIssueId: EntityId, orderedIds: EntityId[], timestamp: string): void {
  const targets = targetsForIssue(project, keyIssueId);
  const expected = targets.map(({ id }) => id).sort();
  const provided = [...orderedIds].sort();
  if (expected.length !== provided.length || expected.some((id, index) => id !== provided[index])) {
    throw new DomainError("invalid-command", "Target order must contain every relationship and Project Link exactly once");
  }
  const positions = new Map(orderedIds.map((id, index) => [id, index]));
  for (const relationship of project.relationships.filter(({ keyIssueId: id }) => id === keyIssueId)) {
    relationship.order = positions.get(relationship.id)!;
    relationship.updatedAt = timestamp;
  }
  for (const link of project.projectLinks.filter(({ keyIssueId: id }) => id === keyIssueId)) {
    link.order = positions.get(link.id)!;
    link.updatedAt = timestamp;
  }
}
