import { createValidProject, timestamp } from "../test/project-fixtures.js";
import { buildGraphProjection } from "./projection.js";
import { layoutRadialProjection } from "./radial-layout.js";

function createLayoutProject() {
  const project = createValidProject();
  project.topics.push({ id: "topic-3", title: "Third", createdAt: timestamp, updatedAt: timestamp });
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
    targetTopicId: "topic-3",
    createdAt: timestamp,
    updatedAt: timestamp
  });
  return project;
}

describe("deterministic radial layout", () => {
  it("returns identical geometry for identical projection input", () => {
    const projection = buildGraphProjection(createLayoutProject(), "topic-1");
    expect(layoutRadialProjection(projection)).toEqual(layoutRadialProjection(structuredClone(projection)));
  });

  it("keeps geometry stable when only label language and direction change", () => {
    const project = createLayoutProject();
    const english = layoutRadialProjection(buildGraphProjection(project, "topic-1"));
    project.topics[0].title = "الموضوع المركزي";
    project.topics[1].title = "موضوع ذو صلة";
    project.topics[2].title = "Интерпретируемость моделей";
    project.keyIssues[0].title = "قضية رئيسية";
    project.keyIssues[1].title = "Ключевая проблема";
    const multilingual = layoutRadialProjection(buildGraphProjection(project, "topic-1"));

    expect(multilingual).toEqual(english);
  });

  it("uses the same positioned nodes as relationship endpoints", () => {
    const layout = layoutRadialProjection(buildGraphProjection(createLayoutProject(), "topic-1"));
    const edge = layout.relationships[0];
    const issue = layout.keyIssues.find(({ id }) => id === edge.keyIssueId);
    const topic = layout.relatedTopics.find(({ id }) => id === edge.relatedTopicId);

    expect(edge.start).toEqual({ x: issue?.x, y: issue?.y });
    expect(edge.end).toEqual({ x: topic?.x, y: topic?.y });
    expect(edge.path).toMatch(/^M [\d.-]+ [\d.-]+ Q [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+$/);
  });

  it("scales deterministically for a different layout size", () => {
    const projection = buildGraphProjection(createLayoutProject(), "topic-1");
    const small = layoutRadialProjection(projection, { size: 600 });
    const large = layoutRadialProjection(projection, { size: 1200 });

    expect(large.center.x).toBe(small.center.x * 2);
    expect(large.center.radius).toBe(small.center.radius * 2);
  });

  it("aligns grouped Related Topics with their Key Issues while preserving their circular order", () => {
    const project = createValidProject();
    project.topics = [project.topics[0]];
    project.keyIssues = [];
    project.relationships = [];
    for (let i = 0; i < 8; i += 1) {
      project.keyIssues.push({ id: `issue-${i}`, topicId: "topic-1", title: `Issue ${i}`, order: i, createdAt: timestamp, updatedAt: timestamp });
      for (let j = 0; j < 4; j += 1) {
        const id = `outer-${i}-${j}`;
        project.topics.push({ id, title: id, createdAt: timestamp, updatedAt: timestamp });
        project.relationships.push({ id: `edge-${i}-${j}`, sourceTopicId: "topic-1", keyIssueId: `issue-${i}`, targetTopicId: id, order: j, createdAt: timestamp, updatedAt: timestamp });
      }
    }
    const projection = buildGraphProjection(project, "topic-1");
    const original = structuredClone(projection);
    const layout = layoutRadialProjection(projection);
    const orderedIds = projection.relatedTopics.map(({ id }) => id);
    const visualIds = layout.relatedTopics.map(({ id }) => id);
    const start = orderedIds.indexOf(visualIds[0]);
    expect(visualIds).toEqual([...orderedIds.slice(start), ...orderedIds.slice(0, start)]);
    expect(projection).toEqual(original);
    for (const edge of layout.relationships) {
      const issue = layout.keyIssues.find(({ id }) => id === edge.keyIssueId)!;
      const topic = layout.relatedTopics.find(({ id }) => id === edge.relatedTopicId)!;
      const separation = Math.abs(((topic.angle - issue.angle + 540) % 360) - 180);
      expect(separation).toBeLessThanOrEqual(22.5);
    }
    const selected = layoutRadialProjection(buildGraphProjection(project, "topic-1", { selectedKeyIssueId: "issue-3" }));
    expect(selected.relatedTopics.map(({ id, x, y }) => ({ id, x, y }))).toEqual(layout.relatedTopics.map(({ id, x, y }) => ({ id, x, y })));
  });
});
