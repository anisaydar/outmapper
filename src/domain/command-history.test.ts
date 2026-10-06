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

describe("autosave coalescing", () => {
  function setup(limit?: number) {
    const repository = new MemoryRepository();
    let now = 0;
    const history = new SessionCommandHistory(repository, { limit, clock: () => now });
    const setTitle = (title: string, key?: string) => history.run(async () => {
      const project = await repository.load();
      project.topics[0].title = title;
      project.manifest.revision += 1;
      await repository.save(project);
    }, key ? { coalesceKey: key } : {});
    return { repository, history, setTitle, advance: (ms: number) => { now += ms; } };
  }

  it("groups same-key commands within the window into one Undo step", async () => {
    const { repository, history, setTitle, advance } = setup();
    await setTitle("A", "text:topic:topic-1");
    advance(4_000);
    await setTitle("AB", "text:topic:topic-1");
    advance(4_999);
    await setTitle("ABC", "text:topic:topic-1");

    await history.undo();
    expect(repository.project.topics[0].title).toBe("Center");
    expect(history.state.canUndo).toBe(false);
  });

  it("breaks the group after the window, for another key, after another command, and after undo or redo", async () => {
    const { repository, history, setTitle, advance } = setup();
    await setTitle("A", "text:topic:topic-1");
    advance(5_001);
    await setTitle("AB", "text:topic:topic-1");
    await setTitle("ABC", "text:keyIssue:issue-1");
    await setTitle("ABCD");
    await setTitle("ABCDE", "text:keyIssue:issue-1");

    await history.undo();
    expect(repository.project.topics[0].title).toBe("ABCD");
    await history.redo();
    await setTitle("ABCDEF", "text:keyIssue:issue-1");
    await history.undo();
    expect(repository.project.topics[0].title).toBe("ABCDE");
    for (const expected of ["ABCD", "ABC", "AB", "A", "Center"]) {
      await history.undo();
      expect(repository.project.topics[0].title).toBe(expected);
    }
  });

  it("never merges an edit into a group that started before a checkpoint", async () => {
    const { repository, history, setTitle } = setup();
    await setTitle("Before", "text:topic:topic-1");
    await history.checkpoint();
    await setTitle("After", "text:topic:topic-1");
    await history.undo();
    expect(repository.project.topics[0].title).toBe("Before");
  });
});

describe("history checkpoints", () => {
  async function setup(limit?: number) {
    const repository = new MemoryRepository();
    const history = new SessionCommandHistory(repository, { limit, now: () => "2026-10-02T00:00:00.000Z" });
    const setTitle = (title: string) => history.run(async () => {
      const project = await repository.load();
      project.topics[0].title = title;
      project.manifest.revision += 1;
      await repository.save(project);
    });
    return { repository, history, setTitle };
  }

  it("reverts to the checkpoint as one new step that can itself be undone", async () => {
    const { repository, history, setTitle } = await setup();
    await setTitle("Opened");
    const checkpoint = await history.checkpoint();
    await setTitle("Edit one");
    await setTitle("Edit two");

    const reverted = await history.revert(checkpoint);
    expect(reverted.topics[0].title).toBe("Opened");
    expect(reverted.manifest.revision).toBeGreaterThan(checkpoint.revision);
    expect(history.state).toEqual({ canUndo: true, canRedo: false });

    await history.undo();
    expect(repository.project.topics[0].title).toBe("Edit two");
    await history.undo();
    expect(repository.project.topics[0].title).toBe("Edit one");
  });

  it("stays valid after undoing past it, and is a no-op when nothing changed", async () => {
    const { repository, history, setTitle } = await setup();
    await setTitle("Opened");
    const checkpoint = await history.checkpoint();
    expect((await history.revert(checkpoint)).manifest.revision).toBe(checkpoint.revision);
    await setTitle("Edited");
    await history.undo();
    await history.undo();
    expect(repository.project.topics[0].title).toBe("Center");

    await history.revert(checkpoint);
    expect(repository.project.topics[0].title).toBe("Opened");
  });

  it("refuses a checkpoint whose state was evicted or discarded", async () => {
    const evicted = await setup(2);
    const old = await evicted.history.checkpoint();
    for (const title of ["One", "Two", "Three"]) await evicted.setTitle(title);
    await expect(evicted.history.revert(old)).rejects.toMatchObject({ code: "checkpoint-unavailable" });
    expect(evicted.repository.project.topics[0].title).toBe("Three");

    const discarded = await setup();
    await discarded.setTitle("Branch");
    const branch = await discarded.history.checkpoint();
    await discarded.history.undo();
    await discarded.setTitle("Other branch");
    await expect(discarded.history.revert(branch)).rejects.toMatchObject({ code: "checkpoint-unavailable" });

    discarded.history.clear();
    await expect(discarded.history.revert({ depth: 0, revision: 0 })).rejects.toMatchObject({ code: "checkpoint-unavailable" });
  });
});
