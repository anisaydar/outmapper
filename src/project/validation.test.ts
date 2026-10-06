import { createValidProject } from "../test/project-fixtures.js";
import { validateProject } from "./validation.js";

describe("canonical Project validation", () => {
  it("accepts a structurally and referentially valid Project", () => {
    expect(validateProject(createValidProject())).toEqual({ valid: true, issues: [] });
  });

  it("reports invalid references and Key Issue ownership", () => {
    const project = createValidProject();
    project.relationships[0] = {
      ...project.relationships[0],
      sourceTopicId: "topic-2",
      targetTopicId: "missing-topic"
    };

    const result = validateProject(project);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/relationships/relationship-1/targetTopicId" }),
        expect.objectContaining({ path: "/relationships/relationship-1/keyIssueId" })
      ])
    );
  });

  it("rejects duplicate IDs, unsafe URLs, and escaping logical paths", () => {
    const project = createValidProject();
    project.topics.push({ ...project.topics[0] });
    project.knowledgeItems.push({
      id: "knowledge-1",
      type: "link",
      title: "Unsafe link",
      availability: "external",
      externalUrl: "javascript:alert(1)",
      contentPath: "../outside.md",
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z"
    });

    const result = validateProject(project);

    expect(result.valid).toBe(false);
    expect(result.issues.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        "/topics/topic-1",
        "/knowledgeItems/knowledge-1/externalUrl",
        "/knowledgeItems/knowledge-1/contentPath"
      ])
    );
  });

  it("reports invalid and duplicate Project Links", () => {
    const project = createValidProject();
    const link = {
      id: "link-1",
      sourceTopicId: "topic-2",
      keyIssueId: "issue-1",
      targetProjectId: project.manifest.id,
      cachedProjectTitle: "Copy",
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z"
    };
    project.projectLinks.push(link, { ...link, id: "link-2" });

    const paths = validateProject(project).issues.map(({ path }) => path);
    expect(paths).toEqual(expect.arrayContaining([
      "/projectLinks/link-1/keyIssueId",
      "/projectLinks/link-1/targetProjectId",
      "/projectLinks/link-2"
    ]));
  });
});
