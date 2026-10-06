import { DomainError } from "./errors.js";
import { assertDomainInvariants } from "./invariants.js";
import type { ProjectRepository } from "./repository.js";
import type { CanonicalProject } from "./types.js";

export interface CommandHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

/** A position in the session timeline: absolute undo depth plus the Project revision seen there. */
export interface HistoryCheckpoint {
  depth: number;
  revision: number;
}

export const COALESCE_WINDOW_MS = 5_000;
const CHECKPOINT_LIMIT = 32;

export class SessionCommandHistory {
  readonly repository: ProjectRepository;
  readonly limit: number;
  readonly now: () => string;
  readonly clock: () => number;
  private undoStates: CanonicalProject[] = [];
  private redoStates: CanonicalProject[] = [];
  private evicted = 0;
  private serial = 0;
  // Each absolute position carries a stamp that changes whenever the state stored there changes,
  // so a checkpoint stays valid across undo/redo but not across a discarded redo branch.
  private stamps = new Map<number, number>([[0, 0]]);
  private checkpoints = new Map<string, number>();
  private lastCoalesce: { key: string; at: number } | undefined;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(repository: ProjectRepository, options: { limit?: number; now?: () => string; clock?: () => number } = {}) {
    this.repository = repository;
    this.limit = options.limit ?? 50;
    this.now = options.now ?? (() => new Date().toISOString());
    this.clock = options.clock ?? (() => Date.now());
  }

  get state(): CommandHistoryState {
    return { canUndo: this.undoStates.length > 0, canRedo: this.redoStates.length > 0 };
  }

  /**
   * Runs a command as one undoable step. Consecutive commands with the same coalesceKey, each within
   * COALESCE_WINDOW_MS of the previous one and with nothing else in between, share a single step.
   */
  run<T>(command: () => Promise<T>, options: { coalesceKey?: string } = {}): Promise<T> {
    return this.enqueue(async () => {
      const before = await this.repository.load();
      const result = await command();
      const at = this.clock();
      const previous = this.lastCoalesce;
      const coalesce = options.coalesceKey !== undefined && previous?.key === options.coalesceKey &&
        at - previous.at <= COALESCE_WINDOW_MS && this.undoStates.length > 0 && this.redoStates.length === 0;
      if (coalesce) this.restamp(this.position);
      else this.advance(before);
      this.lastCoalesce = options.coalesceKey === undefined ? undefined : { key: options.coalesceKey, at };
      return result;
    });
  }

  undo(): Promise<CanonicalProject> {
    return this.enqueue(async () => {
      this.lastCoalesce = undefined;
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
      this.lastCoalesce = undefined;
      const next = this.redoStates.at(-1);
      if (!next) return this.repository.load();
      const current = await this.repository.load();
      const restored = await this.restore(next, current.manifest.revision);
      this.redoStates.pop();
      this.undoStates.push(current);
      return restored;
    });
  }

  /** Records the current position. It also ends any autosave group so later edits never merge across it. */
  checkpoint(): Promise<HistoryCheckpoint> {
    return this.enqueue(async () => {
      this.lastCoalesce = undefined;
      const project = await this.repository.load();
      const checkpoint = { depth: this.position, revision: project.manifest.revision };
      this.checkpoints.delete(checkpointKey(checkpoint));
      this.checkpoints.set(checkpointKey(checkpoint), this.stamps.get(checkpoint.depth)!);
      if (this.checkpoints.size > CHECKPOINT_LIMIT) this.checkpoints.delete(this.checkpoints.keys().next().value!);
      return checkpoint;
    });
  }

  /** Restores the state recorded at a checkpoint as one new undoable step. */
  revert(checkpoint: HistoryCheckpoint): Promise<CanonicalProject> {
    return this.enqueue(async () => {
      this.lastCoalesce = undefined;
      const current = await this.repository.load();
      const stamp = this.checkpoints.get(checkpointKey(checkpoint));
      if (stamp === undefined || checkpoint.depth < this.evicted || this.stamps.get(checkpoint.depth) !== stamp) {
        throw new DomainError(
          "checkpoint-unavailable",
          "These changes can no longer be discarded as one step because the editing history was cleared or is too long. Use Undo instead."
        );
      }
      const offset = checkpoint.depth - this.position;
      if (offset === 0) return current;
      const target = offset < 0
        ? this.undoStates[checkpoint.depth - this.evicted]!
        : this.redoStates[this.redoStates.length - offset]!;
      const restored = await this.restore(target, current.manifest.revision);
      this.advance(current);
      return restored;
    });
  }

  clear(): void {
    this.undoStates = [];
    this.redoStates = [];
    this.evicted = 0;
    this.stamps = new Map([[0, ++this.serial]]);
    this.checkpoints.clear();
    this.lastCoalesce = undefined;
  }

  private get position(): number {
    return this.evicted + this.undoStates.length;
  }

  private advance(before: CanonicalProject): void {
    this.undoStates.push(before);
    if (this.undoStates.length > this.limit) {
      this.undoStates.shift();
      this.stamps.delete(this.evicted);
      this.evicted += 1;
    }
    this.redoStates = [];
    this.restamp(this.position);
  }

  private restamp(position: number): void {
    for (const key of this.stamps.keys()) if (key >= position) this.stamps.delete(key);
    this.stamps.set(position, ++this.serial);
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

function checkpointKey({ depth, revision }: HistoryCheckpoint): string {
  return `${depth}:${revision}`;
}
