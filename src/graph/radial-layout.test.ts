import { createValidProject, timestamp } from "../test/project-fixtures.js";
import { buildGraphProjection } from "./projection.js";
import { layoutRadialProjection, selectVisiblePortals } from "./radial-layout.js";

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

  it.each([0, 1, 8, 10])("lays out %i outgoing portals with an eight-node cap and overflow", (count) => {
    const project = createLayoutProject();
    project.projectLinks = Array.from({ length: count }, (_, index) => ({
      id: `portal-${index}`,
      sourceTopicId: "topic-1",
      keyIssueId: index % 2 ? "issue-2" : "issue-1",
      targetProjectId: `external-${index}`,
      cachedProjectTitle: `External ${index}`,
      order: index,
      createdAt: timestamp,
      updatedAt: timestamp
    }));
    const layout = layoutRadialProjection(buildGraphProjection(project, "topic-1"));
    expect(layout.portals).toHaveLength(Math.min(8, count));
    expect(layout.portalEdges).toHaveLength(Math.min(8, count));
    expect(layout.portalOverflow?.count).toBe(count > 8 ? count - 8 : undefined);
    for (const edge of layout.portalEdges) {
      const issue = layout.keyIssues.find(({ id }) => id === edge.keyIssueId)!;
      const portal = layout.portals.find(({ id }) => id === edge.portalId)!;
      expect(edge.start).toEqual({ x: issue.x, y: issue.y });
      // The edge stops just short of the portal's frame, pointing at it, so its arrowhead stays visible.
      expect(Math.hypot(edge.end.x - portal.x, edge.end.y - portal.y)).toBeCloseTo(26, 0);
      expect(edge.arrowAngle).toBe(portal.angle);
    }
    const distance = (point: { x: number; y: number }) => Math.hypot(point.x - layout.center.x, point.y - layout.center.y);
    const topicRing = Math.max(0, ...layout.relatedTopics.map(distance));
    for (const portal of layout.portals) {
      // Clear of the related-Topic ring and its radial labels, and labelled on the side facing away from the center.
      expect(distance(portal) - topicRing).toBeGreaterThanOrEqual(150);
      expect(distance(portal)).toBeLessThanOrEqual(layout.size / 2);
      const outward = { top: portal.y < layout.center.y, bottom: portal.y > layout.center.y, left: portal.x < layout.center.x, right: portal.x > layout.center.x };
      expect(outward[portal.labelPlacement]).toBe(true);
    }
  });

  it("shares the eight-node cap between outgoing and incoming portals, spreads them evenly, and points incoming edges inward", () => {
    const project = createLayoutProject();
    project.projectLinks = Array.from({ length: 5 }, (_, index) => ({
      id: `outgoing-${index}`,
      sourceTopicId: "topic-1",
      keyIssueId: "issue-1",
      targetProjectId: `outgoing-project-${index}`,
      cachedProjectTitle: `Outgoing ${index}`,
      order: index,
      createdAt: timestamp,
      updatedAt: timestamp
    }));
    const incomingLinks = Array.from({ length: 5 }, (_, index) => ({
      linkId: `incoming-${index}`,
      sourceInstanceId: `instance-${index}`,
      sourceProjectId: `incoming-project-${index}`,
      sourceProjectTitle: `Incoming ${index}`,
      sourceTopicId: `source-topic-${index}`,
      sourceTopicTitle: `Source Topic ${index}`,
      keyIssueId: `source-issue-${index}`,
      keyIssueTitle: `Source Issue ${index}`,
      availability: "available" as const
    }));
    const projection = buildGraphProjection(project, "topic-1", { incomingLinks });
    const visible = selectVisiblePortals(projection.portals);
    const layout = layoutRadialProjection(projection);

    expect(visible.filter(({ direction }) => direction === "outgoing")).toHaveLength(4);
    expect(visible.filter(({ direction }) => direction === "incoming")).toHaveLength(4);
    expect(layout.portals).toHaveLength(8);
    expect(layout.portalOverflow?.count).toBe(2);
    expect(new Set(layout.portals.map(({ x, y }) => `${x}:${y}`)).size).toBe(8);
    // Evenly spread around the whole circle: no two neighbors far closer or far apart than 360 / 8 degrees.
    const angles = layout.portals.map(({ angle }) => angle).sort((left, right) => left - right);
    const steps = angles.map((angle, index) => (angles[index + 1] ?? angles[0]! + 360) - angle);
    expect(Math.max(...steps)).toBeLessThanOrEqual(90);
    const separation = (left: number, right: number) => Math.abs(((left - right) % 360 + 540) % 360 - 180);
    for (const portal of layout.portals) {
      // Each portal sits between Topic spokes and clear of the other portals.
      for (const topic of layout.relatedTopics) expect(separation(portal.angle, topic.angle)).toBeGreaterThan(1);
      for (const other of layout.portals) if (other !== portal) expect(separation(portal.angle, other.angle)).toBeGreaterThanOrEqual(20);
    }
    for (const edge of layout.portalEdges.filter(({ portalDirection }) => portalDirection === "incoming")) {
      const startDistance = Math.hypot(edge.start.x - layout.center.x, edge.start.y - layout.center.y);
      const endDistance = Math.hypot(edge.end.x - layout.center.x, edge.end.y - layout.center.y);
      expect(startDistance).toBeGreaterThan(endDistance);
      expect(endDistance).toBeCloseTo(layout.center.radius, 0);
    }
  });
  it("merges links to one Project into one portal and keeps incoming edges apart", () => {
    const project = createLayoutProject();
    project.projectLinks = ["issue-1", "issue-2"].map((keyIssueId, index) => ({
      id: `same-${index}`,
      sourceTopicId: "topic-1",
      keyIssueId,
      targetProjectId: "external-same",
      cachedProjectTitle: "Same Project",
      order: index,
      createdAt: timestamp,
      updatedAt: timestamp
    }));
    const incomingLinks = Array.from({ length: 3 }, (_, index) => ({
      linkId: `incoming-${index}`,
      sourceInstanceId: "instance",
      sourceProjectId: index < 2 ? "incoming-project-a" : "incoming-project-b",
      sourceProjectTitle: index < 2 ? "Incoming A" : "Incoming B",
      sourceTopicId: "source-topic",
      sourceTopicTitle: "Source Topic",
      keyIssueId: `source-issue-${index}`,
      keyIssueTitle: `Source Issue ${index}`,
      availability: "available" as const
    }));
    const layout = layoutRadialProjection(buildGraphProjection(project, "topic-1", { incomingLinks }));

    expect(layout.portals.map(({ linkIds }) => linkIds.length)).toEqual([2, 2, 1]);
    expect(layout.portalOverflow).toBeUndefined();
    const outgoing = layout.portals.find(({ direction }) => direction === "outgoing")!;
    expect(outgoing.keyIssueIds).toEqual(["issue-1", "issue-2"]);
    // One edge per Key Issue for the outgoing portal, and one edge per incoming portal.
    expect(layout.portalEdges.filter(({ portalId }) => portalId === outgoing.id).map(({ keyIssueId }) => keyIssueId)).toEqual(["issue-1", "issue-2"]);
    const incomingEnds = layout.portalEdges.filter(({ portalDirection }) => portalDirection === "incoming").map(({ end }) => `${end.x}:${end.y}`);
    expect(incomingEnds).toHaveLength(2);
    expect(new Set(incomingEnds).size).toBe(2);
    for (const edge of layout.portalEdges) expect(edge.arrowAngle).toEqual(expect.any(Number));
  });
});
