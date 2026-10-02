import { createValidProject } from "../test/project-fixtures.js";
import { migrateProjectData } from "./migrations.js";

describe("Project migrations", () => {
  it("returns an independent v1 representation", () => {
    const project = createValidProject();
    const migrated = migrateProjectData(project);

    expect(migrated).toEqual(project);
    expect(migrated).not.toBe(project);
  });

  it("rejects newer and unregistered older versions", () => {
    const project = createValidProject() as unknown as { manifest: { formatVersion: number } };
    project.manifest.formatVersion = 2;
    expect(() => migrateProjectData(project)).toThrow("newer than supported");
    project.manifest.formatVersion = 0;
    expect(() => migrateProjectData(project)).toThrow("No migration is registered");
  });
});
