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
  associationIds: EntityId[];
  isHomeTopic: boolean;
}

export interface KeyIssueDeletionImpact {
  relationshipIds: EntityId[];
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
        ...(input.order !== undefined ? { order: input.order } : {}),
        ...(input.relationType ? { relationType: input.relationType } : {}),
        ...(input.note ? { note: input.note } : {}),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      project.relationships.push(relationship);
      return relationship;
    });
  }

  async disconnectRelationship(relationshipId: EntityId): Promise<void> {
    return this.mutate((project) => {
      requireRecord(project.relationships, relationshipId, "Relationship");
      project.relationships = project.relationships.filter(({ id }) => id !== relationshipId);
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
      const positions = new Map(orderedIds.map((id, index) => [id, index]));
      for (const relationship of relationships) {
        relationship.order = positions.get(relationship.id)!;
        relationship.updatedAt = timestamp;
      }
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
    const references = [...impact.keyIssueIds, ...impact.relationshipIds, ...impact.associationIds];
    if (impact.isHomeTopic) references.push("manifest.homeTopicId");
    if (references.length > 0 && !options.removeReferences) {
      throw new DomainError("dependent-references", "Topic has dependent references", { references });
    }
    await this.mutate((project) => {
      project.topics = project.topics.filter(({ id }) => id !== topicId);
      if (options.removeReferences) {
        const issueIds = new Set(impact.keyIssueIds);
        const relationshipIds = new Set(impact.relationshipIds);
        const associationIds = new Set(impact.associationIds);
        project.keyIssues = project.keyIssues.filter(({ id }) => !issueIds.has(id));
        project.relationships = project.relationships.filter(({ id }) => !relationshipIds.has(id));
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
      associationIds: project.associations
        .filter(({ targetKind, targetId }) => targetKind === "keyIssue" && targetId === keyIssueId)
        .map(({ id }) => id)
    };
  }

  async deleteKeyIssue(keyIssueId: EntityId, options: { removeReferences?: boolean } = {}): Promise<void> {
    const impact = await this.getKeyIssueDeletionImpact(keyIssueId);
    const references = [...impact.relationshipIds, ...impact.associationIds];
    if (references.length > 0 && !options.removeReferences) {
      throw new DomainError("dependent-references", "Key Issue has dependent references", { references });
    }
    await this.mutate((project) => {
      project.keyIssues = project.keyIssues.filter(({ id }) => id !== keyIssueId);
      if (options.removeReferences) {
        const relationshipIds = new Set(impact.relationshipIds);
        const associationIds = new Set(impact.associationIds);
        project.relationships = project.relationships.filter(({ id }) => !relationshipIds.has(id));
        project.associations = project.associations.filter(({ id }) => !associationIds.has(id));
      }
    });
  }
}
