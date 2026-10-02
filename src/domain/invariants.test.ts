import { createValidProject } from "../test/project-fixtures.js";
import { assertDomainInvariants } from "./invariants.js";

describe("domain invariants", () => {
  it("accepts a cycle between Topics", () => {
    const project = createValidProject();
    project.keyIssues.push({
      id: "issue-2",
      topicId: "topic-2",
      title: "Reverse",
      order: 0,
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z"
    });
    project.relationships.push({
      id: "relationship-2",
      sourceTopicId: "topic-2",
      keyIssueId: "issue-2",
      targetTopicId: "topic-1",
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z"
    });

    expect(() => assertDomainInvariants(project)).not.toThrow();
  });

  it("rejects an external Knowledge Item with a dangerous URL", () => {
    const project = createValidProject();
    project.knowledgeItems.push({
      id: "knowledge-unsafe",
      type: "link",
      title: "Unsafe",
      availability: "external",
      externalUrl: "javascript:alert(1)",
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z"
    });

    expect(() => assertDomainInvariants(project)).toThrow("requires an HTTP(S) URL");
  });
});
