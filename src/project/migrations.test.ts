import { createValidProject } from "../test/project-fixtures.js";
import { migrateProjectData } from "./migrations.js";

describe("Project migrations", () => {
  it("returns an independent v2 representation", () => {
    const project = createValidProject();
    const migrated = migrateProjectData(project);

    expect(migrated).toEqual(project);
    expect(migrated).not.toBe(project);
  });

  it("migrates v1 to v2 with an empty Project Link collection", () => {
    const project = createValidProject() as unknown as Record<string, unknown> & { manifest: { formatVersion: number } };
    project.manifest.formatVersion = 1;
    delete project.projectLinks;

    expect(migrateProjectData(project)).toMatchObject({ manifest: { formatVersion: 2 }, projectLinks: [] });
  });

  it("rejects newer and unregistered older versions", () => {
    const project = createValidProject() as unknown as { manifest: { formatVersion: number } };
    project.manifest.formatVersion = 3;
    expect(() => migrateProjectData(project)).toThrow("newer than supported");
    project.manifest.formatVersion = 0;
    expect(() => migrateProjectData(project)).toThrow("No migration is registered");
  });
});
