import { forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3";
import type { UniverseProjectEdge, UniverseProjectNode, WorkspaceUniverse } from "../../domain/workspace.js";

/** The side of a node where its label sits. */
export type UniverseLabelPlacement = "top" | "bottom" | "left" | "right";

export interface UniverseRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PositionedUniverseNode extends UniverseProjectNode {
  x: number;
  y: number;
  radius: number;
  /** "linked" Projects link with the current one; "outer" Projects do not. */
  ring: "center" | "linked" | "outer";
  /** The node's order by distance from the center, used to stagger the entrance. */
  ringIndex: number;
  angle: number;
  labelPlacement: UniverseLabelPlacement;
  /** Estimated label box in world units; the layout keeps these and the node discs apart. */
  labelRect?: UniverseRect;
}

export interface PositionedUniverseEdge extends UniverseProjectEdge {
  path: string;
  /** Where the arrowhead tip sits and the direction it points, in degrees. */
  arrow: { x: number; y: number; angle: number };
}

export interface UniverseLayout {
  size: number;
  centerProjectId?: string;
  nodes: PositionedUniverseNode[];
  edges: PositionedUniverseEdge[];
}

export const UNIVERSE_CENTER_RADIUS = 68;
export const UNIVERSE_NODE_RADIUS = 28;
const MIN_NODE_RADIUS = 18;
const MAX_NODE_RADIUS = 40;
/** Label metrics shared with the stylesheet: 12px semibold text, at most two lines of LABEL_WIDTH, then a copies line. */
export const UNIVERSE_LABEL_WIDTH = 120;
const LABEL_GAP = 8;
const LINE_HEIGHT = 16;
const CHARACTER_WIDTH = 7.4;
const MARGIN = 36;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** As in Obsidian's default graph, a Project grows with the number of Projects it links with. */
export function universeNodeRadius(neighborCount: number): number {
  return round(Math.min(MAX_NODE_RADIUS, MIN_NODE_RADIUS + 5.5 * Math.sqrt(neighborCount)));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byTitle(left: UniverseProjectNode, right: UniverseProjectNode): number {
  return compareText(left.title.toLowerCase(), right.title.toLowerCase()) || compareText(left.projectId, right.projectId);
}

/** Two lines of up to LABEL_WIDTH, plus a quiet "n copies" line for duplicate folders. */
export function universeLabelSize(node: UniverseProjectNode): { width: number; height: number } {
  const textWidth = [...node.title].length * CHARACTER_WIDTH;
  const lines = Math.min(2, Math.max(1, Math.ceil(textWidth / UNIVERSE_LABEL_WIDTH)));
  return {
    width: Math.min(UNIVERSE_LABEL_WIDTH, Math.max(textWidth, node.duplicateCount > 1 ? 64 : 0)),
    height: (lines + (node.duplicateCount > 1 ? 1 : 0)) * LINE_HEIGHT
  };
}

function labelRect(x: number, y: number, radius: number, placement: UniverseLabelPlacement, size: { width: number; height: number }): UniverseRect {
  const offset = radius + LABEL_GAP;
  if (placement === "top") return { left: x - size.width / 2, right: x + size.width / 2, bottom: y - offset, top: y - offset - size.height };
  if (placement === "bottom") return { left: x - size.width / 2, right: x + size.width / 2, top: y + offset, bottom: y + offset + size.height };
  if (placement === "left") return { right: x - offset, left: x - offset - size.width, top: y - size.height / 2, bottom: y + size.height / 2 };
  return { left: x + offset, right: x + offset + size.width, top: y - size.height / 2, bottom: y + size.height / 2 };
}

function discRect(node: Pick<PositionedUniverseNode, "x" | "y" | "radius">, padding = 6): UniverseRect {
  return { left: node.x - node.radius - padding, right: node.x + node.radius + padding, top: node.y - node.radius - padding, bottom: node.y + node.radius + padding };
}

/** A node's disc and its label below it, as one box. */
function footprint(x: number, y: number, radius: number, label: { width: number; height: number } | undefined): UniverseRect {
  const disc = { left: x - radius - 6, right: x + radius + 6, top: y - radius - 6, bottom: y + radius + 6 };
  if (!label) return disc;
  return { left: Math.min(disc.left, x - label.width / 2 - 4), right: Math.max(disc.right, x + label.width / 2 + 4), top: disc.top, bottom: y + radius + LABEL_GAP + label.height + 4 };
}

/** A small deterministic random source, so the same Registry always settles into the same picture. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

interface SimulatedNode extends SimulationNodeDatum {
  id: string;
  radius: number;
  label: { width: number; height: number } | undefined;
  fixed: boolean;
}

/** Pushes overlapping footprints apart along their shallower axis until none overlap; fixed nodes never move. */
function separate(nodes: SimulatedNode[], passes = 160): void {
  for (let pass = 0; pass < passes; pass += 1) {
    let moved = false;
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        const a = nodes[left]!;
        const b = nodes[right]!;
        const boxA = footprint(a.x!, a.y!, a.radius, a.label);
        const boxB = footprint(b.x!, b.y!, b.radius, b.label);
        const overlapX = Math.min(boxA.right, boxB.right) - Math.max(boxA.left, boxB.left);
        const overlapY = Math.min(boxA.bottom, boxB.bottom) - Math.max(boxA.top, boxB.top);
        if (overlapX <= 0 || overlapY <= 0) continue;
        moved = true;
        const [shareA, shareB] = a.fixed ? [0, 1] : b.fixed ? [1, 0] : [0.5, 0.5];
        if (overlapX < overlapY) {
          const sign = (b.x! - a.x! || 1) > 0 ? 1 : -1;
          a.x! -= sign * (overlapX + 1) * shareA;
          b.x! += sign * (overlapX + 1) * shareB;
        } else {
          const sign = ((boxB.top + boxB.bottom) - (boxA.top + boxA.bottom) || 1) > 0 ? 1 : -1;
          a.y! -= sign * (overlapY + 1) * shareA;
          b.y! += sign * (overlapY + 1) * shareB;
        }
      }
    }
    if (!moved) return;
  }
}

/** Counts the sampled points of a curve that pass over another node's disc or label. */
function curveCollisions(start: { x: number; y: number }, control: { x: number; y: number }, end: { x: number; y: number }, obstacles: UniverseRect[]): number {
  let hits = 0;
  for (let step = 1; step < 24; step += 1) {
    const t = step / 24;
    const x = (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * control.x + t * t * end.x;
    const y = (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * control.y + t * t * end.y;
    if (obstacles.some((rect) => x > rect.left && x < rect.right && y > rect.top && y < rect.bottom)) hits += 1;
  }
  return hits;
}

function edgePath(source: PositionedUniverseNode, target: PositionedUniverseNode, center: { x: number; y: number }, nodes: PositionedUniverseNode[]): Omit<PositionedUniverseEdge, keyof UniverseProjectEdge> {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const normal = { x: -dy / length, y: dx / length };
  const mid = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
  // Edges run nearly straight, as in a network graph, and bend further only when a straighter curve would cross
  // another Project's disc or label; a small offset to the left of travel keeps the two directions of a pair apart.
  const touchesCenter = source.ring === "center" || target.ring === "center";
  const away = touchesCenter ? 1 : Math.sign(normal.x * (mid.x - center.x) + normal.y * (mid.y - center.y)) || 1;
  const obstacles = nodes
    .filter((node) => node !== source && node !== target)
    .flatMap((node) => [discRect(node, 8), ...(node.labelRect ? [node.labelRect] : [])]);
  const factors = [0.04, 0.14, -0.14, 0.26, -0.26, 0.4, -0.4, 0.6];
  let best: { control: { x: number; y: number }; hits: number } | undefined;
  for (const factor of factors) {
    const bend = factor * length * away + 10;
    const control = { x: mid.x + normal.x * bend, y: mid.y + normal.y * bend };
    const hits = curveCollisions(source, control, target, obstacles);
    if (!best || hits < best.hits) best = { control, hits };
    if (!hits) break;
  }
  const control = best!.control;
  const toward = (from: PositionedUniverseNode, inset: number) => {
    const distance = Math.max(1, Math.hypot(control.x - from.x, control.y - from.y));
    return { x: round(from.x + (control.x - from.x) / distance * inset), y: round(from.y + (control.y - from.y) / distance * inset) };
  };
  const start = toward(source, source.radius + 3);
  const end = toward(target, target.radius + 6);
  return {
    path: `M ${start.x} ${start.y} Q ${round(control.x)} ${round(control.y)} ${end.x} ${end.y}`,
    arrow: { x: end.x, y: end.y, angle: round(Math.atan2(end.y - control.y, end.x - control.x) * 180 / Math.PI) }
  };
}

/**
 * A deterministic force layout in the spirit of Obsidian's graph: links pull related Projects into clusters, every
 * Project pushes the others away, and a node grows with the number of Projects it links with. The current Project is
 * pinned near the middle; Projects with no links drift to the edge of the graph. The simulation runs to rest
 * before the first paint, from fixed starting positions and a seeded random source, so the same Registry always gives
 * the same picture. A final pass removes any overlap between discs and labels.
 */
export function layoutUniverse(universe: WorkspaceUniverse, currentProjectId?: string): UniverseLayout {
  const ordered = [...universe.nodes].sort(byTitle);
  if (!ordered.length) return { size: 0, nodes: [], edges: [] };
  const known = new Set(ordered.map(({ projectId }) => projectId));
  const pairs = universe.edges.filter(({ sourceProjectId, targetProjectId }) =>
    sourceProjectId !== targetProjectId && known.has(sourceProjectId) && known.has(targetProjectId));
  const neighborsOf = new Map<string, Set<string>>(ordered.map(({ projectId }) => [projectId, new Set()]));
  for (const { sourceProjectId, targetProjectId } of pairs) {
    neighborsOf.get(sourceProjectId)!.add(targetProjectId);
    neighborsOf.get(targetProjectId)!.add(sourceProjectId);
  }
  const degree = (projectId: string) => neighborsOf.get(projectId)?.size ?? 0;
  const centerNode = ordered.find(({ projectId }) => projectId === currentProjectId)
    ?? [...ordered].sort((left, right) => degree(right.projectId) - degree(left.projectId) || byTitle(left, right))[0]!;
  const centerNeighbors = neighborsOf.get(centerNode.projectId)!;
  const connected = ordered.filter((node) => node !== centerNode && degree(node.projectId) > 0);
  const loners = ordered.filter((node) => node !== centerNode && degree(node.projectId) === 0);

  // Linked Projects start on a ring around the center and the rest further out, in title order.
  const startRing = (nodes: UniverseProjectNode[], radius: number, offset: number): SimulatedNode[] => nodes.map((node, index) => {
    const angle = (-90 + offset + 360 * index / Math.max(1, nodes.length)) * Math.PI / 180;
    return { id: node.projectId, radius: universeNodeRadius(degree(node.projectId)), label: universeLabelSize(node), fixed: false, x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });
  const center: SimulatedNode = { id: centerNode.projectId, radius: UNIVERSE_CENTER_RADIUS, label: undefined, fixed: true, x: 0, y: 0, fx: 0, fy: 0 };
  const near = connected.filter(({ projectId }) => centerNeighbors.has(projectId));
  const far = connected.filter(({ projectId }) => !centerNeighbors.has(projectId));
  const simulated = [center, ...startRing(near, 220, 0), ...startRing(far, 420, 180 / Math.max(1, far.length)), ...startRing(loners, 560, 90 / Math.max(1, loners.length))];
  const byId = new Map(simulated.map((node) => [node.id, node]));
  const links = pairs.map(({ sourceProjectId, targetProjectId }) => ({ source: byId.get(sourceProjectId)!, target: byId.get(targetProjectId)! }));
  const reach = (node: SimulatedNode) => Math.max(node.radius + 18, (node.label?.width ?? 0) / 2 + 12);

  const simulation = forceSimulation<SimulatedNode>(simulated)
    .randomSource(seededRandom(ordered.length * 7919 + pairs.length))
    .force("link", forceLink<SimulatedNode, { source: SimulatedNode; target: SimulatedNode }>(links)
      .distance(({ source, target }) => source.radius + target.radius + 30)
      .strength(({ source, target }) => Math.min(1, 1.5 / Math.min(degree(source.id), degree(target.id)))))
    .force("charge", forceManyBody<SimulatedNode>().strength((node) => -450 - node.radius * 5).distanceMax(1800))
    .force("collide", forceCollide<SimulatedNode>(reach).strength(0.9).iterations(2))
    // A gentle pull to the middle keeps separate clusters together; Projects without links rest on an orbit sized for
    // the linked graph, so they stay just outside it instead of drifting off.
    .force("x", forceX<SimulatedNode>(0).strength(0.035))
    .force("y", forceY<SimulatedNode>(0).strength(0.035))
    .force("orbit", forceRadial<SimulatedNode>(Math.sqrt(connected.length + 1) * 72 + 130).strength((node) => degree(node.id) || node.fixed ? 0 : 0.4))
    .stop();
  const ticks = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()));
  for (let tick = 0; tick < ticks; tick += 1) simulation.tick();
  separate(simulated);
  const all = simulated;

  // The world is the square around the graph's bounding box, so a lopsided graph still fills the screen.
  const boxes = all.map((node) => footprint(node.x!, node.y!, node.radius, node.label));
  const bounds = {
    left: Math.min(...boxes.map(({ left }) => left)), right: Math.max(...boxes.map(({ right }) => right)),
    top: Math.min(...boxes.map(({ top }) => top)), bottom: Math.max(...boxes.map(({ bottom }) => bottom))
  };
  const size = round(Math.max(560, Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top) + MARGIN * 2));
  const offset = { x: size / 2 - (bounds.left + bounds.right) / 2, y: size / 2 - (bounds.top + bounds.bottom) / 2 };
  const byProject = new Map(ordered.map((node) => [node.projectId, node]));
  const distanceFromCenter = (node: SimulatedNode) => Math.hypot(node.x!, node.y!);
  const nodes: PositionedUniverseNode[] = [...all]
    .sort((left, right) => Number(right.fixed) - Number(left.fixed) || distanceFromCenter(left) - distanceFromCenter(right) || compareText(left.id, right.id))
    .map((node, ringIndex) => {
      const x = round(node.x! + offset.x);
      const y = round(node.y! + offset.y);
      const ring = node.fixed ? "center" as const : centerNeighbors.has(node.id) ? "linked" as const : "outer" as const;
      const placed: PositionedUniverseNode = { ...byProject.get(node.id)!, x, y, radius: node.radius, ring, ringIndex, angle: round(Math.atan2(node.y!, node.x!) * 180 / Math.PI), labelPlacement: "bottom" };
      return node.label ? { ...placed, labelRect: labelRect(x, y, node.radius, "bottom", node.label) } : placed;
    });
  const positioned = new Map(nodes.map((node) => [node.projectId, node]));
  const edges = pairs.map((edge) => ({ ...edge, ...edgePath(positioned.get(edge.sourceProjectId)!, positioned.get(edge.targetProjectId)!, { x: offset.x, y: offset.y }, nodes) }))
    .sort((left, right) => compareText(left.id, right.id));
  return { size, centerProjectId: centerNode.projectId, nodes, edges };
}

/**
 * Labels grow by `scale` around the point where they meet their disc, so they stay readable when the fitted camera is
 * small. Grown labels can reach other Projects, so only labels that clear every disc and every label already kept
 * are shown: the selected Project first, then larger (better linked) Projects, then the order nearest the center.
 * A grown label must also stay inside the world square of `size`, which the camera fits on screen. At scale 1 the
 * layout already keeps every label clear, so all of them are shown.
 */
export function visibleUniverseLabels(nodes: PositionedUniverseNode[], scale: number, selectedId?: string, size = Infinity): Set<string> {
  const labelled = nodes.filter((node) => node.labelRect);
  if (scale <= 1) return new Set(labelled.map(({ projectId }) => projectId));
  const grow = (node: PositionedUniverseNode): UniverseRect => {
    const rect = node.labelRect!;
    const width = (rect.right - rect.left) * scale;
    const height = (rect.bottom - rect.top) * scale;
    const middleX = (rect.left + rect.right) / 2;
    const middleY = (rect.top + rect.bottom) / 2;
    if (node.labelPlacement === "bottom") return { left: middleX - width / 2, right: middleX + width / 2, top: rect.top, bottom: rect.top + height };
    if (node.labelPlacement === "top") return { left: middleX - width / 2, right: middleX + width / 2, top: rect.bottom - height, bottom: rect.bottom };
    if (node.labelPlacement === "left") return { left: rect.right - width, right: rect.right, top: middleY - height / 2, bottom: middleY + height / 2 };
    return { left: rect.left, right: rect.left + width, top: middleY - height / 2, bottom: middleY + height / 2 };
  };
  const overlaps = (a: UniverseRect, b: UniverseRect) => Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
  const ordered = [...labelled].sort((left, right) =>
    Number(right.projectId === selectedId) - Number(left.projectId === selectedId) || right.radius - left.radius || left.ringIndex - right.ringIndex);
  const kept: UniverseRect[] = [];
  const visible = new Set<string>();
  for (const node of ordered) {
    const rect = grow(node);
    const outside = rect.left < 0 || rect.top < 0 || rect.right > size || rect.bottom > size;
    const blocked = outside || kept.some((other) => overlaps(rect, other)) ||
      nodes.some((other) => other !== node && overlaps(rect, discRect(other, 2)));
    if (blocked && node.projectId !== selectedId) continue;
    kept.push(rect);
    visible.add(node.projectId);
  }
  return visible;
}

/** Spatial arrow-key navigation: the nearest node in the pressed direction, favoring nodes straight ahead. */
export function nextUniverseNode(nodes: Array<Pick<PositionedUniverseNode, "projectId" | "x" | "y">>, fromId: string, key: string): string | undefined {
  const from = nodes.find(({ projectId }) => projectId === fromId);
  const direction = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[key];
  if (!from || !direction) return undefined;
  let best: { id: string; score: number } | undefined;
  for (const node of nodes) {
    if (node.projectId === fromId) continue;
    const dx = node.x - from.x;
    const dy = node.y - from.y;
    const along = dx * direction[0]! + dy * direction[1]!;
    if (along <= 1) continue;
    const across = Math.abs(dx * direction[1]! - dy * direction[0]!);
    if (across > along * 2.2) continue;
    const score = along + across * 2;
    if (!best || score < best.score || (score === best.score && node.projectId < best.id)) best = { id: node.projectId, score };
  }
  return best?.id;
}

/** Projects whose folder cannot be read right now; they stay in the Universe in a muted state. */
export function isUnavailableProject(node: Pick<UniverseProjectNode, "status">): boolean {
  return node.status === "missing" || node.status === "mismatch" || node.status === "unreadable";
}

export function universeLinkCounts(universe: WorkspaceUniverse, projectId: string): { outgoing: number; incoming: number } {
  let outgoing = 0;
  let incoming = 0;
  for (const edge of universe.edges) {
    if (edge.sourceProjectId === projectId) outgoing += edge.count;
    if (edge.targetProjectId === projectId) incoming += edge.count;
  }
  return { outgoing, incoming };
}
