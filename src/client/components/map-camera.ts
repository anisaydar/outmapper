import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { easeCubicOut, select, zoom, zoomIdentity, zoomTransform, type ZoomBehavior } from "d3";

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
}

function scaleMap(surface: HTMLDivElement, behavior: ZoomBehavior<HTMLDivElement, unknown>, factor: number, animate = false) {
  const current = zoomTransform(surface);
  const [minimum, maximum] = behavior.scaleExtent();
  const nextScale = Math.min(maximum, Math.max(minimum, current.k * factor));
  const bounds = surface.getBoundingClientRect();
  const target = zoomIdentity
    .translate(current.x + bounds.width * (current.k - nextScale) / 2, current.y + bounds.height * (current.k - nextScale) / 2)
    .scale(nextScale);
  if (animate && !prefersReducedMotion()) select(surface).transition().duration(280).ease(easeCubicOut).call(behavior.transform, target);
  else select(surface).call(behavior.transform, target);
}

/**
 * The shared graph camera: d3 drag-to-pan, wheel and button zoom, and a fit that keeps the square world of `size`
 * centered and preserves the user's relative zoom and pan when the surface resizes. Nodes live in an HTML camera layer
 * and edges in an SVG layer; both receive the same transform.
 */
export function useMapCamera(
  size: number,
  surfaceRef: RefObject<HTMLDivElement | null>,
  cameraRef: RefObject<HTMLDivElement | null>,
  edgeCameraRef: RefObject<SVGGElement | null>,
  /** The square extent to fit on screen when content (such as portal labels) reaches past the world. */
  fitSize = size,
  /** Called with the camera scale whenever it changes, for content that adapts to the zoom. */
  onScale?: (scale: number) => void
) {
  const onScaleRef = useRef(onScale);
  useLayoutEffect(() => { onScaleRef.current = onScale; });
  const zoomRef = useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(null);
  const baseScaleRef = useRef(1);
  const previousSizeRef = useRef<{ width: number; height: number } | null>(null);

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
        edgeCameraRef.current?.setAttribute("transform", `translate(${x + (width - size) * k / 2} ${y + (height - size) * k / 2}) scale(${k})`);
        camera.style.setProperty("--graph-scale", String(event.transform.k));
        camera.style.setProperty("--graph-unscale", String(1 / event.transform.k));
        const relativeScale = event.transform.k / baseScaleRef.current;
        surface.dataset.zoom = relativeScale < 0.7 ? "low" : relativeScale > 1.35 ? "high" : "normal";
        onScaleRef.current?.(k);
      });
    zoomRef.current = behavior;
    selection.call(behavior);

    const fit = (width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      const previous = previousSizeRef.current;
      if (previous?.width === width && previous.height === height) return;
      const previousBaseScale = baseScaleRef.current;
      const baseScale = Math.min(width / fitSize, height / fitSize);
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
  }, [cameraRef, edgeCameraRef, fitSize, size, surfaceRef]);

  /** Returns to the initial fit, discarding the user's zoom and pan. */
  const refit = useCallback(() => {
    const surface = surfaceRef.current;
    const behavior = zoomRef.current;
    if (!surface || !behavior) return;
    const bounds = surface.getBoundingClientRect();
    const scale = Math.min(bounds.width / fitSize, bounds.height / fitSize);
    baseScaleRef.current = scale;
    behavior.scaleExtent([scale * 0.5, scale * 2.4]);
    select(surface).call(
      behavior.transform,
      zoomIdentity.translate((bounds.width * (1 - scale)) / 2, (bounds.height * (1 - scale)) / 2).scale(scale)
    );
  }, [fitSize, surfaceRef]);

  const applyZoom = useCallback((operation: "in" | "out") => {
    const surface = surfaceRef.current;
    const behavior = zoomRef.current;
    if (!surface || !behavior) return;
    scaleMap(surface, behavior, operation === "in" ? 1.25 : 0.8, true);
  }, [surfaceRef]);

  return { refit, applyZoom };
}
