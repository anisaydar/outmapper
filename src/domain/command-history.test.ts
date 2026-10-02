import { SessionCommandHistory } from "./command-history.js";
import type { ProjectRepository } from "./repository.js";
import type { CanonicalProject } from "./types.js";
import { createValidProject } from "../test/project-fixtures.js";

class MemoryRepository implements ProjectRepository {
  project = createValidProject();

  async load(): Promise<CanonicalProject> {
    return structuredClone(this.project);
  }

  async save(project: CanonicalProject): Promise<void> {
    this.project = structuredClone(project);
  }
}

describe("bounded session command history", () => {
  it("round trips canonical state through undo and redo with advancing revisions", async () => {
    const repository = new MemoryRepository();
    const history = new SessionCommandHistory(repository, {
      now: () => "2026-10-01T00:00:00.000Z"
    });

    await history.run(async () => {
      const project = await repository.load();
      project.topics[0].title = "Edited";
      project.manifest.revision += 1;
      await repository.save(project);
    });

    expect(repository.project.topics[0].title).toBe("Edited");
    expect(history.state).toEqual({ canUndo: true, canRedo: false });

    const undone = await history.undo();
    expect(undone.topics[0].title).toBe("Center");
    expect(undone.manifest.revision).toBe(2);

    const redone = await history.redo();
    expect(redone.topics[0].title).toBe("Edited");
    expect(redone.manifest.revision).toBe(3);
  });

  it("drops the oldest checkpoint when the bound is exceeded", async () => {
    const repository = new MemoryRepository();
    const history = new SessionCommandHistory(repository, { limit: 2 });

    for (const title of ["One", "Two", "Three"]) {
      await history.run(async () => {
        const project = await repository.load();
        project.topics[0].title = title;
        project.manifest.revision += 1;
        await repository.save(project);
      });
    }

    await history.undo();
    await history.undo();
    await history.undo();
    expect(repository.project.topics[0].title).toBe("One");
  });
});
