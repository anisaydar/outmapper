import { fireEvent, render, screen } from "@testing-library/react";
import { createValidProject } from "../../test/project-fixtures.js";
import { buildGraphProjection } from "../../graph/projection.js";
import { layoutRadialProjection } from "../../graph/radial-layout.js";
import { MapViewer } from "./MapViewer.js";

it("renders an accessible incoming portal and reports its selection", () => {
  const onSelectPortal = vi.fn();
  const projection = buildGraphProjection(createValidProject(), "topic-1", { incomingLinks: [{
    linkId: "incoming-1",
    sourceInstanceId: "source-instance",
    sourceProjectId: "source-project",
    sourceProjectTitle: "Source Project",
    sourceTopicId: "source-topic",
    sourceTopicTitle: "Source Topic",
    keyIssueId: "source-issue",
    keyIssueTitle: "Source Issue",
    availability: "available"
  }] });

  render(<MapViewer
    projection={projection}
    labels={{ mapLabel: "Topic map", centralTopic: "Central Topic", keyIssue: "Key Issue", relatedTopic: "Related Topic", connectedVia: "Connected via", linkedProject: "Linked Project", incomingLinkFrom: "Incoming link from", projectOverflow: "Projects", zoomIn: "Zoom in", zoomOut: "Zoom out" }}
    onSelectKeyIssue={vi.fn()}
    onSelectRelatedTopic={vi.fn()}
    onSelectPortal={onSelectPortal}
    onShowPortalOverflow={vi.fn()}
    onClearSelection={vi.fn()}
  />);

  const portal = screen.getByRole("button", { name: "Incoming link from Source Project" });
  expect(portal).toHaveAttribute("data-portal-direction", "incoming");
  fireEvent.click(portal);
  expect(onSelectPortal).toHaveBeenCalledWith("incoming:source-instance:incoming-1");
  expect(document.querySelector(".map-edge--portal-incoming")).toBeInTheDocument();
});

it("keeps portal edges quiet until their Key Issue or portal is selected", () => {
  const project = createValidProject();
  project.projectLinks = [{ id: "link-1", sourceTopicId: "topic-1", keyIssueId: "issue-1", targetProjectId: "target-project", cachedProjectTitle: "Target Project", order: 0, createdAt: project.manifest.createdAt, updatedAt: project.manifest.updatedAt }];
  const incomingLinks = [{ linkId: "incoming-1", sourceInstanceId: "source-instance", sourceProjectId: "source-project", sourceProjectTitle: "Source Project", sourceTopicId: "source-topic", sourceTopicTitle: "Source Topic", keyIssueId: "source-issue", keyIssueTitle: "Source Issue", availability: "available" as const }];
  const labels = { mapLabel: "Topic map", centralTopic: "Central Topic", keyIssue: "Key Issue", relatedTopic: "Related Topic", connectedVia: "Connected via", linkedProject: "Linked Project", incomingLinkFrom: "Incoming link from", projectOverflow: "Projects", zoomIn: "Zoom in", zoomOut: "Zoom out" };
  const view = (options: { selectedKeyIssueId?: string; selectedPortalId?: string } = {}) => <MapViewer
    projection={buildGraphProjection(project, "topic-1", { incomingLinks, ...(options.selectedKeyIssueId ? { selectedKeyIssueId: options.selectedKeyIssueId } : {}) })}
    labels={labels}
    {...(options.selectedPortalId ? { selectedPortalId: options.selectedPortalId } : {})}
    onSelectKeyIssue={vi.fn()}
    onSelectRelatedTopic={vi.fn()}
    onSelectPortal={vi.fn()}
    onShowPortalOverflow={vi.fn()}
    onClearSelection={vi.fn()}
  />;
  const outgoingEdge = () => document.querySelector(".map-edge--portal-outgoing");
  const incomingEdge = () => document.querySelector(".map-edge--portal-incoming");

  const { rerender } = render(view());
  expect(outgoingEdge()).toHaveClass("is-default");
  expect(incomingEdge()).toHaveClass("is-default");
  expect(document.querySelectorAll(".edge-arrowhead")).toHaveLength(2);

  rerender(view({ selectedKeyIssueId: "issue-1" }));
  expect(outgoingEdge()).toHaveClass("is-highlighted");
  expect(incomingEdge()).toHaveClass("is-dimmed");
  expect(screen.getByRole("button", { name: "Incoming link from Source Project" })).toHaveClass("is-dimmed");

  rerender(view({ selectedPortalId: "incoming:source-instance:incoming-1" }));
  expect(incomingEdge()).toHaveClass("is-highlighted");
  expect(outgoingEdge()).toHaveClass("is-dimmed");
  expect(screen.getByRole("button", { name: "Incoming link from Source Project" })).toHaveAttribute("aria-pressed", "true");
});

it("orders portals into the related-Topic entrance by angle, with their edges and arrowheads", () => {
  const projection = buildGraphProjection(createValidProject(), "topic-1", { incomingLinks: [{
    linkId: "incoming-1",
    sourceInstanceId: "source-instance",
    sourceProjectId: "source-project",
    sourceProjectTitle: "Source Project",
    sourceTopicId: "source-topic",
    sourceTopicTitle: "Source Topic",
    keyIssueId: "source-issue",
    keyIssueTitle: "Source Issue",
    availability: "available"
  }] });
  const layout = layoutRadialProjection(projection);
  render(<MapViewer
    projection={projection}
    labels={{ mapLabel: "Topic map", centralTopic: "Central Topic", keyIssue: "Key Issue", relatedTopic: "Related Topic", connectedVia: "Connected via", linkedProject: "Linked Project", incomingLinkFrom: "Incoming link from", projectOverflow: "Projects", zoomIn: "Zoom in", zoomOut: "Zoom out" }}
    onSelectKeyIssue={vi.fn()}
    onSelectRelatedTopic={vi.fn()}
    onSelectPortal={vi.fn()}
    onShowPortalOverflow={vi.fn()}
    onClearSelection={vi.fn()}
  />);

  const topics = Math.max(1, layout.relatedTopics.length);
  for (const portal of layout.portals) {
    const node = document.querySelector(`[data-map-node="portal"][data-entity-id="${portal.id}"]`) as HTMLElement;
    const ringIndex = Number(node.style.getPropertyValue("--ring-index"));
    // Its place in the sweep that starts at -90°, never after every Topic.
    expect(ringIndex).toBeCloseTo((((portal.angle + 90) % 360 + 360) % 360) / 360 * topics, 6);
    expect(ringIndex).toBeLessThan(topics);
    for (const edge of layout.portalEdges.filter(({ portalId }) => portalId === portal.id)) {
      const path = document.querySelector(`.map-edge--portal[data-edge-id="${edge.id}"]`) as SVGElement;
      expect(Number(path.style.getPropertyValue("--edge-index"))).toBeCloseTo(projection.keyIssues.length + ringIndex, 6);
    }
  }
  expect(layout.portals.length).toBeGreaterThan(0);
  expect(document.querySelectorAll(".edge-arrowhead")).toHaveLength(layout.portalEdges.length);
});
