export type EntityId = string;
export type IsoTimestamp = string;
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ProjectManifest {
  format: "outmapper-project";
  formatVersion: 2;
  id: EntityId;
  title: string;
  description?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  revision: number;
  defaultLocale?: string;
  defaultDirection?: "auto" | "ltr" | "rtl";
  homeTopicId?: EntityId;
  themeId?: EntityId;
  publishedSnapshotId?: EntityId;
  contentLicense?: string;
}

export interface Topic {
  id: EntityId;
  title: string;
  description?: string;
  visualAssetId?: EntityId;
  metadata?: JsonObject;
  tags?: string[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface KeyIssue {
  id: EntityId;
  topicId: EntityId;
  title: string;
  order: number;
  description?: string;
  visualAssetId?: EntityId;
  metadata?: JsonObject;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface TopicRelationship {
  id: EntityId;
  sourceTopicId: EntityId;
  keyIssueId: EntityId;
  targetTopicId: EntityId;
  order?: number;
  relationType?: string;
  note?: string;
  metadata?: JsonObject;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ProjectLink {
  id: EntityId;
  sourceTopicId: EntityId;
  keyIssueId: EntityId;
  targetProjectId: EntityId;
  targetTopicId?: EntityId;
  cachedProjectTitle: string;
  cachedTopicTitle?: string;
  order?: number;
  note?: string;
  metadata?: JsonObject;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface KnowledgeItem {
  id: EntityId;
  type: string;
  title: string;
  availability: "local" | "external";
  summary?: string;
  body?: string;
  contentPath?: string;
  externalUrl?: string;
  authors?: string[];
  source?: string;
  publishedAt?: IsoTimestamp;
  tags?: string[];
  attachmentAssetIds?: EntityId[];
  language?: string;
  metadata?: JsonObject;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface KnowledgeAssociation {
  id: EntityId;
  knowledgeItemId: EntityId;
  targetKind: "topic" | "keyIssue";
  targetId: EntityId;
  pinned?: boolean;
  order?: number;
  collectionIds?: EntityId[];
  note?: string;
  metadata?: JsonObject;
}

export interface Asset {
  id: EntityId;
  path: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  metadata?: JsonObject;
  createdAt: IsoTimestamp;
}

export interface Collection {
  id: EntityId;
  title: string;
  description?: string;
  order?: number;
  metadata?: JsonObject;
}

export interface Theme {
  id: EntityId;
  name: string;
  tokens: JsonObject;
  brandingAssetIds?: EntityId[];
}

export interface PublishedSnapshot {
  id: EntityId;
  revision: number;
  publishedAt: IsoTimestamp;
  manifestPath: string;
  assetIds: EntityId[];
  title?: string;
  note?: string;
  metadata?: JsonObject;
}

export interface CanonicalProject {
  manifest: ProjectManifest;
  topics: Topic[];
  keyIssues: KeyIssue[];
  relationships: TopicRelationship[];
  projectLinks: ProjectLink[];
  knowledgeItems: KnowledgeItem[];
  associations: KnowledgeAssociation[];
  assets: Asset[];
  collections: Collection[];
  theme?: Theme;
  snapshots: PublishedSnapshot[];
}
