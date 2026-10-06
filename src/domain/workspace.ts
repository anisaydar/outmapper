import type { EntityId } from "./types.js";

export type WorkspaceProjectStatus = "available" | "missing" | "mismatch" | "unreadable" | "duplicate" | "needs-open";

export interface FileFingerprint {
  size: number;
  mtimeMs: number;
}

export interface ProjectFingerprint {
  manifest: FileFingerprint;
  projectLinks: FileFingerprint | null;
}

export interface CachedOutgoingProjectLink {
  id: EntityId;
  sourceTopicId: EntityId;
  sourceTopicTitle?: string;
  keyIssueId: EntityId;
  keyIssueTitle?: string;
  targetProjectId: EntityId;
  targetTopicId?: EntityId;
  cachedProjectTitle: string;
  cachedTopicTitle?: string;
}

export interface IncomingProjectLink {
  linkId: EntityId;
  sourceInstanceId: string;
  sourceProjectId: EntityId;
  sourceProjectTitle: string;
  sourceTopicId: EntityId;
  sourceTopicTitle: string;
  keyIssueId: EntityId;
  keyIssueTitle: string;
  availability: "available" | "unavailable";
}

export interface IncomingProjectLinkGroup {
  topicId: EntityId;
  links: IncomingProjectLink[];
}

export interface IncomingProjectLinks {
  projectId: EntityId;
  groups: IncomingProjectLinkGroup[];
  total: number;
}

export interface UniverseProjectNode {
  instanceId: string;
  projectId: EntityId;
  title: string;
  description?: string;
  status: WorkspaceProjectStatus;
  duplicateCount: number;
  homeTopicId?: EntityId;
  homeTopicTitle?: string;
  coverUrl?: string;
  lastOpenedAt?: string;
}

export interface UniverseProjectEdge {
  id: string;
  sourceProjectId: EntityId;
  targetProjectId: EntityId;
  count: number;
}

export interface WorkspaceUniverse {
  nodes: UniverseProjectNode[];
  edges: UniverseProjectEdge[];
}

export interface WorkspaceProjectEntry {
  instanceId: string;
  directory: string;
  projectId: EntityId;
  title: string;
  description?: string;
  homeTopicId?: EntityId;
  homeTopicTitle?: string;
  homeCoverAssetPath?: string;
  homeCoverMimeType?: string;
  revision: number;
  formatVersion: number;
  fingerprint?: ProjectFingerprint;
  status: WorkspaceProjectStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  lastOpenedAt?: string;
  hiddenFromRecent: boolean;
  outgoingLinks: CachedOutgoingProjectLink[];
}

export interface WorkspaceRegistryData {
  formatVersion: 1;
  projects: Record<string, WorkspaceProjectEntry>;
  preferredInstance: Record<string, string>;
}

export type ProjectResolution =
  | { status: "resolved"; project: WorkspaceProjectEntry }
  | { status: "choose"; projects: WorkspaceProjectEntry[] }
  | { status: "unavailable"; projects: WorkspaceProjectEntry[] };
