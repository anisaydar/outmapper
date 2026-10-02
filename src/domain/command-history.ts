import { assertDomainInvariants } from "./invariants.js";
import type { ProjectRepository } from "./repository.js";
import type { CanonicalProject } from "./types.js";

export interface CommandHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

export class SessionCommandHistory {
  readonly repository: ProjectRepository;
  readonly limit: number;
  readonly now: () => string;
  private undoStates: CanonicalProject[] = [];
  private redoStates: CanonicalProject[] = [];
  private pending: Promise<unknown> = Promise.resolve();

  constructor(repository: ProjectRepository, options: { limit?: number; now?: () => string } = {}) {
    this.repository = repository;
    this.limit = options.limit ?? 50;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get state(): CommandHistoryState {
    return { canUndo: this.undoStates.length > 0, canRedo: this.redoStates.length > 0 };
  }

  run<T>(command: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const before = await this.repository.load();
      const result = await command();
      this.undoStates.push(before);
      if (this.undoStates.length > this.limit) this.undoStates.shift();
      this.redoStates = [];
      return result;
    });
  }

  undo(): Promise<CanonicalProject> {
    return this.enqueue(async () => {
      const previous = this.undoStates.at(-1);
      if (!previous) return this.repository.load();
      const current = await this.repository.load();
      const restored = await this.restore(previous, current.manifest.revision);
      this.undoStates.pop();
      this.redoStates.push(current);
      return restored;
    });
  }

  redo(): Promise<CanonicalProject> {
    return this.enqueue(async () => {
      const next = this.redoStates.at(-1);
      if (!next) return this.repository.load();
      const current = await this.repository.load();
      const restored = await this.restore(next, current.manifest.revision);
      this.redoStates.pop();
      this.undoStates.push(current);
      return restored;
    });
  }

  clear(): void {
    this.undoStates = [];
    this.redoStates = [];
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async restore(state: CanonicalProject, currentRevision: number): Promise<CanonicalProject> {
    const restored = structuredClone(state);
    restored.manifest.revision = currentRevision + 1;
    restored.manifest.updatedAt = this.now();
    assertDomainInvariants(restored);
    await this.repository.save(restored);
    return restored;
  }
}
