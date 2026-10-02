import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  easeCubicOut,
  select,
  zoom,
  zoomIdentity,
  zoomTransform,
  type ZoomBehavior
} from "d3";
import type { EntityId } from "../../domain/types.js";
import type { GraphProjection, ProjectionEmphasis } from "../../graph/projection.js";
import { layoutRadialProjection } from "../../graph/radial-layout.js";
import { Icon } from "./Icon.js";

interface MapViewerLabels {
  mapLabel: string;
  centralTopic: string;
  keyIssue: string;
  relatedTopic: string;
  connectedVia: string;
  zoomIn: string;
  zoomOut: string;
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
  onClearSelection: () => void;
}

function emphasisClass(emphasis: ProjectionEmphasis): string {
  return `is-${emphasis}`;
}

function topicHue(id: EntityId): number {
  if (id === "topic-ai") return 0;
  return [...id].reduce((total, character) => total + character.codePointAt(0)!, 0) % 360;
}

function wrapLabel(title: string, length: number): string[] {
  const lines = [""];
  for (const word of title.split(" ")) {
    const last = lines.length - 1;
    const next = `${lines[last]} ${word}`.trim();
    if (next.length > length && lines[last]) lines.push(word);
    else lines[last] = next;
  }
  return lines;
}

function scaleMap(surface: HTMLDivElement, behavior: ZoomBehavior<HTMLDivElement, unknown>, factor: number, animate = false) {
  const current = zoomTransform(surface);
  const [minimum, maximum] = behavior.scaleExtent();
  const nextScale = Math.min(maximum, Math.max(minimum, current.k * factor));
  const bounds = surface.getBoundingClientRect();
  const target = zoomIdentity
    .translate(current.x + bounds.width * (current.k - nextScale) / 2, current.y + bounds.height * (current.k - nextScale) / 2)
    .scale(nextScale);
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
  if (animate && !reduceMotion) select(surface).transition().duration(280).ease(easeCubicOut).call(behavior.transform, target);
  else select(surface).call(behavior.transform, target);
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
  onClearSelection
}: MapViewerProps) {
  const artworkId = useId();
  const hue = topicHue(projection.centralTopic.id);
  const centralLines = wrapLabel(projection.centralTopic.title, 13);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const edgeLayerRef = useRef<SVGSVGElement>(null);
  const edgeCameraRef = useRef<SVGGElement>(null);
  const centralNodeRef = useRef<HTMLButtonElement>(null);
  const zoomRef = useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(null);
  const baseScaleRef = useRef(1);
  const previousSizeRef = useRef<{ width: number; height: number } | null>(null);
  const [isEntering, setIsEntering] = useState(
    () => typeof window === "undefined" || !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
  const layout = useMemo(() => layoutRadialProjection(projection), [projection]);
  const topicRingIndices = useMemo(() => new Map(layout.relatedTopics.map(({ id }, index) => [id, index])), [layout]);
  const issueEnterStep = 8 * 38 / Math.max(1, layout.keyIssues.length);
  const topicEnterStep = 36 * 21 / Math.max(1, layout.relatedTopics.length);
  const issueById = useMemo(() => new Map(projection.keyIssues.map((issue) => [issue.id, issue])), [projection]);
  const topicById = useMemo(
    () => new Map(projection.relatedTopics.map((topic) => [topic.id, topic])),
    [projection]
  );

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const camera = cameraRef.current;
    if (!surface || !camera) return;
    const selection = select(surface);
    const behavior = zoom<HTMLDivElement, unknown>()
      .filter((event) => {
        if (event.type === "wheel") return false;
        return !(event.target instanceof Element && event.target.closest("button"));
      })
      .on("zoom", (event) => {
        const { width, height } = surface.getBoundingClientRect();
        const { x, y, k } = event.transform;
        camera.style.transform = `translate(${event.transform.x}px, ${event.transform.y}px) scale(${event.transform.k})`;
        edgeCameraRef.current?.setAttribute("transform", `translate(${x + (width - layout.size) * k / 2} ${y + (height - layout.size) * k / 2}) scale(${k})`);
        camera.style.setProperty("--graph-scale", String(event.transform.k));
        camera.style.setProperty("--graph-unscale", String(1 / event.transform.k));
        const relativeScale = event.transform.k / baseScaleRef.current;
        surface.dataset.zoom = relativeScale < 0.7 ? "low" : relativeScale > 1.35 ? "high" : "normal";
      });
    zoomRef.current = behavior;
    selection.call(behavior);

    const fit = (width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      const previous = previousSizeRef.current;
      if (previous?.width === width && previous.height === height) return;
      const previousBaseScale = baseScaleRef.current;
      const baseScale = Math.min(width / layout.size, height / layout.size);
      behavior.scaleExtent([baseScale * 0.5, baseScale * 2.4]);
      if (!previous) {
        baseScaleRef.current = baseScale;
        const transform = zoomIdentity
          .translate((width * (1 - baseScale)) / 2, (height * (1 - baseScale)) / 2)
          .scale(baseScale);
        selection.call(behavior.transform, transform);
      } else {
        const current = zoomTransform(surface);
        const relativeScale = current.k / previousBaseScale;
        const nextScale = baseScale * relativeScale;
        const previousCenterX = (previous.width * (1 - current.k)) / 2;
        const previousCenterY = (previous.height * (1 - current.k)) / 2;
        const panX = (current.x - previousCenterX) / previousBaseScale;
        const panY = (current.y - previousCenterY) / previousBaseScale;
        baseScaleRef.current = baseScale;
        const transform = zoomIdentity
          .translate((width * (1 - nextScale)) / 2 + panX * baseScale, (height * (1 - nextScale)) / 2 + panY * baseScale)
          .scale(nextScale);
        selection.call(behavior.transform, transform);
      }
      previousSizeRef.current = { width, height };
    };

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      scaleMap(surface, behavior, event.deltaY < 0 ? 1.1 : 0.9);
    };

    const bounds = surface.getBoundingClientRect();
    fit(bounds.width, bounds.height);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(([entry]) => fit(entry.contentRect.width, entry.contentRect.height));
    observer?.observe(surface);
    surface.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      observer?.disconnect();
      surface.removeEventListener("wheel", handleWheel);
      selection.on(".zoom", null);
      zoomRef.current = null;
      previousSizeRef.current = null;
    };
  }, [layout.size]);

  useEffect(() => {
    const world = worldRef.current;
    if (!isEntering || !world) return;
    let active = true;
    let timer: number | undefined;
    const finish = () => { if (active) setIsEntering(false); };
    if (typeof world.getAnimations === "function") {
      const animations = [...world.getAnimations({ subtree: true }), ...(edgeLayerRef.current?.getAnimations({ subtree: true }) ?? [])];
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(finish);
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
    const surface = surfaceRef.current;
    const behavior = zoomRef.current;
    if (surface && behavior) {
      const bounds = surface.getBoundingClientRect();
      const scale = Math.min(bounds.width / layout.size, bounds.height / layout.size);
      baseScaleRef.current = scale;
      behavior.scaleExtent([scale * 0.5, scale * 2.4]);
      select(surface).call(
        behavior.transform,
        zoomIdentity.translate((bounds.width * (1 - scale)) / 2, (bounds.height * (1 - scale)) / 2).scale(scale)
      );
    }
    centralNodeRef.current?.focus();
  }, [focusToken, layout.size]);

  const applyZoom = (operation: "in" | "out") => {
    const surface = surfaceRef.current;
    const behavior = zoomRef.current;
    if (!surface || !behavior) return;
    scaleMap(surface, behavior, operation === "in" ? 1.25 : 0.8, true);
  };

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
                <defs>
                  <clipPath id={`${artworkId}-clip`}><circle cx="92" cy="92" r="90" /></clipPath>
                  <linearGradient id={`${artworkId}-gradient`} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor={`hsl(${hue} 62% 32%)`} />
                    <stop offset="1" stopColor={`hsl(${(hue + 50) % 360} 55% 9%)`} />
                  </linearGradient>
                </defs>
                <g className="central-disc">
                  <g clipPath={`url(#${artworkId}-clip)`}>
                    <g transform="translate(-18 -18) scale(1.03)">
                      <rect width="220" height="220" fill={`url(#${artworkId}-gradient)`} />
                      {Array.from({ length: 16 }, (_, index) => (
                        <circle key={index} cx={(index * 131) % 220} cy={(index * 67) % 220} r={12 + index * 7} fill="none" stroke={`hsl(${hue} 80% 72%)`} strokeOpacity=".15" />
                      ))}
                      <rect x="121" y="44" width="39.6" height="39.6" rx="6" fill="none" stroke={`hsl(${hue} 90% 75%)`} strokeOpacity=".45" />
                    </g>
                    {coverImageUrl ? <image key={coverImageUrl} href={coverImageUrl} x="2" y="2" width="180" height="180" preserveAspectRatio="xMidYMid slice" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}
                    <circle className="central-cover-shade" cx="92" cy="92" r="92" fill={coverImageUrl ? "var(--cover-shade)" : "#0007"} />
                  </g>
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
          </div>
        </div>
      </div>
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
