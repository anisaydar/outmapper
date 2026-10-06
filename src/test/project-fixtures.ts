import type { CanonicalProject } from "../domain/types.js";

export const timestamp = "2026-09-30T00:00:00.000Z";

export function createValidProject(): CanonicalProject {
  return {
    manifest: {
      format: "outmapper-project",
      formatVersion: 2,
      id: "project-1",
      title: "Test Project",
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 0,
      homeTopicId: "topic-1"
    },
    topics: [
      { id: "topic-1", title: "Center", createdAt: timestamp, updatedAt: timestamp },
      { id: "topic-2", title: "Related", createdAt: timestamp, updatedAt: timestamp }
    ],
    keyIssues: [
      {
        id: "issue-1",
        topicId: "topic-1",
        title: "Issue",
        order: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ],
    relationships: [
      {
        id: "relationship-1",
        sourceTopicId: "topic-1",
        keyIssueId: "issue-1",
        targetTopicId: "topic-2",
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ],
    projectLinks: [],
    knowledgeItems: [],
    associations: [],
    assets: [],
    collections: [],
    snapshots: []
  };
}
