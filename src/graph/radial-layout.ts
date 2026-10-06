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
  portalDirection?: "outgoing" | "incoming";
  /** For a portal edge: the portal it belongs to, and the direction its arrowhead points at `end`, in degrees. */
  portalId?: EntityId;
  arrowAngle?: number;
}

/** The physical side of a portal that faces away from the map center, where its label sits. */
export type PortalLabelPlacement = "top" | "bottom" | "left" | "right";

export interface PositionedPortal extends Point {
  /** The first link's id; a portal stands for every link between this Topic and one Project in one direction. */
  id: EntityId;
  linkIds: EntityId[];
  direction: "outgoing" | "incoming";
  keyIssueIds: EntityId[];
  angle: number;
  labelSide: "start" | "end";
  labelPlacement: PortalLabelPlacement;
}

/** Portals past the cap; the map shows them as one "+N" control outside the graph. */
export interface PositionedPortalOverflow {
  id: "portal-overflow";
  count: number;
}

export interface RadialLayout {
  size: number;
  center: Point & { radius: number };
  keyIssues: PositionedNode[];
  relatedTopics: PositionedNode[];
  relationships: PositionedEdge[];
  portals: PositionedPortal[];
  portalEdges: PositionedEdge[];
  portalOverflow?: PositionedPortalOverflow;
}

export interface RadialLayoutOptions {
  size?: number;
  centerRadius?: number;
  innerRadius?: number;
  outerRadius?: number;
}

type ProjectedPortal = GraphProjection["portals"][number];

/** Links between this Topic and one Project in one direction share a portal; groups keep the links' order. */
export function groupPortals(portals: GraphProjection["portals"]): ProjectedPortal[][] {
  const groups = new Map<string, ProjectedPortal[]>();
  for (const portal of portals) {
    const key = portal.direction === "outgoing" ? `outgoing:${portal.targetProjectId}` : `incoming:${portal.sourceProjectId}`;
    groups.set(key, [...(groups.get(key) ?? []), portal]);
  }
  return [...groups.values()];
}

/** The portal groups shown on the map, at most `limit` of them, shared between outgoing and incoming. */
export const PORTAL_LIMIT = 8;

export function selectVisiblePortalGroups(portals: GraphProjection["portals"], limit = PORTAL_LIMIT): ProjectedPortal[][] {
  const groups = groupPortals(portals);
  const outgoingGroups = groups.filter(([first]) => first!.direction === "outgoing");
  const incomingGroups = groups.filter(([first]) => first!.direction === "incoming");
  if (!outgoingGroups.length || !incomingGroups.length) return groups.slice(0, limit);
  const initial = Math.floor(limit / 2);
  const outgoing = outgoingGroups.slice(0, initial);
  const incoming = incomingGroups.slice(0, limit - initial);
  let remaining = limit - outgoing.length - incoming.length;
  for (const group of [...outgoingGroups.slice(outgoing.length), ...incomingGroups.slice(incoming.length)]) {
    if (remaining <= 0) break;
    (group[0]!.direction === "outgoing" ? outgoing : incoming).push(group);
    remaining -= 1;
  }
  return [...outgoing, ...incoming];
}

/** Every link drawn on the map, through its portal group. */
export function selectVisiblePortals(portals: GraphProjection["portals"], limit = PORTAL_LIMIT): GraphProjection["portals"] {
  return selectVisiblePortalGroups(portals, limit).flat();
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

  const visibleGroups = selectVisiblePortalGroups(projection.portals);
  // Portals sit on their own ring past the longest related-Topic labels, which extend radially from the outer ring.
  const portalRadius = round(Math.min(size / 2 - size * (30 / 860), outerRadius + size * (160 / 860)));
  // Portals spread evenly around the map: one slot every 360/N degrees, turned so outgoing portals sit as close as they
  // can to the middle of their Key Issue's fan, with incoming portals in the remaining slots. Each slot then moves to
  // the nearest gap between Topic spokes within half a slot, so portal edges run between existing lines.
  const normalize = (angle: number) => ((angle % 360) + 540) % 360 - 180;
  const separation = (left: number, right: number) => Math.abs(normalize(left - right));
  const topicAngles = relatedTopics.map(({ angle }) => normalize(angle)).sort((left, right) => left - right);
  const gapAngles = topicAngles.length > 1
    ? topicAngles.map((angle, index) => normalize((angle + (topicAngles[index + 1] ?? topicAngles[0]! + 360)) / 2))
    : topicAngles.length === 1 ? [normalize(topicAngles[0]! + 180)]
      : keyIssues.length > 1 ? keyIssues.map(({ angle }) => normalize(angle + issueStep / 2))
        : [];
  const fanTarget = (keyIssueId: EntityId) => {
    const issue = issuesById.get(keyIssueId);
    if (!issue) return -90;
    const fan = relationships.filter((edge) => edge.keyIssueId === keyIssueId)
      .map(({ relatedTopicId }) => normalize((topicsById.get(relatedTopicId)?.angle ?? issue.angle) - issue.angle));
    return fan.length ? normalize(issue.angle + (Math.min(...fan) + Math.max(...fan)) / 2) : issue.angle;
  };
  const outward = (angle: number): PortalLabelPlacement => {
    const radians = angle * Math.PI / 180;
    if (Math.abs(Math.sin(radians)) >= Math.SQRT1_2) return Math.sin(radians) < 0 ? "top" : "bottom";
    return Math.cos(radians) < 0 ? "left" : "right";
  };
  const circularMean = (angles: number[]) => round(Math.atan2(
    angles.reduce((total, angle) => total + Math.sin(angle * Math.PI / 180), 0),
    angles.reduce((total, angle) => total + Math.cos(angle * Math.PI / 180), 0)
  ) * 180 / Math.PI);
  const issueIdsOf = (group: ProjectedPortal[]) => [...new Set(group.map((portal) => portal.direction === "outgoing" ? portal.keyIssueId : portal.sourceKeyIssueId))];
  const preferred = visibleGroups.map((group) => group[0]!.direction === "outgoing" ? circularMean(issueIdsOf(group).map(fanTarget)) : undefined);
  const slotStep = 360 / Math.max(1, visibleGroups.length);
  const outgoingOrder = preferred.flatMap((angle, index) => angle === undefined ? [] : [index]).sort((left, right) => preferred[left]! - preferred[right]!);
  const incomingOrder = preferred.flatMap((angle, index) => angle === undefined ? [index] : []);
  let best: { cost: number; slots: number[] } | undefined;
  for (let base = 0; base < slotStep; base += 1) {
    const free = Array.from({ length: visibleGroups.length }, (_, index) => normalize(-90 + base + index * slotStep));
    const slots: number[] = [];
    let cost = 0;
    const take = (target: number, weight: number) => {
      const index = free.reduce((nearest, angle, candidate) => separation(angle, target) < separation(free[nearest]!, target) ? candidate : nearest, 0);
      cost += separation(free[index]!, target) * weight;
      return free.splice(index, 1)[0]!;
    };
    for (const index of outgoingOrder) slots[index] = take(preferred[index]!, 1);
    // Incoming portals have no Key Issue here; they lean toward the bottom only to break ties.
    for (const index of incomingOrder) slots[index] = take(90, 0.01);
    if (!best || cost < best.cost - 0.000001) best = { cost, slots };
  }
  const usedGaps = new Set<number>();
  const angleById = new Map<EntityId, number>();
  visibleGroups.forEach((group, index) => {
    const slot = best!.slots[index]!;
    const gap = gapAngles
      .filter((angle) => !usedGaps.has(angle) && separation(angle, slot) <= slotStep / 2)
      .sort((left, right) => separation(left, slot) - separation(right, slot))[0];
    if (gap !== undefined) usedGaps.add(gap);
    // Without a free gap nearby, the slot stays put, nudged off any Topic spoke it would sit on.
    const clear = (angle: number) => topicAngles.every((topic) => separation(angle, topic) >= 4);
    const nudged = Array.from({ length: 30 }, (_, step) => normalize(slot + (step % 2 ? 1 : -1) * Math.ceil(step / 2))).find(clear) ?? slot;
    angleById.set(group[0]!.id, round(gap ?? nudged));
  });
  const portals: PositionedPortal[] = visibleGroups.map((group) => {
    const first = group[0]!;
    const angle = angleById.get(first.id) ?? -90;
    return {
      id: first.id,
      linkIds: group.map(({ id }) => id),
      direction: first.direction,
      keyIssueIds: first.direction === "outgoing" ? issueIdsOf(group) : [],
      angle,
      ...pointAt(center, angle, portalRadius),
      labelSide: Math.cos(angle * Math.PI / 180) >= 0 ? "start" : "end",
      labelPlacement: outward(angle)
    };
  });

  // Incoming edges end on the central disc between two Key Issues; edges that share a gap spread across it.
  const inwardGapOf = (angle: number) => keyIssues.length > 1
    ? keyIssues.map(({ angle: issueAngle }) => normalize(issueAngle + issueStep / 2)).sort((left, right) => separation(left, angle) - separation(right, angle))[0]!
    : keyIssues.length === 1 ? normalize(keyIssues[0]!.angle + 180) : angle;
  const incomingByGap = new Map<number, PositionedPortal[]>();
  for (const portal of portals.filter(({ direction }) => direction === "incoming").sort((left, right) => left.angle - right.angle)) {
    const gapAngle = inwardGapOf(portal.angle);
    incomingByGap.set(gapAngle, [...(incomingByGap.get(gapAngle) ?? []), portal]);
  }
  const inwardAngleById = new Map<EntityId, number>();
  for (const [gapAngle, members] of incomingByGap) {
    const spread = Math.min(8, (keyIssues.length > 1 ? issueStep * 0.5 : 60) / members.length);
    members.forEach((portal, index) => inwardAngleById.set(portal.id, normalize(gapAngle + (index - (members.length - 1) / 2) * spread)));
  }

  // An outgoing edge stops short of its portal's frame so its arrowhead stays visible.
  const portalInset = 26;
  const portalEdges: PositionedEdge[] = portals.flatMap((positioned): PositionedEdge[] => {
    const gap = pointAt(center, positioned.angle, outerRadius);
    if (positioned.direction === "incoming") {
      // Runs straight in to its gap on the Topic ring, then curves to the central disc between two Key Issues.
      const first = visibleGroups.find((group) => group[0]!.id === positioned.id)![0]!;
      const inwardAngle = inwardAngleById.get(positioned.id) ?? positioned.angle;
      const inward = pointAt(center, inwardAngle, centerRadius);
      const bend = pointAt(center, positioned.angle, (outerRadius + centerRadius) / 2);
      const control = pointAt(center, inwardAngle, (outerRadius + centerRadius) / 2);
      return [{
        id: positioned.id,
        keyIssueId: first.direction === "incoming" ? first.sourceKeyIssueId : first.keyIssueId,
        relatedTopicId: positioned.id,
        start: { x: positioned.x, y: positioned.y },
        control,
        end: inward,
        path: `M ${positioned.x} ${positioned.y} L ${gap.x} ${gap.y} C ${bend.x} ${bend.y} ${control.x} ${control.y} ${inward.x} ${inward.y}`,
        emphasis: "default",
        portalDirection: "incoming",
        portalId: positioned.id,
        arrowAngle: round(normalize(inwardAngle + 180))
      }];
    }
    // One edge per Key Issue: it curves like its sibling Topic edges up to the portal's gap, then runs straight out.
    const end = pointAt(center, positioned.angle, portalRadius - portalInset);
    return positioned.keyIssueIds.flatMap((keyIssueId): PositionedEdge[] => {
      const start = issuesById.get(keyIssueId);
      if (!start) return [];
      const control = { x: round(center.x + ((start.x + gap.x) / 2 - center.x) * 0.25), y: round(center.y + ((start.y + gap.y) / 2 - center.y) * 0.25) };
      const linkId = visibleGroups.flat().find((portal) => portal.direction === "outgoing" && portal.keyIssueId === keyIssueId && positioned.linkIds.includes(portal.id))!.id;
      return [{
        id: linkId,
        keyIssueId,
        relatedTopicId: positioned.id,
        start: { x: start.x, y: start.y },
        control,
        end,
        path: `${pathFor(start, control, gap)} L ${end.x} ${end.y}`,
        emphasis: "default",
        portalDirection: "outgoing",
        portalId: positioned.id,
        arrowAngle: positioned.angle
      }];
    });
  });
  const hiddenGroups = groupPortals(projection.portals).length - visibleGroups.length;
  const portalOverflow: PositionedPortalOverflow | undefined = hiddenGroups > 0 ? { id: "portal-overflow", count: hiddenGroups } : undefined;

  return {
    size,
    center: { ...center, radius: centerRadius },
    keyIssues,
    relatedTopics,
    relationships,
    portals,
    portalEdges,
    ...(portalOverflow ? { portalOverflow } : {})
  };
}
