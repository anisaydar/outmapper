import { createValidProject, timestamp } from "../test/project-fixtures.js";
import { buildGraphProjection } from "./projection.js";

function createSharedTargetProject() {
  const project = createValidProject();
  project.keyIssues.push({
    id: "issue-2",
    topicId: "topic-1",
    title: "Second Issue",
    order: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  project.relationships.push({
    id: "relationship-2",
    sourceTopicId: "topic-1",
    keyIssueId: "issue-2",
    targetTopicId: "topic-2",
    order: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  return project;
}

describe("GraphProjection", () => {
  it("deduplicates a shared Related Topic while retaining each relationship", () => {
    const projection = buildGraphProjection(createSharedTargetProject(), "topic-1");

    expect(projection.relatedTopics).toHaveLength(1);
    expect(projection.relatedTopics[0]).toMatchObject({
      id: "topic-2",
      keyIssueIds: ["issue-1", "issue-2"],
      relationshipIds: ["relationship-1", "relationship-2"]
    });
    expect(projection.relationships).toHaveLength(2);
    expect(projection.semanticRelationships).toHaveLength(2);
    expect(projection.semanticRelationships[0].relatedTopics[0].alsoViaKeyIssueIds).toEqual(["issue-2"]);
  });

  it("projects both sides of a cycle independently", () => {
    const project = createSharedTargetProject();
    project.keyIssues.push({
      id: "issue-reverse",
      topicId: "topic-2",
      title: "Reverse",
      order: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    project.relationships.push({
      id: "relationship-reverse",
      sourceTopicId: "topic-2",
      keyIssueId: "issue-reverse",
      targetTopicId: "topic-1",
      createdAt: timestamp,
      updatedAt: timestamp
    });

    expect(buildGraphProjection(project, "topic-1").relatedTopics.map(({ id }) => id)).toEqual(["topic-2"]);
    expect(buildGraphProjection(project, "topic-2").relatedTopics.map(({ id }) => id)).toEqual(["topic-1"]);
  });

  it("is deterministic regardless of canonical record array order", () => {
    const project = createSharedTargetProject();
    const reversed = structuredClone(project);
    reversed.topics.reverse();
    reversed.keyIssues.reverse();
    reversed.relationships.reverse();

    expect(buildGraphProjection(reversed, "topic-1")).toEqual(buildGraphProjection(project, "topic-1"));
  });

  it("derives Key Issue and Related Topic emphasis", () => {
    const project = createSharedTargetProject();
    project.topics.push({ id: "topic-3", title: "Other", createdAt: timestamp, updatedAt: timestamp });
    project.relationships.push({
      id: "relationship-3",
      sourceTopicId: "topic-1",
      keyIssueId: "issue-2",
      targetTopicId: "topic-3",
      order: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    const issueSelection = buildGraphProjection(project, "topic-1", { selectedKeyIssueId: "issue-1" });
    expect(issueSelection.keyIssues.find(({ id }) => id === "issue-1")?.emphasis).toBe("selected");
    expect(issueSelection.relatedTopics.find(({ id }) => id === "topic-2")?.emphasis).toBe("highlighted");
    expect(issueSelection.relatedTopics.find(({ id }) => id === "topic-3")?.emphasis).toBe("dimmed");

    const topicSelection = buildGraphProjection(project, "topic-1", { selectedRelatedTopicId: "topic-2" });
    expect(topicSelection.relatedTopics.find(({ id }) => id === "topic-2")?.emphasis).toBe("selected");
    expect(topicSelection.keyIssues.every(({ emphasis }) => emphasis === "highlighted")).toBe(true);
    expect(topicSelection.relationships.filter(({ relatedTopicId }) => relatedTopicId === "topic-2"))
      .toHaveLength(2);
  });

  it("keeps renderer coordinates out of the projection", () => {
    const projection = buildGraphProjection(createSharedTargetProject(), "topic-1");
    const coordinateKeys = new Set(["x", "y", "angle", "radius", "path"]);
    const found: string[] = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (coordinateKeys.has(key)) found.push(key);
        visit(child);
      }
    };
    visit(projection);

    expect(found).toEqual([]);
  });

  it("provides transition hints without persisting layout state", () => {
    const project = createSharedTargetProject();
    const previous = buildGraphProjection(project, "topic-1");
    project.keyIssues.push({
      id: "issue-reverse",
      topicId: "topic-2",
      title: "Reverse",
      order: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    project.relationships.push({
      id: "relationship-reverse",
      sourceTopicId: "topic-2",
      keyIssueId: "issue-reverse",
      targetTopicId: "topic-1",
      createdAt: timestamp,
      updatedAt: timestamp
    });

    const next = buildGraphProjection(project, "topic-2", { previousProjection: previous });
    expect(next.transition).toEqual({ fromTopicId: "topic-1", sharedTopicIds: [] });
  });
});
