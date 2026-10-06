import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { UniverseProjectNode, WorkspaceProjectStatus, WorkspaceUniverse } from "../../domain/workspace.js";
import { Icon, Spinner } from "./Icon.js";
import { useMapCamera } from "./map-camera.js";
import { arrowheadTransform, discHue, wrapLabel } from "./graph-text.js";
import { DiscArtwork } from "./node-disc.js";
import { isUnavailableProject, layoutUniverse, nextUniverseNode, universeLinkCounts, visibleUniverseLabels, type PositionedUniverseNode } from "./universe-layout.js";

export interface UniverseLabels {
  mapLabel: string;
  loading: string;
  empty: string;
  single: string;
  error: string;
  retry: string;
  zoomIn: string;
  zoomOut: string;
  closePreview: string;
  project: string;
  currentProject: string;
  openProject: string;
  projectActions: string;
  removeFromRecent: string;
  forgetProject: string;
  locate: string;
  noDescription: string;
  noLinks: string;
  /** Templates with a {count} placeholder. */
  outgoing: string;
  incoming: string;
  copies: string;
  links: string;
  linkedProjects: string;
  outgoingHeading: string;
  incomingHeading: string;
  /** Available is the default state and is never named; duplicates are described by their copy count instead. */
  statuses: Record<Exclude<WorkspaceProjectStatus, "available" | "duplicate">, string>;
}

function statusText(node: UniverseProjectNode, labels: UniverseLabels): string | undefined {
  return node.status === "available" || node.status === "duplicate" ? undefined : labels.statuses[node.status];
}

function formatCount(template: string, count: number, locale: string): string {
  return template.replace("{count}", new Intl.NumberFormat(locale).format(count));
}

/**
 * Universe labels are 12px. On narrow screens, where the fitted camera is small, they stay at least 11px on screen,
 * up to 3.5 times their size; wider screens keep labels at their own size.
 */
const LABEL_PX = 12;
const MIN_LABEL_PX = 11;
const MAX_LABEL_SCALE = 3.5;
const NARROW_SURFACE = 600;

function nodeName(node: UniverseProjectNode, labels: UniverseLabels, locale: string, current: boolean): string {
  return [
    node.title,
    current ? labels.currentProject : undefined,
    statusText(node, labels),
    node.duplicateCount > 1 ? formatCount(labels.copies, node.duplicateCount, locale) : undefined
  ].filter(Boolean).join(", ");
}

/** One linked Project in the side panel: selecting the row shows it on the graph; the trailing button opens it. */
function LinkedProjectRow({ node, count, labels, locale, artworkId, onSelect, onOpen }: {
  node: UniverseProjectNode;
  count: number;
  labels: UniverseLabels;
  locale: string;
  artworkId: string;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const unavailable = isUnavailableProject(node);
  const detail = [statusText(node, labels), count > 1 ? formatCount(labels.links, count, locale) : undefined].filter(Boolean).join(" · ");
  return <li className={`universe-link${unavailable ? " is-unavailable" : ""}`}>
    <button type="button" className="universe-link__main" onClick={onSelect}>
      <svg className="universe-link__disc" viewBox="0 0 184 184" aria-hidden="true"><DiscArtwork id={artworkId} hue={discHue(node.projectId)} coverImageUrl={node.coverUrl} shade={false} /></svg>
      <span className="universe-link__text"><span dir="auto">{node.title}</span>{detail ? <small>{detail}</small> : null}</span>
    </button>
    <button type="button" className="tool" aria-label={`${unavailable ? labels.locate : labels.openProject}: ${node.title}`} data-tooltip={unavailable ? labels.locate : labels.openProject} data-tooltip-side="top" data-tooltip-align="end" onClick={onOpen}><Icon name={unavailable ? "folder" : "open"} /></button>
  </li>;
}

/**
 * The Universe side panel: the selected Project (or the current one) in the Knowledge panel's hero and card, its
 * actions, and the Projects it links with, each of which can be shown on the graph or opened directly.
 */
export function UniverseProjectPanel({ node, universe, labels, locale, direction, current, active, onOpen, onRemoveFromRecent, onForget, onLocate, onSelectProject, onOpenProject }: {
  node: UniverseProjectNode;
  universe: WorkspaceUniverse;
  labels: UniverseLabels;
  locale: string;
  direction?: "ltr" | "rtl";
  /** The Project open in this window. */
  current?: boolean;
  /** This exact folder is the active one, so it cannot be hidden or forgotten from here. */
  active?: boolean;
  onOpen: () => void;
  onRemoveFromRecent: () => void;
  onForget: () => void;
  onLocate: () => void;
  onSelectProject: (projectId: string) => void;
  onOpenProject: (projectId: string) => void;
}) {
  const artworkId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { outgoing, incoming } = universeLinkCounts(universe, node.projectId);
  const unavailable = isUnavailableProject(node);
  const status = statusText(node, labels);
  const meta = [
    outgoing || incoming ? `${formatCount(labels.outgoing, outgoing, locale)} · ${formatCount(labels.incoming, incoming, locale)}` : labels.noLinks,
    node.duplicateCount > 1 ? formatCount(labels.copies, node.duplicateCount, locale) : undefined
  ].filter(Boolean).join(" · ");
  const nodesById = new Map(universe.nodes.map((entry) => [entry.projectId, entry]));
  const linked = (direction: "outgoing" | "incoming") => universe.edges
    .filter((edge) => direction === "outgoing" ? edge.sourceProjectId === node.projectId : edge.targetProjectId === node.projectId)
    .flatMap((edge) => {
      const other = nodesById.get(direction === "outgoing" ? edge.targetProjectId : edge.sourceProjectId);
      return other && other.projectId !== node.projectId ? [{ node: other, count: edge.count }] : [];
    })
    .sort((left, right) => left.node.title.localeCompare(right.node.title, locale));
  const groups = [
    { key: "outgoing", title: labels.outgoingHeading, rows: linked("outgoing") },
    { key: "incoming", title: labels.incomingHeading, rows: linked("incoming") }
  ].filter(({ rows }) => rows.length);
  const hue = discHue(node.projectId);

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenuOpen(false);
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closeMenu(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [closeMenu, menuOpen]);

  const menuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)")];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Escape") {
      // Escape closes only the menu; the selection stays until the next Escape.
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === "Tab") {
      closeMenu(false);
    }
  };

  return <div className="universe-panel" dir={direction}>
    <div
      className={`panel-hero${node.coverUrl ? " panel-hero--cover" : ""}`}
      style={node.coverUrl ? undefined : { background: `radial-gradient(circle at 78% 22%, hsl(${hue} 70% 62% / 0.28), transparent 42%), linear-gradient(135deg, hsl(${hue} 52% 30%), hsl(${hue} 58% 9%) 78%)` }}
    >
      {node.coverUrl ? <img className="panel-cover" key={node.coverUrl} src={node.coverUrl} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}
      <div>
        {current || status ? <span className="home-badge home-badge--hero">{current ? <Icon name="universe" /> : <Icon name="alert" />}{current ? labels.currentProject : status}</span> : null}
        <h1 dir="auto" tabIndex={-1}>{node.title}</h1>
        <p>{meta}</p>
      </div>
    </div>
    <section className="panel-card universe-panel__card">
      <p dir="auto">{node.description ?? labels.noDescription}</p>
      <div className="universe-details__actions">
        {unavailable
          ? <button className="pill pill--accent" type="button" onClick={onLocate}><Icon name="folder" />{labels.locate}</button>
          : <button className="pill pill--accent" type="button" onClick={onOpen}>{labels.openProject}</button>}
        <div className="universe-details__more">
          <button ref={triggerRef} type="button" className="tool" aria-label={labels.projectActions} data-tooltip={labels.projectActions} data-tooltip-side="top" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><Icon name="more" /></button>
          {menuOpen ? <div ref={menuRef} className="recent-project-menu universe-details__menu" role="menu" aria-label={labels.projectActions} onKeyDown={menuKeyDown}>
            <button type="button" role="menuitem" tabIndex={-1} disabled={active} onClick={() => { closeMenu(false); onRemoveFromRecent(); }}>{labels.removeFromRecent}</button>
            {unavailable ? null : <button type="button" role="menuitem" tabIndex={-1} onClick={() => { closeMenu(false); onLocate(); }}>{labels.locate}</button>}
            <button type="button" role="menuitem" tabIndex={-1} className="is-danger" disabled={active} onClick={() => { closeMenu(false); onForget(); }}>{labels.forgetProject}</button>
          </div> : null}
        </div>
      </div>
    </section>
    {/* Without links the hero already says so, and the section is left out. */}
    {groups.length ? <section className="knowledge-sections universe-panel__links" aria-label={labels.linkedProjects}>
      <h2>{labels.linkedProjects}</h2>
      {groups.map((group) => <section className="knowledge-section" key={group.key}>
        <h3>{group.title}</h3>
        <ul className="universe-links">
          {group.rows.map((row, index) => <LinkedProjectRow
            key={row.node.projectId}
            node={row.node}
            count={row.count}
            labels={labels}
            locale={locale}
            artworkId={`${artworkId}-${group.key}-${index}`}
            onSelect={() => onSelectProject(row.node.projectId)}
            onOpen={() => onOpenProject(row.node.projectId)}
          />)}
        </ul>
      </section>)}
    </section> : null}
  </div>;
}

function UniverseEmpty({ loading, error, text, retry, onRetry }: { loading?: boolean; error?: boolean; text: string; retry: string; onRetry: () => void }) {
  return <div className="empty-region universe-empty" data-loading={loading ? "true" : undefined} role={error ? "alert" : "status"}>
    <span className="empty-orbit" aria-hidden="true"><Icon name="universe" className="icon empty-orbit__icon" /></span>
    <div className="empty-region__copy">
      <p>{loading ? <Spinner /> : null}{text}</p>
      {error ? <button className="pill" type="button" onClick={onRetry}>{retry}</button> : null}
    </div>
  </div>;
}

function CenterDisc({ node, artworkId, direction }: { node: PositionedUniverseNode; artworkId: string; direction: "ltr" | "rtl" }) {
  const lines = wrapLabel(node.title, 13);
  const visible = lines.length > 3 ? [...lines.slice(0, 2), `${lines[2]}…`] : lines;
  return <svg viewBox="0 0 184 184" aria-hidden="true">
    <g className="central-disc">
      <DiscArtwork id={artworkId} hue={discHue(node.projectId)} coverImageUrl={node.coverUrl} />
      <circle className="central-ring" cx="92" cy="92" r="92" />
      <text className="central-title" direction={direction}>
        {visible.map((line, index) => <tspan key={index} x="92" y={92 + (index - (visible.length - 1) / 2) * 20 + 6}>{line}{index < visible.length - 1 ? <tspan fontSize="0" xmlSpace="preserve"> </tspan> : null}</tspan>)}
      </text>
    </g>
  </svg>;
}

export function UniverseView({ universe, loading, error, currentProjectId, selectedProjectId, focusToken = 0, labels, locale, direction = "ltr", onRetry, onSelect, onOpen }: {
  universe?: WorkspaceUniverse;
  loading: boolean;
  error?: string;
  currentProjectId?: string;
  selectedProjectId?: string;
  focusToken?: number;
  labels: UniverseLabels;
  locale: string;
  direction?: "ltr" | "rtl";
  onRetry: () => void;
  onSelect: (projectId: string | undefined) => void;
  onOpen: (projectId: string) => void;
}) {
  if (!universe?.nodes.length || universe.nodes.length < 2) {
    if (loading && !universe) return <UniverseEmpty loading text={labels.loading} retry={labels.retry} onRetry={onRetry} />;
    if (error) return <UniverseEmpty error text={labels.error} retry={labels.retry} onRetry={onRetry} />;
    return <UniverseEmpty text={universe?.nodes.length ? labels.single : labels.empty} retry={labels.retry} onRetry={onRetry} />;
  }
  return <UniverseGraph universe={universe} currentProjectId={currentProjectId} selectedProjectId={selectedProjectId} focusToken={focusToken} labels={labels} locale={locale} direction={direction} onSelect={onSelect} onOpen={onOpen} />;
}

function UniverseGraph({ universe, currentProjectId, selectedProjectId, focusToken, labels, locale, direction, onSelect, onOpen }: {
  universe: WorkspaceUniverse;
  currentProjectId?: string;
  selectedProjectId?: string;
  focusToken: number;
  labels: UniverseLabels;
  locale: string;
  direction: "ltr" | "rtl";
  onSelect: (projectId: string | undefined) => void;
  onOpen: (projectId: string) => void;
}) {
  const artworkId = useId();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const edgeLayerRef = useRef<SVGSVGElement>(null);
  const edgeCameraRef = useRef<SVGGElement>(null);
  const layout = useMemo(() => layoutUniverse(universe, currentProjectId), [currentProjectId, universe]);
  // On phones, labels keep a readable size at the fitted zoom: they grow against the zoom, in steps, and labels that
  // would then reach another Project or leave the graph hide until the camera zooms in.
  const [labelScale, setLabelScale] = useState(1);
  const handleScale = useCallback((scale: number) => {
    const narrow = (surfaceRef.current?.clientWidth ?? Infinity) < NARROW_SURFACE;
    setLabelScale(narrow ? Math.round(Math.min(MAX_LABEL_SCALE, Math.max(1, MIN_LABEL_PX / (LABEL_PX * scale))) * 20) / 20 : 1);
  }, []);
  const { refit, applyZoom } = useMapCamera(layout.size, surfaceRef, cameraRef, edgeCameraRef, layout.size, handleScale);
  const [isEntering, setIsEntering] = useState(() => !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const [focusId, setFocusId] = useState<string>();
  const ringNodes = layout.nodes.filter(({ ring }) => ring !== "center");
  const enterStep = 36 * 21 / Math.max(1, ringNodes.length);
  // Ring node i starts entering at 300ms + i steps and is in place about 240ms later; the central disc is in place by
  // 300ms. Each edge starts drawing once the later of its two Projects is in place, and its arrowhead follows as the
  // line finishes.
  const nodeIndices = useMemo(() => new Map(layout.nodes.map(({ projectId }, index) => [projectId, index])), [layout]);
  const arrivalOf = (projectId: string) => {
    const index = nodeIndices.get(projectId) ?? 0;
    return index === 0 ? 300 : 300 + (index - 1) * enterStep + 240;
  };
  const lastArrival = 300 + Math.max(0, ringNodes.length - 1) * enterStep + 240;
  const rovingId = layout.nodes.some(({ projectId }) => projectId === focusId) ? focusId : selectedProjectId ?? layout.centerProjectId;

  const neighbors = useMemo(() => {
    const result = new Map<string, Set<string>>();
    for (const { sourceProjectId, targetProjectId } of universe.edges) {
      if (!result.has(sourceProjectId)) result.set(sourceProjectId, new Set());
      if (!result.has(targetProjectId)) result.set(targetProjectId, new Set());
      result.get(sourceProjectId)!.add(targetProjectId);
      result.get(targetProjectId)!.add(sourceProjectId);
    }
    return result;
  }, [universe.edges]);
  const selected = layout.nodes.some(({ projectId }) => projectId === selectedProjectId) ? selectedProjectId : undefined;
  const nodeEmphasis = (projectId: string) => !selected ? "default" : projectId === selected ? "selected" : neighbors.get(selected)?.has(projectId) ? "default" : "dimmed";
  const edgeEmphasis = (sourceId: string, targetId: string) => !selected ? "default" : sourceId === selected || targetId === selected ? "highlighted" : "dimmed";
  const visibleLabels = useMemo(() => visibleUniverseLabels(layout.nodes, labelScale, selected, layout.size), [labelScale, layout.nodes, layout.size, selected]);

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
      timer = window.setTimeout(finish, Math.max(830 + (ringNodes.length - 1) * enterStep, lastArrival + 560));
    }
    return () => { active = false; window.clearTimeout(timer); };
  }, [enterStep, isEntering, lastArrival, ringNodes.length]);

  // Focusing a node also makes it the roving tab stop, through its onFocus handler.
  const focusNode = useCallback((projectId: string | undefined) => {
    if (!projectId) return;
    [...(surfaceRef.current?.querySelectorAll<HTMLButtonElement>("[data-universe-project-id]") ?? [])]
      .find((element) => element.dataset.universeProjectId === projectId)?.focus();
  }, []);

  useLayoutEffect(() => {
    if (focusToken === 0) return;
    refit();
    focusNode(layout.centerProjectId);
  }, [focusNode, focusToken, layout.centerProjectId, refit]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>("[data-universe-project-id]") : null;
    const projectId = target?.dataset.universeProjectId;
    if (!projectId) return;
    if (event.key === "Enter") {
      // Enter shows the details card; Enter again on the selected Project opens it.
      event.preventDefault();
      if (selected === projectId && !isUnavailableProject(layout.nodes.find((node) => node.projectId === projectId)!)) onOpen(projectId);
      else onSelect(projectId);
      return;
    }
    const next = event.key === "Home" ? layout.nodes[0]?.projectId
      : event.key === "End" ? layout.nodes.at(-1)?.projectId
        : nextUniverseNode(layout.nodes, projectId, event.key);
    if (!["Home", "End", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    focusNode(next);
  };

  const nodeProps = (node: PositionedUniverseNode, index: number) => ({
    type: "button" as const,
    "aria-label": nodeName(node, labels, locale, node.projectId === currentProjectId),
    "aria-pressed": node.projectId === selected,
    tabIndex: node.projectId === rovingId ? 0 : -1,
    "data-universe-node": "true",
    "data-universe-project-id": node.projectId,
    "data-universe-index": index,
    onClick: () => onSelect(node.projectId === selected ? undefined : node.projectId),
    onDoubleClick: () => { if (!isUnavailableProject(node)) onOpen(node.projectId); },
    onFocus: () => setFocusId(node.projectId)
  });

  return <div className="map-viewer universe-view" data-map-ready="true">
    <div ref={surfaceRef} className="map-surface universe-surface" role="group" aria-label={labels.mapLabel} data-zoom="normal" onKeyDown={handleKeyDown}>
      <svg ref={edgeLayerRef} className={`relationship-layer universe-edges${isEntering ? " is-entering" : ""}`} aria-hidden="true">
        <g ref={edgeCameraRef}>
          {layout.edges.map((edge) => {
            const emphasis = edgeEmphasis(edge.sourceProjectId, edge.targetProjectId);
            const delay = { "--edge-delay": `${Math.round(Math.max(arrivalOf(edge.sourceProjectId), arrivalOf(edge.targetProjectId)))}ms` } as CSSProperties;
            // Each arrowhead is its own element, so it can join its edge as soon as that edge has drawn in.
            return <Fragment key={edge.id}>
              <path
                className={`map-edge universe-edge is-${emphasis}`}
                data-edge-id={edge.id}
                d={edge.path}
                pathLength={1}
                style={delay}
              />
              <g transform={arrowheadTransform(edge.arrow)}>
                <path className={`edge-arrowhead universe-arrowhead is-${emphasis}`} d="M-5 -2.7 0.8 0 -5 2.7z" style={delay} />
              </g>
            </Fragment>;
          })}
        </g>
      </svg>
      <div className="map-camera" ref={cameraRef}>
        <div
          ref={worldRef}
          className={`map-world universe-world${isEntering ? " is-entering" : ""}`}
          style={{
            width: layout.size,
            height: layout.size,
            marginInlineStart: -layout.size / 2,
            marginBlockStart: -layout.size / 2,
            "--topic-enter-step": `${enterStep}ms`,
            "--universe-label-scale": labelScale
          } as CSSProperties}
        >
          {layout.nodes.map((node, index) => {
            const unavailable = isUnavailableProject(node);
            const emphasis = nodeEmphasis(node.projectId);
            if (node.ring === "center") return <button
              {...nodeProps(node, index)}
              key={node.projectId}
              className={`central-node universe-node universe-node--center is-${emphasis}${unavailable ? " is-unavailable" : ""}`}
              style={{ left: node.x, top: node.y, width: node.radius * 2, height: node.radius * 2 }}
            ><CenterDisc node={node} artworkId={`${artworkId}-center`} direction={direction} />{unavailable ? <span className="universe-node__status" aria-hidden="true"><Icon name="alert" /></span> : null}</button>;
            const copies = Math.min(node.duplicateCount, 3);
            return <button
              {...nodeProps(node, index)}
              key={node.projectId}
              className={`map-node universe-node is-${emphasis}${unavailable ? " is-unavailable" : ""}`}
              style={{
                left: node.x,
                top: node.y,
                width: node.radius * 2,
                height: node.radius * 2,
                "--ring-index": index - 1,
                "--enter-x": `${-0.24 * (node.x - layout.size / 2)}px`,
                "--enter-y": `${-0.24 * (node.y - layout.size / 2)}px`
              } as CSSProperties}
              data-ring={node.ring}
              data-label-placement={node.labelPlacement}
            >
              <svg className="universe-node__disc" viewBox="0 0 184 184" aria-hidden="true">
                {/* Extra folders of the same Project read as a faint stack behind the disc. */}
                {Array.from({ length: copies - 1 }, (_, copy) => <circle key={copy} className="universe-node__copy" cx={92 + (copies - 1 - copy) * 16} cy={92 - (copies - 1 - copy) * 16} r="88" />)}
                <circle className="universe-node__halo" cx="92" cy="92" r="112" />
                <DiscArtwork id={`${artworkId}-${index}`} hue={discHue(node.projectId)} coverImageUrl={node.coverUrl} shade={false} />
                <circle className="universe-node__ring" cx="92" cy="92" r="90" />
              </svg>
              {unavailable ? <span className="universe-node__status" aria-hidden="true"><Icon name="alert" /></span> : null}
              <span className="universe-node__label" aria-hidden="true" data-hidden={visibleLabels.has(node.projectId) ? undefined : "true"}>
                <span className="universe-node__title" dir="auto">{node.title}</span>
                {node.duplicateCount > 1 ? <span className="universe-node__copies">{formatCount(labels.copies, node.duplicateCount, locale)}</span> : null}
              </span>
            </button>;
          })}
        </div>
      </div>
    </div>
    <div className="map-zoom capsule" role="toolbar">
      <button className="tool" type="button" aria-label={labels.zoomIn} onClick={() => applyZoom("in")}><Icon name="plus" /></button>
      <button className="tool" type="button" aria-label={labels.zoomOut} onClick={() => applyZoom("out")}><Icon name="minus" /></button>
    </div>
  </div>;
}
