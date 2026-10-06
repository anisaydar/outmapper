import { fireEvent, render, screen, within } from "@testing-library/react";
import type { UniverseProjectNode, WorkspaceUniverse } from "../../domain/workspace.js";
import { layoutUniverse, nextUniverseNode, universeLabelSize, visibleUniverseLabels, type UniverseRect } from "./universe-layout.js";
import { UniverseProjectPanel, UniverseView, type UniverseLabels } from "./UniverseView.js";

const labels: UniverseLabels = {
  mapLabel: "Project Universe",
  loading: "Loading the Universe…",
  empty: "No Projects are registered yet.",
  single: "Only this Project is here so far.",
  error: "The Universe could not be loaded.",
  retry: "Retry",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  closePreview: "Close preview",
  project: "Project",
  currentProject: "Current Project",
  openProject: "Open Project",
  projectActions: "Project actions",
  removeFromRecent: "Remove from Recent",
  forgetProject: "Forget Project",
  locate: "Locate...",
  noDescription: "No description",
  noLinks: "No links yet",
  outgoing: "{count} outgoing",
  incoming: "{count} incoming",
  copies: "{count} copies",
  links: "Links: {count}",
  linkedProjects: "Linked Projects",
  outgoingHeading: "Outgoing",
  incomingHeading: "Incoming",
  statuses: { missing: "Missing", mismatch: "Folder changed", unreadable: "Unavailable", "needs-open": "Needs opening" }
};

const universe: WorkspaceUniverse = {
  nodes: [
    { instanceId: "b", projectId: "project-b", title: "Beta", status: "missing", duplicateCount: 1 },
    { instanceId: "a", projectId: "project-a", title: "Alpha", description: "Alpha description", status: "duplicate", duplicateCount: 3 },
    { instanceId: "c", projectId: "project-c", title: "Gamma", status: "available", duplicateCount: 1 },
    { instanceId: "d", projectId: "project-d", title: "Delta", status: "available", duplicateCount: 1 }
  ],
  edges: [
    { id: "a:b", sourceProjectId: "project-a", targetProjectId: "project-b", count: 2 },
    { id: "c:a", sourceProjectId: "project-c", targetProjectId: "project-a", count: 1 }
  ]
};

function renderView(overrides: Partial<Parameters<typeof UniverseView>[0]> = {}) {
  const props = { universe, loading: false, currentProjectId: "project-a", labels, locale: "en", onRetry: vi.fn(), onSelect: vi.fn(), onOpen: vi.fn(), ...overrides };
  return { ...render(<UniverseView {...props} />), props };
}

function overlaps(a: UniverseRect, b: UniverseRect) {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;
}

describe("universe layout", () => {
  it("shows every label at its own size and hides only labels that would reach another Project when grown", () => {
    const layout = layoutUniverse(universe, "project-a");
    const labelled = layout.nodes.filter(({ labelRect }) => labelRect).map(({ projectId }) => projectId);
    expect([...visibleUniverseLabels(layout.nodes, 1)].sort()).toEqual([...labelled].sort());
    const crowded = layout.nodes.map((node, index) => index === 0 ? node : { ...node, x: layout.nodes[1]!.x + index * 30, y: layout.nodes[1]!.y });
    const relabelled = crowded.map((node) => node.labelRect ? { ...node, labelRect: { left: node.x - 40, right: node.x + 40, top: node.y + node.radius + 8, bottom: node.y + node.radius + 24 } } : node);
    const visible = visibleUniverseLabels(relabelled, 2.5, "project-d");
    expect(visible.has("project-d")).toBe(true);
    expect(visible.size).toBeLessThan(labelled.length);
    // A grown label that would leave the fitted world hides too.
    const edge = layout.nodes.filter(({ labelRect }) => labelRect).map((node) => ({ ...node, x: layout.size - 30, labelRect: { left: layout.size - 60, right: layout.size - 2, top: node.y + node.radius + 8, bottom: node.y + node.radius + 24 } }))[0]!;
    expect(visibleUniverseLabels([edge], 2, undefined, layout.size).size).toBe(0);
    expect(visibleUniverseLabels([edge], 2).size).toBe(1);
  });

  it("centers the current Project, keeps linked Projects closer than the rest, deterministically", () => {
    const layout = layoutUniverse(universe, "project-a");
    expect(layout).toEqual(layoutUniverse(structuredClone(universe), "project-a"));
    expect(layout.centerProjectId).toBe("project-a");
    const ring = Object.fromEntries(layout.nodes.map(({ projectId, ring: value }) => [projectId, value]));
    expect(ring).toEqual({ "project-a": "center", "project-b": "linked", "project-c": "linked", "project-d": "outer" });
    const center = layout.nodes.find(({ ring: value }) => value === "center")!;
    const distance = (id: string) => { const node = layout.nodes.find(({ projectId }) => projectId === id)!; return Math.hypot(node.x - center.x, node.y - center.y); };
    expect(distance("project-d")).toBeGreaterThan(distance("project-b"));
    expect(layout.edges.map(({ id }) => id)).toEqual(["a:b", "c:a"]);
  });

  it("keeps discs and labels of 24 Projects apart, including long and duplicate titles", () => {
    const nodes: UniverseProjectNode[] = Array.from({ length: 24 }, (_, index) => ({
      instanceId: `i${index}`,
      projectId: `p${String(index).padStart(2, "0")}`,
      title: index % 3 ? `Project ${index}` : `A considerably longer Project title number ${index}`,
      status: index === 5 ? "missing" : "available",
      duplicateCount: index === 7 ? 2 : 1
    }));
    const edges = Array.from({ length: 9 }, (_, index) => ({ id: `e${index}`, sourceProjectId: "p00", targetProjectId: `p${String(index + 1).padStart(2, "0")}`, count: index + 1 }));
    const layout = layoutUniverse({ nodes, edges }, "p00");
    expect(layout.nodes.filter(({ ring }) => ring === "linked")).toHaveLength(9);
    expect(layout.nodes.filter(({ ring }) => ring === "outer")).toHaveLength(14);
    const rects = layout.nodes.flatMap((node) => [
      { left: node.x - node.radius, right: node.x + node.radius, top: node.y - node.radius, bottom: node.y + node.radius },
      ...(node.labelRect ? [node.labelRect] : [])
    ]);
    for (let left = 0; left < rects.length; left += 1) {
      for (let right = left + 1; right < rects.length; right += 1) expect(overlaps(rects[left]!, rects[right]!)).toBe(false);
    }
    for (const rect of rects) {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(layout.size);
      expect(rect.bottom).toBeLessThanOrEqual(layout.size);
    }
    expect(universeLabelSize(nodes[7]!).height).toBeGreaterThan(universeLabelSize(nodes[8]!).height);
  });

  it("clusters linked Projects, sizes nodes by their links, and keeps unlinked Projects on the outside", () => {
    const node = (projectId: string): UniverseProjectNode => ({ instanceId: projectId, projectId, title: projectId, status: "available", duplicateCount: 1 });
    const link = (source: string, target: string) => ({ id: `${source}:${target}`, sourceProjectId: source, targetProjectId: target, count: 1 });
    const clusterA = ["a1", "a2", "a3", "a4", "a5"];
    const clusterB = ["b1", "b2", "b3", "b4", "b5"];
    const edges = [
      link("center", "a1"), link("center", "b1"),
      ...clusterA.slice(1).map((id) => link(id, "a1")), link("a2", "a3"), link("a4", "a5"),
      ...clusterB.slice(1).map((id) => link(id, "b1")), link("b2", "b3"), link("b4", "b5")
    ];
    const layout = layoutUniverse({ nodes: ["center", ...clusterA, ...clusterB, "loner-1", "loner-2"].map(node), edges }, "center");
    const at = (id: string) => layout.nodes.find(({ projectId }) => projectId === id)!;
    const gap = (left: string, right: string) => Math.hypot(at(left).x - at(right).x, at(left).y - at(right).y);
    const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
    const within = mean([...clusterA.flatMap((left) => clusterA.filter((right) => right > left).map((right) => gap(left, right))), ...clusterB.flatMap((left) => clusterB.filter((right) => right > left).map((right) => gap(left, right)))]);
    const across = mean(clusterA.flatMap((left) => clusterB.map((right) => gap(left, right))));
    expect(within).toBeLessThan(across * 0.7);
    // Hubs grow with their links; Projects without links stay small and sit outside the linked graph.
    expect(at("a1").radius).toBeGreaterThan(at("a5").radius);
    expect(at("loner-1").radius).toBeLessThan(at("a5").radius);
    const fromCenter = (id: string) => gap(id, "center");
    expect(Math.min(fromCenter("loner-1"), fromCenter("loner-2"))).toBeGreaterThan(Math.max(...[...clusterA, ...clusterB].map(fromCenter)));
  });

  it("lays out a large Universe quickly", () => {
    const nodes: UniverseProjectNode[] = Array.from({ length: 150 }, (_, index) => ({ instanceId: `i${index}`, projectId: `p${index}`, title: `Project ${index}`, status: "available", duplicateCount: 1 }));
    const edges = Array.from({ length: 200 }, (_, index) => ({ id: `e${index}`, sourceProjectId: `p${(index * 7) % 150}`, targetProjectId: `p${(index * 13 + 1) % 150}`, count: 1 }))
      .filter(({ sourceProjectId, targetProjectId }) => sourceProjectId !== targetProjectId);
    const started = performance.now();
    const layout = layoutUniverse({ nodes, edges }, "p0");
    expect(layout.nodes).toHaveLength(150);
    // About 0.2s on its own; the budget leaves room for a busy parallel test run.
    expect(performance.now() - started).toBeLessThan(4000);
  });

  it("moves spatially with arrow keys", () => {
    const nodes = [{ projectId: "center", x: 0, y: 0 }, { projectId: "up", x: 0, y: -100 }, { projectId: "right", x: 100, y: 10 }, { projectId: "left", x: -100, y: 0 }];
    expect(nextUniverseNode(nodes, "center", "ArrowUp")).toBe("up");
    expect(nextUniverseNode(nodes, "center", "ArrowRight")).toBe("right");
    expect(nextUniverseNode(nodes, "center", "ArrowLeft")).toBe("left");
    expect(nextUniverseNode(nodes, "center", "ArrowDown")).toBeUndefined();
  });
});

describe("UniverseView", () => {
  it("renders one disc per Project with the current Project at the center and never names the Available state", () => {
    renderView();
    const alpha = screen.getByRole("button", { name: "Alpha, Current Project, 3 copies" });
    expect(alpha).toHaveClass("universe-node--center");
    expect(screen.getAllByRole("button", { name: /^Alpha/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Beta, Missing" })).toHaveClass("is-unavailable");
    expect(screen.getByRole("button", { name: "Gamma" })).not.toHaveClass("is-unavailable");
    expect(document.body).not.toHaveTextContent(/Available/);
    expect(document.querySelectorAll(".universe-edge")).toHaveLength(2);
    expect(screen.getByRole("group", { name: "Project Universe" })).toBeInTheDocument();
  });

  it("shows a quiet copies line for duplicate folders on ring nodes, with no number badge", () => {
    renderView({ currentProjectId: "project-c" });
    const alpha = screen.getByRole("button", { name: "Alpha, 3 copies" });
    expect(alpha.querySelector(".universe-node__copies")).toHaveTextContent("3 copies");
    expect(alpha.querySelectorAll(".universe-node__copy")).toHaveLength(2);
    expect(alpha.querySelector(".status-badge")).toBeNull();
  });

  it("uses a roving tab stop, moves with arrow keys, selects with Enter and opens with Enter on the selected node", () => {
    const { props, rerender } = renderView();
    const alpha = screen.getByRole("button", { name: /^Alpha/ });
    expect(alpha).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Gamma" })).toHaveAttribute("tabindex", "-1");
    alpha.focus();
    const layout = layoutUniverse(universe, "project-a");
    for (const key of ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"]) {
      const expected = nextUniverseNode(layout.nodes, "project-a", key);
      if (!expected) continue;
      fireEvent.keyDown(alpha, { key });
      expect(document.activeElement).toHaveAttribute("data-universe-project-id", expected);
      expect(document.activeElement).toHaveAttribute("tabindex", "0");
      alpha.focus();
    }
    fireEvent.keyDown(alpha, { key: "End" });
    const last = document.activeElement as HTMLElement;
    expect(last).toHaveAttribute("data-universe-project-id", layout.nodes.at(-1)!.projectId);
    fireEvent.keyDown(last, { key: "Home" });
    expect(alpha).toHaveFocus();

    fireEvent.keyDown(alpha, { key: "Enter" });
    expect(props.onSelect).toHaveBeenLastCalledWith("project-a");
    expect(props.onOpen).not.toHaveBeenCalled();
    rerender(<UniverseView {...props} selectedProjectId="project-a" />);
    expect(alpha).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(alpha, { key: "Enter" });
    expect(props.onOpen).toHaveBeenCalledWith("project-a");
  });

  it("dims Projects and edges unrelated to the selection", () => {
    renderView({ selectedProjectId: "project-c" });
    expect(screen.getByRole("button", { name: "Gamma" })).toHaveClass("is-selected");
    expect(screen.getByRole("button", { name: /^Alpha/ })).toHaveClass("is-default");
    expect(screen.getByRole("button", { name: "Beta, Missing" })).toHaveClass("is-dimmed");
    expect(document.querySelector("[data-edge-id='c:a']")).toHaveClass("is-highlighted");
    expect(document.querySelector("[data-edge-id='a:b']")).toHaveClass("is-dimmed");
  });

  it("draws each edge only after both of its Projects have entered", () => {
    renderView();
    const delay = (id: string) => Number.parseFloat((document.querySelector(`[data-edge-id="${id}"]`) as HTMLElement).style.getPropertyValue("--edge-delay"));
    const nodeDelay = (id: string) => {
      const node = document.querySelector(`[data-universe-project-id="${id}"]`) as HTMLElement;
      const ringIndex = Number(node.style.getPropertyValue("--ring-index") || -1);
      const step = Number.parseFloat((document.querySelector(".universe-world") as HTMLElement).style.getPropertyValue("--topic-enter-step"));
      return ringIndex < 0 ? 0 : 300 + ringIndex * step;
    };
    for (const [id, source, target] of [["a:b", "project-a", "project-b"], ["c:a", "project-c", "project-a"]] as const) {
      expect(delay(id)).toBeGreaterThan(Math.max(nodeDelay(source), nodeDelay(target)));
    }
    expect(document.querySelector(".universe-edge__count")).toBeNull();
  });

  it("renders empty, single-Project, loading, and error states", () => {
    const { rerender, props } = renderView({ universe: { nodes: [], edges: [] } });
    expect(screen.getByText(labels.empty)).toBeInTheDocument();
    rerender(<UniverseView {...props} universe={{ nodes: [universe.nodes[0]!], edges: [] }} />);
    expect(screen.getByText(labels.single)).toBeInTheDocument();
    rerender(<UniverseView {...props} universe={undefined} loading />);
    expect(screen.getByText(labels.loading)).toBeInTheDocument();
    rerender(<UniverseView {...props} universe={undefined} error="failed" />);
    fireEvent.click(screen.getByRole("button", { name: labels.retry }));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });
});

describe("UniverseDetailsCard", () => {
  function renderCard(node: UniverseProjectNode, overrides: Partial<Parameters<typeof UniverseProjectPanel>[0]> = {}) {
    const props = { node, universe, labels, locale: "en", onOpen: vi.fn(), onRemoveFromRecent: vi.fn(), onForget: vi.fn(), onLocate: vi.fn(), onSelectProject: vi.fn(), onOpenProject: vi.fn(), ...overrides };
    render(<UniverseProjectPanel {...props} />);
    return props;
  }

  it("shows the Project in the side panel with its links, each of which can be shown or opened", () => {
    const props = renderCard(universe.nodes[1]!, { current: true });
    expect(screen.getByRole("heading", { level: 1, name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByText("Current Project")).toBeInTheDocument();
    expect(screen.getByText("2 outgoing · 1 incoming · 3 copies")).toBeInTheDocument();
    expect(screen.getByText("Alpha description")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Project" }));
    expect(props.onOpen).toHaveBeenCalledOnce();

    const links = screen.getByRole("region", { name: "Linked Projects" });
    expect(within(links).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Outgoing", "Incoming"]);
    // Beta is linked twice and missing; its row says so, and its button locates it instead of opening it.
    expect(within(links).getByText("Missing · Links: 2")).toBeInTheDocument();
    fireEvent.click(within(links).getByRole("button", { name: /^Gamma/ }));
    expect(props.onSelectProject).toHaveBeenCalledWith("project-c");
    fireEvent.click(within(links).getByRole("button", { name: "Open Project: Gamma" }));
    expect(props.onOpenProject).toHaveBeenCalledWith("project-c");
    expect(within(links).getByRole("button", { name: "Locate...: Beta" })).toBeInTheDocument();
  });

  it("keeps secondary actions in a keyboard menu, with Forget as a danger item", () => {
    const props = renderCard(universe.nodes[3]!);
    expect(screen.getByText("No description")).toBeInTheDocument();
    expect(screen.getByText("No links yet")).toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Project actions" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Project actions" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Remove from Recent", "Locate...", "Forget Project"]);
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1]!, { key: "End" });
    expect(items[2]).toHaveFocus();
    expect(items[2]).toHaveClass("is-danger");
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent.keyDown(items[2]!, { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect(outer).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Forget Project" }));
    expect(props.onForget).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("offers Locate as the primary action for a missing Project and protects the active folder", () => {
    renderCard(universe.nodes[0]!, { active: true });
    expect(screen.getByText("Missing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Locate..." })).toHaveClass("pill--accent");
    expect(screen.queryByRole("button", { name: "Open Project" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Remove from Recent", "Forget Project"]);
    expect(screen.getByRole("menuitem", { name: "Remove from Recent" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Forget Project" })).toBeDisabled();
  });
});
