import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { EntityId } from "../../domain/types.js";
import type { GraphProjection, ProjectedIncomingPortal, ProjectedOutgoingPortal, ProjectionEmphasis } from "../../graph/projection.js";
import { layoutRadialProjection, type PositionedPortal } from "../../graph/radial-layout.js";
import { Icon } from "./Icon.js";
import { useMapCamera } from "./map-camera.js";
import { arrowheadTransform, discHue, wrapLabel } from "./graph-text.js";
import { DiscArtwork } from "./node-disc.js";

interface MapViewerLabels {
  mapLabel: string;
  centralTopic: string;
  keyIssue: string;
  relatedTopic: string;
  connectedVia: string;
  linkedProject: string;
  incomingLinkFrom: string;
  projectOverflow: string;
  zoomIn: string;
  zoomOut: string;
}

interface PortalNodeProps {
  portal: ProjectedIncomingPortal | ProjectedOutgoingPortal;
  position: PositionedPortal;
  accessibleName: string;
  emphasis: ProjectionEmphasis;
  /** Entrance order among the related Topics, by angle, so the wave sweeps each portal in with its neighbours. */
  ringIndex: number;
  onSelect: () => void;
  onPoint: (pointed: boolean) => void;
}

function PortalNode({ portal, position, accessibleName, emphasis, ringIndex, onSelect, onPoint }: PortalNodeProps) {
  return <button
    type="button"
    className={`map-node map-node--portal is-${portal.direction} is-${portal.availability} is-${emphasis}`}
    style={{ left: position.x, top: position.y, "--ring-index": ringIndex, "--enter-x": `${-.24 * position.x}px`, "--enter-y": `${-.24 * position.y}px` } as CSSProperties}
    aria-label={accessibleName}
    aria-pressed={emphasis === "selected"}
    onClick={onSelect}
    onPointerEnter={() => onPoint(true)}
    onPointerLeave={() => onPoint(false)}
    onFocus={() => onPoint(true)}
    onBlur={() => onPoint(false)}
    data-map-node="portal"
    data-portal-direction={portal.direction}
    data-label-placement={position.labelPlacement}
    data-entity-id={portal.id}
  >
    <span className="portal-node__icon"><Icon name="package" /></span>
    <span className="portal-node__label" dir="auto">{portal.projectTitle}</span>
    {position.linkIds.length > 1 ? <span className="portal-node__count" aria-hidden="true">{position.linkIds.length}</span> : null}
  </button>;
}

interface MapViewerProps {
  projection: GraphProjection;
  focusToken?: number;
  labels: MapViewerLabels;
  direction?: "ltr" | "rtl";
  coverImageUrl?: string;
  transitioningTopicId?: EntityId;
  onSelectKeyIssue: (id: EntityId) => void;
  onSelectRelatedTopic: (id: EntityId) => void;
  onSelectPortal: (id: EntityId) => void;
  /** The portal link whose preview card is open; its portal and edges stay highlighted. */
  selectedPortalId?: EntityId;
  onShowPortalOverflow: () => void;
  onClearSelection: () => void;
}

function emphasisClass(emphasis: ProjectionEmphasis): string {
  return `is-${emphasis}`;
}

export function MapViewer({
  projection,
  focusToken = 0,
  labels,
  direction = "ltr",
  coverImageUrl,
  transitioningTopicId,
  onSelectKeyIssue,
  onSelectRelatedTopic,
  onSelectPortal,
  selectedPortalId,
  onShowPortalOverflow,
  onClearSelection
}: MapViewerProps) {
  const artworkId = useId();
  const hue = discHue(projection.centralTopic.id);
  const centralLines = wrapLabel(projection.centralTopic.title, 13);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const edgeLayerRef = useRef<SVGSVGElement>(null);
  const edgeCameraRef = useRef<SVGGElement>(null);
  const centralNodeRef = useRef<HTMLButtonElement>(null);
  const [isEntering, setIsEntering] = useState(
    () => typeof window === "undefined" || !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
  const layout = useMemo(() => layoutRadialProjection(projection), [projection]);
  const topicRingIndices = useMemo(() => new Map(layout.relatedTopics.map(({ id }, index) => [id, index])), [layout]);
  const issueEnterStep = 8 * 38 / Math.max(1, layout.keyIssues.length);
  const topicEnterStep = 36 * 21 / Math.max(1, layout.relatedTopics.length);
  // Related Topic i sits at -90° + i steps and enters i-th; a portal takes the fractional place of its own angle in
  // that sweep, so portals, their edges and their arrowheads arrive together with the Topics beside them.
  const portalRingIndices = useMemo(() => new Map(layout.portals.map(({ id, angle }) =>
    [id, (((angle + 90) % 360 + 360) % 360) / 360 * Math.max(1, layout.relatedTopics.length)])), [layout]);
  const issueById = useMemo(() => new Map(projection.keyIssues.map((issue) => [issue.id, issue])), [projection]);
  const topicById = useMemo(
    () => new Map(projection.relatedTopics.map((topic) => [topic.id, topic])),
    [projection]
  );
  const portalById = useMemo(() => new Map(projection.portals.map((portal) => [portal.id, portal])), [projection.portals]);
  const [pointedPortalId, setPointedPortalId] = useState<EntityId>();

  // Portal edges are quiet until a selection involves them: an outgoing portal lights up with its Key Issue, and any
  // portal with its own hover, focus, or open card. Everything else dims while something is selected.
  const selectedPortalGroupId = layout.portals.find(({ linkIds }) => selectedPortalId && linkIds.includes(selectedPortalId))?.id;
  const activeIssueIds = new Set(projection.keyIssues.filter(({ emphasis }) => emphasis === "selected" || emphasis === "highlighted").map(({ id }) => id));
  const hasSelection = Boolean(selectedPortalGroupId) || [...projection.keyIssues, ...projection.relatedTopics].some(({ emphasis }) => emphasis !== "default");
  const portalEmphasis = (portal: PositionedPortal): ProjectionEmphasis =>
    portal.id === selectedPortalGroupId ? "selected"
      : portal.id === pointedPortalId || portal.keyIssueIds.some((id) => activeIssueIds.has(id)) ? "highlighted"
        : hasSelection ? "dimmed" : "default";
  const portalEdgeEmphasis = (edge: (typeof layout.portalEdges)[number]): ProjectionEmphasis =>
    edge.portalId === selectedPortalGroupId || edge.portalId === pointedPortalId || (edge.portalDirection === "outgoing" && activeIssueIds.has(edge.keyIssueId)) ? "highlighted"
      : hasSelection ? "dimmed" : "default";

  // Portal labels sit just outside the world square, on the side facing away from the center; the fit keeps them on screen.
  const fitSize = Math.max(layout.size, ...layout.portals.map(({ x, y, labelPlacement }) => labelPlacement === "left" || labelPlacement === "right"
    ? 2 * (Math.abs(x - layout.center.x) + 140)
    : 2 * (Math.abs(y - layout.center.y) + 46)));
  const { refit, applyZoom } = useMapCamera(layout.size, surfaceRef, cameraRef, edgeCameraRef, fitSize);

  useEffect(() => {
    const world = worldRef.current;
    if (!isEntering || !world) return;
    let active = true;
    let timer: number | undefined;
    const finish = () => { if (active) setIsEntering(false); };
    if (typeof world.getAnimations === "function") {
      // Waits for every entrance animation, including those of nodes that mount after this effect, so the entrance
      // never ends while something is still arriving.
      const settle = async () => {
        for (;;) {
          const running = [...world.getAnimations({ subtree: true }), ...(edgeLayerRef.current?.getAnimations({ subtree: true }) ?? [])]
            .filter((animation) => animation.playState !== "finished");
          if (!running.length || !active) break;
          await Promise.allSettled(running.map((animation) => animation.finished));
        }
        finish();
      };
      void settle();
    } else {
      const duration = Math.max(
        400,
        610 + (layout.keyIssues.length - 1) * issueEnterStep,
        830 + (layout.relatedTopics.length - 1) * topicEnterStep,
        265 + (layout.keyIssues.length + layout.relatedTopics.length - 1) * 3
      );
      timer = window.setTimeout(finish, duration);
    }
    return () => { active = false; window.clearTimeout(timer); };
  }, [isEntering, issueEnterStep, topicEnterStep, layout.keyIssues.length, layout.relatedTopics.length]);

  useLayoutEffect(() => {
    if (focusToken === 0) return;
    refit();
    centralNodeRef.current?.focus();
  }, [focusToken, refit]);

  const visibleLabelStep = Math.max(1, Math.ceil(projection.relatedTopics.length / 36));
  const orderedRelationships = [...layout.relationships].sort((left, right) => {
    const rank = (emphasis: ProjectionEmphasis) => emphasis === "highlighted" || emphasis === "selected" ? 1 : 0;
    return (
      rank(left.emphasis) - rank(right.emphasis) ||
      (topicRingIndices.get(left.relatedTopicId) ?? Number.MAX_SAFE_INTEGER) -
        (topicRingIndices.get(right.relatedTopicId) ?? Number.MAX_SAFE_INTEGER) ||
      (issueById.get(left.keyIssueId)?.ringIndex ?? Number.MAX_SAFE_INTEGER) -
        (issueById.get(right.keyIssueId)?.ringIndex ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id)
    );
  });

  return (
    <div className="map-viewer" data-map-ready="true">
      <div className="map-surface" ref={surfaceRef} aria-label={labels.mapLabel} data-zoom="normal">
        <svg ref={edgeLayerRef} className={`relationship-layer ${isEntering && !transitioningTopicId ? "is-entering" : ""} ${transitioningTopicId ? "is-topic-leaving" : ""}`} aria-hidden="true">
          <g ref={edgeCameraRef}>
            {orderedRelationships.map((edge, index) => (
              <path
                className={`map-edge ${emphasisClass(edge.emphasis)}`}
                data-edge-id={edge.id}
                d={edge.path}
                pathLength={1}
                key={edge.id}
                style={{ "--edge-index": projection.keyIssues.length + (topicRingIndices.get(edge.relatedTopicId) ?? index) } as CSSProperties}
              />
            ))}
            {layout.portalEdges.map((edge) => {
              const emphasis = portalEdgeEmphasis(edge);
              const edgeIndex = { "--edge-index": projection.keyIssues.length + (portalRingIndices.get(edge.portalId ?? "") ?? 0) } as CSSProperties;
              return <Fragment key={`portal:${edge.id}`}>
                <path className={`map-edge map-edge--portal map-edge--portal-${edge.portalDirection ?? "outgoing"} ${emphasisClass(emphasis)}`} data-edge-id={edge.id} d={edge.path} pathLength={1} style={edgeIndex} />
                <g transform={arrowheadTransform({ ...edge.end, angle: edge.arrowAngle ?? 0 })}>
                  <path className={`edge-arrowhead ${emphasisClass(emphasis)}`} d="M-6.4 -3.7 0.8 0 -6.4 3.7z" style={edgeIndex} />
                </g>
              </Fragment>;
            })}
          </g>
        </svg>
        <div className="map-camera" ref={cameraRef}>
          <div
            ref={worldRef}
            className={`map-world ${isEntering && !transitioningTopicId ? "is-entering" : ""} ${transitioningTopicId ? "is-topic-leaving" : ""}`}
            data-transition-from={projection.transition.fromTopicId}
            data-shared-topic-count={projection.transition.sharedTopicIds.length}
            key={projection.centralTopic.id}
            style={{
              width: layout.size,
              height: layout.size,
              marginInlineStart: -layout.size / 2,
              marginBlockStart: -layout.size / 2,
              "--issue-enter-step": `${issueEnterStep}ms`,
              "--topic-enter-step": `${topicEnterStep}ms`
            } as CSSProperties}
          >
            <button
              ref={centralNodeRef}
              type="button"
              className="central-node"
              style={{ left: layout.center.x, top: layout.center.y, width: layout.center.radius * 2, height: layout.center.radius * 2 }}
              aria-label={`${labels.centralTopic}: ${projection.centralTopic.title}`}
              onClick={onClearSelection}
              data-map-node="central"
              data-entity-id={projection.centralTopic.id}
            >
              <svg viewBox="0 0 184 184" aria-hidden="true">
                <g className="central-disc">
                  <DiscArtwork id={artworkId} hue={hue} coverImageUrl={coverImageUrl} />
                  <circle className="central-ring" cx="92" cy="92" r="92" />
                  <text className="central-title" direction={direction}>
                    {centralLines.map((line, index) => (
                      <tspan key={index} x="92" y={92 + (index - (centralLines.length - 1) / 2) * 20 + 6}>{line}{index < centralLines.length - 1 ? <tspan fontSize="0" xmlSpace="preserve"> </tspan> : null}</tspan>
                    ))}
                  </text>
                </g>
              </svg>
            </button>
            {layout.keyIssues.map((position) => {
              const issue = issueById.get(position.id);
              if (!issue) return null;
              const lines = wrapLabel(issue.title, 14);
              const labelX = 24 + (position.labelSide === "start" ? 27 : -27);
              const anchor = direction === "rtl" ? (position.labelSide === "start" ? "end" : "start") : position.labelSide;
              return (
                <button
                  type="button"
                  className={`map-node map-node--issue ${emphasisClass(issue.emphasis)}`}
                  style={{ left: position.x, top: position.y, "--ring-index": layout.keyIssues.indexOf(position) } as CSSProperties}
                  aria-label={`${labels.keyIssue}: ${issue.title}. ${issue.relatedTopicIds.length} ${labels.relatedTopic}.`}
                  aria-pressed={issue.emphasis === "selected"}
                  onClick={() => onSelectKeyIssue(issue.id)}
                  data-map-node="issue"
                  data-entity-id={issue.id}
                  key={issue.id}
                >
                  <svg className="node-art" viewBox="0 0 48 48" aria-hidden="true">
                    <circle className="node-halo" cx="24" cy="24" r="28" />
                    <circle className="node-core" cx="24" cy="24" r="17" />
                  </svg>
                  <span className="node-label" data-side={position.labelSide} dir="auto" aria-hidden="true">
                    <svg viewBox="0 0 48 48">
                      <text x={labelX} y="24" direction={direction} textAnchor={anchor}>
                        {lines.map((line, index) => (
                          <tspan key={index} x={labelX} dy={index ? "1.15em" : `${-(lines.length - 1) * .55 + .35}em`}>{line}{index < lines.length - 1 ? <tspan fontSize="0" xmlSpace="preserve"> </tspan> : null}</tspan>
                        ))}
                      </text>
                    </svg>
                  </span>
                </button>
              );
            })}
            {layout.relatedTopics.map((position, ringIndex) => {
              const topic = topicById.get(position.id);
              if (!topic) return null;
              const lines = wrapLabel(topic.title, 13);
              const anchor = direction === "rtl" ? (position.labelSide === "start" ? "end" : "start") : position.labelSide;
              const issueTitles = topic.keyIssueIds
                .map((id) => issueById.get(id)?.title)
                .filter((title): title is string => Boolean(title));
              const labelVisible =
                ringIndex % visibleLabelStep === 0 || topic.emphasis === "selected" || topic.emphasis === "highlighted";
              return (
                <button
                  type="button"
                  className={`map-node map-node--topic ${emphasisClass(topic.emphasis)} ${transitioningTopicId === topic.id ? "is-promoting" : ""}`}
                  style={{
                    left: position.x,
                    top: position.y,
                    "--ring-index": ringIndex,
                    "--promote-x": `${layout.center.x - position.x}px`,
                    "--promote-y": `${layout.center.y - position.y}px`,
                    "--enter-x": `${-.24 * position.x}px`,
                    "--enter-y": `${-.24 * position.y}px`
                  } as CSSProperties}
                  aria-label={`${labels.relatedTopic}: ${topic.title}. ${labels.connectedVia} ${issueTitles.join(", ")}.`}
                  aria-pressed={topic.emphasis === "selected"}
                  onClick={() => onSelectRelatedTopic(topic.id)}
                  data-map-node="topic"
                  data-entity-id={topic.id}
                  data-label-visible={labelVisible}
                  key={topic.id}
                >
                  <svg className="node-art" viewBox="0 0 48 48" aria-hidden="true">
                    <circle className="node-halo" cx="24" cy="24" r="17" />
                    <circle className="node-core" cx="24" cy="24" r="8.5" />
                  </svg>
                  <span className="node-label" data-side={position.labelSide} dir="auto" aria-hidden="true">
                    <svg viewBox="0 0 48 48">
                      <text transform={`translate(24 24) rotate(${position.labelSide === "start" ? position.angle : position.angle + 180}) translate(${position.labelSide === "start" ? 16 : -16} 0)`} direction={direction} textAnchor={anchor}>
                        {lines.map((line, index) => (
                          <tspan key={index} x="0" dy={index ? "1.15em" : lines.length > 1 ? "-.1em" : ".35em"}>{line}{index < lines.length - 1 ? <tspan fontSize="0" xmlSpace="preserve"> </tspan> : null}</tspan>
                        ))}
                      </text>
                    </svg>
                  </span>
                </button>
              );
            })}
            {layout.portals.map((position) => {
              const portal = portalById.get(position.id);
              if (!portal) return null;
              const issueTitles = [...new Set(position.linkIds.flatMap((id) => {
                const link = portalById.get(id);
                return link?.direction === "outgoing" ? [link.keyIssueTitle] : [];
              }))];
              const accessibleName = portal.direction === "incoming"
                ? `${labels.incomingLinkFrom} ${portal.projectTitle}`
                : `${labels.linkedProject}: ${portal.projectTitle}, ${labels.connectedVia} ${issueTitles.join(", ")}`;
              return <PortalNode
                portal={portal}
                position={position}
                accessibleName={accessibleName}
                emphasis={portalEmphasis(position)}
                ringIndex={portalRingIndices.get(position.id) ?? 0}
                onSelect={() => onSelectPortal(portal.id)}
                onPoint={(pointed) => setPointedPortalId((current) => pointed ? position.id : current === position.id ? undefined : current)}
                key={portal.id}
              />;
            })}
          </div>
        </div>
      </div>
      {/* Portals past the cap sit with the map controls, under Back and Home, rather than in the graph. */}
      {layout.portalOverflow ? <button
        type="button"
        className="pill map-node--portal-overflow"
        aria-label={`+${layout.portalOverflow.count} ${labels.projectOverflow}`}
        onClick={onShowPortalOverflow}
        data-map-node="portal-overflow"
      ><span className="portal-node__icon"><Icon name="package" /></span><span className="portal-overflow__count">+{layout.portalOverflow.count}</span><span>{labels.projectOverflow}</span></button> : null}
      <div className="map-zoom capsule" role="toolbar">
        <button className="tool" type="button" aria-label={labels.zoomIn} onClick={() => applyZoom("in")}>
          <Icon name="plus" />
        </button>
        <button className="tool" type="button" aria-label={labels.zoomOut} onClick={() => applyZoom("out")}>
          <Icon name="minus" />
        </button>
      </div>
    </div>
  );
}
