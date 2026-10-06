import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import canonicalProjectSchema from "../../schemas/v2/canonical-project.schema.json" with { type: "json" };
import type { CanonicalProject } from "../domain/types.js";
import { normalizeProjectPath } from "./paths.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ProjectValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export class ProjectValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "ProjectValidationError";
    this.issues = issues;
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateStructure = ajv.compile<CanonicalProject>(canonicalProjectSchema);

function schemaIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || "/",
    message: error.message ?? "is invalid"
  }));
}

function duplicateIssues<T extends { id: string }>(name: string, records: T[]): ValidationIssue[] {
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];
  for (const record of records) {
    if (seen.has(record.id)) issues.push({ path: `/${name}/${record.id}`, message: "duplicate ID" });
    seen.add(record.id);
  }
  return issues;
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function referenceIssues(project: CanonicalProject): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const topics = new Set(project.topics.map(({ id }) => id));
  const keyIssues = new Map(project.keyIssues.map((issue) => [issue.id, issue]));
  const knowledgeItems = new Set(project.knowledgeItems.map(({ id }) => id));
  const assets = new Set(project.assets.map(({ id }) => id));
  const collections = new Set(project.collections.map(({ id }) => id));
  const snapshots = new Set(project.snapshots.map(({ id }) => id));

  if (project.manifest.homeTopicId && !topics.has(project.manifest.homeTopicId)) {
    issues.push({ path: "/manifest/homeTopicId", message: "does not reference a Topic" });
  }
  if (project.manifest.themeId && project.theme?.id !== project.manifest.themeId) {
    issues.push({ path: "/manifest/themeId", message: "does not reference the Project Theme" });
  }
  if (project.manifest.publishedSnapshotId && !snapshots.has(project.manifest.publishedSnapshotId)) {
    issues.push({ path: "/manifest/publishedSnapshotId", message: "does not reference a Published Snapshot" });
  }

  for (const issue of project.keyIssues) {
    if (!topics.has(issue.topicId)) {
      issues.push({ path: `/keyIssues/${issue.id}/topicId`, message: "does not reference a Topic" });
    }
    if (issue.visualAssetId && !assets.has(issue.visualAssetId)) {
      issues.push({ path: `/keyIssues/${issue.id}/visualAssetId`, message: "does not reference an Asset" });
    }
  }

  for (const topic of project.topics) {
    if (topic.visualAssetId && !assets.has(topic.visualAssetId)) {
      issues.push({ path: `/topics/${topic.id}/visualAssetId`, message: "does not reference an Asset" });
    }
  }

  for (const relationship of project.relationships) {
    const issue = keyIssues.get(relationship.keyIssueId);
    if (!topics.has(relationship.sourceTopicId)) {
      issues.push({ path: `/relationships/${relationship.id}/sourceTopicId`, message: "does not reference a Topic" });
    }
    if (!topics.has(relationship.targetTopicId)) {
      issues.push({ path: `/relationships/${relationship.id}/targetTopicId`, message: "does not reference a Topic" });
    }
    if (!issue) {
      issues.push({ path: `/relationships/${relationship.id}/keyIssueId`, message: "does not reference a Key Issue" });
    } else if (issue.topicId !== relationship.sourceTopicId) {
      issues.push({
        path: `/relationships/${relationship.id}/keyIssueId`,
        message: "belongs to a different source Topic"
      });
    }
  }

  const linkTargets = new Set<string>();
  for (const link of project.projectLinks) {
    const issue = keyIssues.get(link.keyIssueId);
    if (!topics.has(link.sourceTopicId)) {
      issues.push({ path: `/projectLinks/${link.id}/sourceTopicId`, message: "does not reference a Topic" });
    }
    if (!issue) {
      issues.push({ path: `/projectLinks/${link.id}/keyIssueId`, message: "does not reference a Key Issue" });
    } else if (issue.topicId !== link.sourceTopicId) {
      issues.push({ path: `/projectLinks/${link.id}/keyIssueId`, message: "belongs to a different source Topic" });
    }
    if (link.targetProjectId === project.manifest.id) {
      issues.push({ path: `/projectLinks/${link.id}/targetProjectId`, message: "must reference a different Project" });
    }
    const key = `${link.keyIssueId}\u0000${link.targetProjectId}\u0000${link.targetTopicId ?? ""}`;
    if (linkTargets.has(key)) {
      issues.push({ path: `/projectLinks/${link.id}`, message: "duplicates a Project Link target under this Key Issue" });
    }
    linkTargets.add(key);
  }

  for (const item of project.knowledgeItems) {
    if (item.availability === "external" && (!item.externalUrl || !isSafeExternalUrl(item.externalUrl))) {
      issues.push({ path: `/knowledgeItems/${item.id}/externalUrl`, message: "must be an HTTP(S) URL" });
    }
    if (item.contentPath) {
      try {
        normalizeProjectPath(item.contentPath);
      } catch (error) {
        issues.push({ path: `/knowledgeItems/${item.id}/contentPath`, message: (error as Error).message });
      }
    }
    for (const assetId of item.attachmentAssetIds ?? []) {
      if (!assets.has(assetId)) {
        issues.push({ path: `/knowledgeItems/${item.id}/attachmentAssetIds`, message: `does not reference Asset ${assetId}` });
      }
    }
  }

  for (const association of project.associations) {
    if (!knowledgeItems.has(association.knowledgeItemId)) {
      issues.push({ path: `/associations/${association.id}/knowledgeItemId`, message: "does not reference a Knowledge Item" });
    }
    const targetExists =
      association.targetKind === "topic" ? topics.has(association.targetId) : keyIssues.has(association.targetId);
    if (!targetExists) {
      issues.push({ path: `/associations/${association.id}/targetId`, message: `does not reference a ${association.targetKind}` });
    }
    for (const collectionId of association.collectionIds ?? []) {
      if (!collections.has(collectionId)) {
        issues.push({ path: `/associations/${association.id}/collectionIds`, message: `does not reference Collection ${collectionId}` });
      }
    }
  }

  for (const asset of project.assets) {
    try {
      const normalized = normalizeProjectPath(asset.path);
      if (normalized !== asset.path) {
        issues.push({ path: `/assets/${asset.id}/path`, message: "must use normalized forward-slash separators" });
      }
    } catch (error) {
      issues.push({ path: `/assets/${asset.id}/path`, message: (error as Error).message });
    }
  }

  for (const snapshot of project.snapshots) {
    try {
      normalizeProjectPath(snapshot.manifestPath);
    } catch (error) {
      issues.push({ path: `/snapshots/${snapshot.id}/manifestPath`, message: (error as Error).message });
    }
    for (const assetId of snapshot.assetIds) {
      if (!assets.has(assetId)) {
        issues.push({ path: `/snapshots/${snapshot.id}/assetIds`, message: `does not reference Asset ${assetId}` });
      }
    }
  }

  return issues;
}

export function validateProject(value: unknown): ProjectValidationResult {
  if (!validateStructure(value)) {
    return { valid: false, issues: schemaIssues(validateStructure.errors) };
  }

  const project = value as CanonicalProject;
  const issues = [
    ...duplicateIssues("topics", project.topics),
    ...duplicateIssues("keyIssues", project.keyIssues),
    ...duplicateIssues("relationships", project.relationships),
    ...duplicateIssues("projectLinks", project.projectLinks),
    ...duplicateIssues("knowledgeItems", project.knowledgeItems),
    ...duplicateIssues("associations", project.associations),
    ...duplicateIssues("assets", project.assets),
    ...duplicateIssues("collections", project.collections),
    ...duplicateIssues("snapshots", project.snapshots),
    ...referenceIssues(project)
  ];
  return { valid: issues.length === 0, issues };
}

export function assertValidProject(value: unknown): asserts value is CanonicalProject {
  const result = validateProject(value);
  if (!result.valid) throw new ProjectValidationError(result.issues);
}
