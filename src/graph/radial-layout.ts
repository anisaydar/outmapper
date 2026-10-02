import type { EntityId } from "../domain/types.js";
import type { GraphProjection, ProjectionEmphasis } from "./projection.js";

export interface Point {
  x: number;
  y: number;
}

export interface PositionedNode extends Point {
  id: EntityId;
  angle: number;
  labelSide: "start" | "end";
  emphasis: ProjectionEmphasis;
}

export interface PositionedEdge {
  id: EntityId;
  keyIssueId: EntityId;
  relatedTopicId: EntityId;
  start: Point;
  control: Point;
  end: Point;
  path: string;
  emphasis: ProjectionEmphasis;
}

export interface RadialLayout {
  size: number;
  center: Point & { radius: number };
  keyIssues: PositionedNode[];
  relatedTopics: PositionedNode[];
  relationships: PositionedEdge[];
}

export interface RadialLayoutOptions {
  size?: number;
  centerRadius?: number;
  innerRadius?: number;
  outerRadius?: number;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function pointAt(center: Point, angle: number, radius: number): Point {
  const radians = (angle * Math.PI) / 180;
  return {
    x: round(center.x + radius * Math.cos(radians)),
    y: round(center.y + radius * Math.sin(radians))
  };
}

function pathFor(start: Point, control: Point, end: Point): string {
  return `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
}

export function layoutRadialProjection(
  projection: GraphProjection,
  options: RadialLayoutOptions = {}
): RadialLayout {
  const size = options.size ?? 860;
  const center = { x: round(size / 2), y: round(size / 2) };
  const centerRadius = options.centerRadius ?? round(size * (92 / 860));
  const innerRadius = options.innerRadius ?? centerRadius;
  const adaptiveOuterRadius = size * (222 / 860) + Math.max(0, projection.relatedTopics.length - 36) * 1.5;
  const outerRadius = options.outerRadius ?? round(Math.min(size * 0.39, adaptiveOuterRadius));

  const issueStep = projection.keyIssues.length === 0 ? 0 : 360 / projection.keyIssues.length;
  const issueStart = projection.keyIssues.length === 0 ? 0 : -180 + issueStep / 2;
  const keyIssues: PositionedNode[] = projection.keyIssues.map((issue, index) => {
    const angle = round(issueStart + issueStep * index);
    return {
      id: issue.id,
      angle,
      ...pointAt(center, angle, innerRadius),
      labelSide: Math.cos((angle * Math.PI) / 180) >= 0 ? "start" : "end",
      emphasis: issue.emphasis
    };
  });

  const relatedStep = projection.relatedTopics.length === 0 ? 0 : 360 / projection.relatedTopics.length;
  const issueDirections = new Map(keyIssues.map(({ id, angle }) => [id, {
    x: Math.cos(angle * Math.PI / 180), y: Math.sin(angle * Math.PI / 180)
  }]));
  let alignmentX = 0;
  let alignmentY = 0;
  projection.relatedTopics.forEach((topic, index) => {
    const angle = (-90 + relatedStep * index) * Math.PI / 180;
    for (const id of topic.keyIssueIds) {
      const direction = issueDirections.get(id);
      if (!direction) continue;
      alignmentX += direction.x * Math.cos(angle) + direction.y * Math.sin(angle);
      alignmentY += direction.y * Math.cos(angle) - direction.x * Math.sin(angle);
    }
  });
  const count = projection.relatedTopics.length;
  const offset = count && Math.hypot(alignmentX, alignmentY) > 0.000001
    ? ((Math.round(Math.atan2(alignmentY, alignmentX) / (relatedStep * Math.PI / 180)) % count) + count) % count
    : 0;
  const orderedTopics = offset
    ? [...projection.relatedTopics.slice(count - offset), ...projection.relatedTopics.slice(0, count - offset)]
    : projection.relatedTopics;
  const relatedTopics: PositionedNode[] = orderedTopics.map((topic, index) => {
    const angle = round(-90 + relatedStep * index);
    return {
      id: topic.id,
      angle,
      ...pointAt(center, angle, outerRadius),
      labelSide: Math.cos((angle * Math.PI) / 180) >= 0 ? "start" : "end",
      emphasis: topic.emphasis
    };
  });

  const issuesById = new Map(keyIssues.map((node) => [node.id, node]));
  const topicsById = new Map(relatedTopics.map((node) => [node.id, node]));
  const relationships: PositionedEdge[] = projection.relationships.map((relationship) => {
    const start = issuesById.get(relationship.keyIssueId);
    const end = topicsById.get(relationship.relatedTopicId);
    if (!start || !end) throw new Error(`Cannot lay out relationship ${relationship.id}`);
    const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const control = {
      x: round(center.x + (midpoint.x - center.x) * 0.25),
      y: round(center.y + (midpoint.y - center.y) * 0.25)
    };
    return {
      id: relationship.id,
      keyIssueId: relationship.keyIssueId,
      relatedTopicId: relationship.relatedTopicId,
      start: { x: start.x, y: start.y },
      control,
      end: { x: end.x, y: end.y },
      path: pathFor(start, control, end),
      emphasis: relationship.emphasis
    };
  });

  return {
    size,
    center: { ...center, radius: centerRadius },
    keyIssues,
    relatedTopics,
    relationships
  };
}
