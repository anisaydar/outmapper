import { DomainError } from "../domain/errors.js";
import type { CanonicalProject, EntityId } from "../domain/types.js";
import type { IncomingProjectLink } from "../domain/workspace.js";

export type ProjectionEmphasis = "default" | "selected" | "highlighted" | "dimmed";

interface ProjectedEntity {
  id: EntityId;
  title: string;
  description?: string;
  visualAssetId?: EntityId;
}

export type ProjectedTopic = ProjectedEntity;

export interface ProjectedKeyIssue extends ProjectedEntity {
  order: number;
  ringIndex: number;
  relatedTopicIds: EntityId[];
  emphasis: ProjectionEmphasis;
}

export interface ProjectedRelatedTopic extends ProjectedTopic {
  ringIndex: number;
  keyIssueIds: EntityId[];
  relationshipIds: EntityId[];
  visibilityPriority: number;
  emphasis: ProjectionEmphasis;
}

export interface ProjectedRelationship {
  id: EntityId;
  keyIssueId: EntityId;
  relatedTopicId: EntityId;
  order: number;
  relationType?: string;
  note?: string;
  emphasis: ProjectionEmphasis;
}

interface ProjectedPortalBase {
  id: EntityId;
  direction: "outgoing" | "incoming";
  projectTitle: string;
  topicTitle?: string;
  note?: string;
  order: number;
  availability: "available" | "unavailable";
}

export interface ProjectedOutgoingPortal extends ProjectedPortalBase {
  direction: "outgoing";
  keyIssueId: EntityId;
  keyIssueTitle: string;
  targetProjectId: EntityId;
  targetTopicId?: EntityId;
}

export interface ProjectedIncomingPortal extends ProjectedPortalBase {
  direction: "incoming";
  sourceInstanceId: string;
  sourceProjectId: EntityId;
  sourceTopicId: EntityId;
  sourceTopicTitle: string;
  sourceKeyIssueId: EntityId;
  sourceKeyIssueTitle: string;
}

export type ProjectedPortal = ProjectedOutgoingPortal | ProjectedIncomingPortal;

export interface SemanticRelationshipGroup {
  keyIssueId: EntityId;
  keyIssueTitle: string;
  relatedTopics: Array<{
    topicId: EntityId;
    title: string;
    relationshipIds: EntityId[];
    alsoViaKeyIssueIds: EntityId[];
  }>;
}

export interface GraphProjection {
  projectId: EntityId;
  revision: number;
  centralTopic: ProjectedTopic;
  keyIssues: ProjectedKeyIssue[];
  relatedTopics: ProjectedRelatedTopic[];
  relationships: ProjectedRelationship[];
  portals: ProjectedPortal[];
  semanticRelationships: SemanticRelationshipGroup[];
  layoutInput: {
    keyIssueIds: EntityId[];
    relatedTopicIds: EntityId[];
    portalIds: EntityId[];
  };
  transition: {
    fromTopicId?: EntityId;
    sharedTopicIds: EntityId[];
  };
}

export interface GraphProjectionOptions {
  selectedKeyIssueId?: EntityId;
  selectedRelatedTopicId?: EntityId;
  previousProjection?: GraphProjection;
  portalProjects?: Record<string, { title: string; available: boolean }>;
  incomingLinks?: IncomingProjectLink[];
}

function compareOrdered(
  left: { order?: number; id: EntityId },
  right: { order?: number; id: EntityId }
): number {
  return (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id);
}

export function buildGraphProjection(
  project: CanonicalProject,
  centralTopicId: EntityId,
  options: GraphProjectionOptions = {}
): GraphProjection {
  if (options.selectedKeyIssueId && options.selectedRelatedTopicId) {
    throw new DomainError("invalid-command", "Only one graph selection may be active");
  }

  const central = project.topics.find(({ id }) => id === centralTopicId);
  if (!central) throw new DomainError("not-found", `Topic ${centralTopicId} does not exist`);

  const topicsById = new Map(project.topics.map((topic) => [topic.id, topic]));
  const sourceIssues = project.keyIssues
    .filter(({ topicId }) => topicId === centralTopicId)
    .sort(compareOrdered);
  const issueIndex = new Map(sourceIssues.map((issue, index) => [issue.id, index]));
  const sourceRelationships = project.relationships
    .filter(({ sourceTopicId }) => sourceTopicId === centralTopicId)
    .sort((left, right) => {
      const issueDifference =
        (issueIndex.get(left.keyIssueId) ?? Number.MAX_SAFE_INTEGER) -
        (issueIndex.get(right.keyIssueId) ?? Number.MAX_SAFE_INTEGER);
      return issueDifference || compareOrdered(left, right) || left.targetTopicId.localeCompare(right.targetTopicId);
    });
  const sourcePortals = project.projectLinks
    .filter(({ sourceTopicId }) => sourceTopicId === centralTopicId)
    .sort((left, right) => {
      const issueDifference = (issueIndex.get(left.keyIssueId) ?? Number.MAX_SAFE_INTEGER) - (issueIndex.get(right.keyIssueId) ?? Number.MAX_SAFE_INTEGER);
      return issueDifference || compareOrdered(left, right);
    });

  for (const relationship of sourceRelationships) {
    if (!issueIndex.has(relationship.keyIssueId)) {
      throw new DomainError("invalid-reference", `Relationship ${relationship.id} has no Key Issue in this Topic`);
    }
    if (!topicsById.has(relationship.targetTopicId)) {
      throw new DomainError("invalid-reference", `Relationship ${relationship.id} has no target Topic`);
    }
  }

  const relationshipsByTarget = new Map<EntityId, typeof sourceRelationships>();
  for (const relationship of sourceRelationships) {
    const existing = relationshipsByTarget.get(relationship.targetTopicId) ?? [];
    existing.push(relationship);
    relationshipsByTarget.set(relationship.targetTopicId, existing);
  }

  const orderedTargetIds = [...relationshipsByTarget.entries()]
    .sort(([leftId, leftRelationships], [rightId, rightRelationships]) => {
      const leftFirst = leftRelationships[0];
      const rightFirst = rightRelationships[0];
      const issueDifference =
        (issueIndex.get(leftFirst.keyIssueId) ?? Number.MAX_SAFE_INTEGER) -
        (issueIndex.get(rightFirst.keyIssueId) ?? Number.MAX_SAFE_INTEGER);
      return issueDifference || compareOrdered(leftFirst, rightFirst) || leftId.localeCompare(rightId);
    })
    .map(([targetId]) => targetId);

  const selectedIssueId = options.selectedKeyIssueId;
  const selectedTopicId = options.selectedRelatedTopicId;
  if (selectedIssueId && !issueIndex.has(selectedIssueId)) {
    throw new DomainError("invalid-command", "Selected Key Issue is not in this projection");
  }
  if (selectedTopicId && !relationshipsByTarget.has(selectedTopicId)) {
    throw new DomainError("invalid-command", "Selected Related Topic is not in this projection");
  }

  const hasSelection = Boolean(selectedIssueId || selectedTopicId);
  const activeIssueIds = new Set<EntityId>();
  const activeTopicIds = new Set<EntityId>();
  if (selectedIssueId) {
    activeIssueIds.add(selectedIssueId);
    for (const relationship of sourceRelationships) {
      if (relationship.keyIssueId === selectedIssueId) activeTopicIds.add(relationship.targetTopicId);
    }
  }
  if (selectedTopicId) {
    activeTopicIds.add(selectedTopicId);
    for (const relationship of relationshipsByTarget.get(selectedTopicId) ?? []) {
      activeIssueIds.add(relationship.keyIssueId);
    }
  }

  const keyIssues: ProjectedKeyIssue[] = sourceIssues.map((issue, ringIndex) => {
    const relatedTopicIds = orderedTargetIds.filter((topicId) =>
      (relationshipsByTarget.get(topicId) ?? []).some(({ keyIssueId }) => keyIssueId === issue.id)
    );
    const emphasis: ProjectionEmphasis =
      issue.id === selectedIssueId
        ? "selected"
        : activeIssueIds.has(issue.id)
          ? "highlighted"
          : hasSelection
            ? "dimmed"
            : "default";
    return {
      id: issue.id,
      title: issue.title,
      ...(issue.description !== undefined ? { description: issue.description } : {}),
      ...(issue.visualAssetId ? { visualAssetId: issue.visualAssetId } : {}),
      order: issue.order,
      ringIndex,
      relatedTopicIds,
      emphasis
    };
  });

  const relatedTopics: ProjectedRelatedTopic[] = orderedTargetIds.map((topicId, ringIndex) => {
    const topic = topicsById.get(topicId);
    if (!topic) throw new DomainError("invalid-reference", `Related Topic ${topicId} does not exist`);
    const topicRelationships = relationshipsByTarget.get(topicId) ?? [];
    const keyIssueIds = [...new Set(topicRelationships.map(({ keyIssueId }) => keyIssueId))];
    const emphasis: ProjectionEmphasis =
      topicId === selectedTopicId
        ? "selected"
        : activeTopicIds.has(topicId)
          ? "highlighted"
          : hasSelection
            ? "dimmed"
            : "default";
    return {
      id: topic.id,
      title: topic.title,
      ...(topic.description !== undefined ? { description: topic.description } : {}),
      ...(topic.visualAssetId ? { visualAssetId: topic.visualAssetId } : {}),
      ringIndex,
      keyIssueIds,
      relationshipIds: topicRelationships.map(({ id }) => id),
      visibilityPriority: emphasis === "selected" ? 0 : emphasis === "highlighted" ? 1 : 3 + ringIndex,
      emphasis
    };
  });

  const relationships: ProjectedRelationship[] = sourceRelationships.map((relationship) => {
    const highlighted =
      relationship.keyIssueId === selectedIssueId || relationship.targetTopicId === selectedTopicId;
    return {
      id: relationship.id,
      keyIssueId: relationship.keyIssueId,
      relatedTopicId: relationship.targetTopicId,
      order: relationship.order ?? Number.MAX_SAFE_INTEGER,
      ...(relationship.relationType ? { relationType: relationship.relationType } : {}),
      ...(relationship.note ? { note: relationship.note } : {}),
      emphasis: highlighted ? "highlighted" : hasSelection ? "dimmed" : "default"
    };
  });
  const outgoingPortals: ProjectedPortal[] = sourcePortals.map((portal) => {
    const issue = sourceIssues.find(({ id }) => id === portal.keyIssueId);
    if (!issue) throw new DomainError("invalid-reference", `Project Link ${portal.id} has no Key Issue in this Topic`);
    const live = options.portalProjects?.[portal.targetProjectId];
    return {
      id: portal.id,
      direction: "outgoing",
      keyIssueId: portal.keyIssueId,
      keyIssueTitle: issue.title,
      targetProjectId: portal.targetProjectId,
      ...(portal.targetTopicId ? { targetTopicId: portal.targetTopicId } : {}),
      projectTitle: live?.title ?? portal.cachedProjectTitle,
      ...(portal.cachedTopicTitle ? { topicTitle: portal.cachedTopicTitle } : {}),
      ...(portal.note ? { note: portal.note } : {}),
      order: portal.order ?? Number.MAX_SAFE_INTEGER,
      availability: live?.available ? "available" : "unavailable"
    };
  });
  const incomingPortals: ProjectedPortal[] = (options.incomingLinks ?? []).map((link, index) => ({
    id: `incoming:${link.sourceInstanceId}:${link.linkId}`,
    direction: "incoming",
    sourceInstanceId: link.sourceInstanceId,
    sourceProjectId: link.sourceProjectId,
    sourceTopicId: link.sourceTopicId,
    sourceTopicTitle: link.sourceTopicTitle,
    sourceKeyIssueId: link.keyIssueId,
    sourceKeyIssueTitle: link.keyIssueTitle,
    projectTitle: link.sourceProjectTitle,
    topicTitle: link.sourceTopicTitle,
    order: index,
    availability: link.availability
  }));
  const portals = [...outgoingPortals, ...incomingPortals];

  const relatedById = new Map(relatedTopics.map((topic) => [topic.id, topic]));
  const semanticRelationships: SemanticRelationshipGroup[] = keyIssues.map((issue) => ({
    keyIssueId: issue.id,
    keyIssueTitle: issue.title,
    relatedTopics: issue.relatedTopicIds.map((topicId) => {
      const topic = relatedById.get(topicId);
      if (!topic) throw new DomainError("invalid-reference", `Related Topic ${topicId} does not exist`);
      const relationshipIds = relationships
        .filter(({ keyIssueId, relatedTopicId }) => keyIssueId === issue.id && relatedTopicId === topicId)
        .map(({ id }) => id);
      return {
        topicId,
        title: topic.title,
        relationshipIds,
        alsoViaKeyIssueIds: topic.keyIssueIds.filter((keyIssueId) => keyIssueId !== issue.id)
      };
    })
  }));

  const previousTopicIds = new Set(options.previousProjection?.relatedTopics.map(({ id }) => id) ?? []);
  const currentTopicIds = new Set(relatedTopics.map(({ id }) => id));
  const sharedTopicIds = [...previousTopicIds].filter((id) => currentTopicIds.has(id)).sort();

  return {
    projectId: project.manifest.id,
    revision: project.manifest.revision,
    centralTopic: {
      id: central.id,
      title: central.title,
      ...(central.description !== undefined ? { description: central.description } : {}),
      ...(central.visualAssetId ? { visualAssetId: central.visualAssetId } : {})
    },
    keyIssues,
    relatedTopics,
    relationships,
    portals,
    semanticRelationships,
    layoutInput: {
      keyIssueIds: keyIssues.map(({ id }) => id),
      relatedTopicIds: relatedTopics.map(({ id }) => id),
      portalIds: portals.map(({ id }) => id)
    },
    transition: {
      ...(options.previousProjection ? { fromTopicId: options.previousProjection.centralTopic.id } : {}),
      sharedTopicIds
    }
  };
}
