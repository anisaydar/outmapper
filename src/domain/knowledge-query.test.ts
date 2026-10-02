import { queryKnowledgeContext } from "./knowledge-query.js";
import { createValidProject, timestamp } from "../test/project-fixtures.js";

describe("contextual Knowledge queries", () => {
  it("keeps Topic and Key Issue associations in their own contexts", () => {
    const project = createValidProject();
    project.collections.push({ id: "collection-research", title: "Research", order: 0 });
    project.knowledgeItems.push(
      {
        id: "knowledge-topic",
        type: "article",
        title: "Topic evidence",
        availability: "external",
        externalUrl: "https://example.org/topic",
        tags: ["evidence"],
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: "knowledge-issue",
        type: "note",
        title: "Issue note",
        availability: "local",
        createdAt: timestamp,
        updatedAt: timestamp
      }
    );
    project.associations.push(
      {
        id: "association-topic",
        knowledgeItemId: "knowledge-topic",
        targetKind: "topic",
        targetId: "topic-1",
        pinned: true,
        collectionIds: ["collection-research"]
      },
      {
        id: "association-issue",
        knowledgeItemId: "knowledge-issue",
        targetKind: "keyIssue",
        targetId: "issue-1"
      }
    );

    const topic = queryKnowledgeContext(project, { kind: "topic", id: "topic-1" });
    const issue = queryKnowledgeContext(project, { kind: "keyIssue", id: "issue-1" });

    expect(topic.sections.find(({ id }) => id === "pinned")?.items[0]?.item.id).toBe("knowledge-topic");
    expect(topic.sections.find(({ id }) => id === "collection:collection-research")?.items).toHaveLength(1);
    expect(topic.sections.find(({ id }) => id === "tag:evidence")?.items).toHaveLength(1);
    expect(issue.sections.find(({ id }) => id === "notes")?.items[0]?.item.id).toBe("knowledge-issue");
    expect(issue.sections.flatMap(({ items }) => items).some(({ item }) => item.id === "knowledge-topic")).toBe(false);
  });

  it("makes local and external availability available to presentation code", () => {
    const project = createValidProject();
    project.knowledgeItems.push({
      id: "knowledge-external",
      type: "link",
      title: "External source",
      availability: "external",
      externalUrl: "https://example.org/source",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    project.associations.push({
      id: "association-external",
      knowledgeItemId: "knowledge-external",
      targetKind: "topic",
      targetId: "topic-1"
    });

    const context = queryKnowledgeContext(project, { kind: "topic", id: "topic-1" });
    const item = context.sections.flatMap(({ items }) => items).find(({ item }) => item.id === "knowledge-external");

    expect(item?.item.availability).toBe("external");
    expect(item?.item.externalUrl).toBe("https://example.org/source");
  });
});
