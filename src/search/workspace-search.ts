import { Worker } from "node:worker_threads";
import type { SearchPage, SearchQuery } from "./search-adapter.js";

export interface WorkspaceSearchProject {
  instanceId: string;
  projectId: string;
  projectTitle: string;
  databasePath: string;
  canonicalRevision: number;
  current: boolean;
  lastOpenedAt?: string;
}

export interface WorkspaceSearchWork {
  query: SearchQuery;
  projects: WorkspaceSearchProject[];
  startIndex?: number;
  budgetMs?: number;
}

interface WorkerRequest extends WorkspaceSearchWork {
  id: number;
  cancellation: SharedArrayBuffer;
}

interface WorkerResponse {
  id: number;
  page?: SearchPage;
  error?: { code: string; message: string };
}

export class WorkspaceSearchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkspaceSearchError";
  }
}

export class WorkspaceSearchService {
  private readonly worker: Worker;
  private nextId = 1;
  private activeCancellation?: Int32Array;
  private readonly pending = new Map<number, { resolve: (page: SearchPage) => void; reject: (error: Error) => void }>();

  constructor() {
    const source = new URL("./workspace-search-worker.js", import.meta.url);
    const sourceMode = import.meta.url.endsWith(".ts");
    if (sourceMode) source.pathname = source.pathname.replace(/\.js$/u, ".ts");
    // Source workers need their own loader registration on Node 22.
    const registerLoader = sourceMode
      ? `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register();`
      : "";
    this.worker = new Worker(source, {
      ...(sourceMode ? { execArgv: ["--import", `data:text/javascript,${encodeURIComponent(registerLoader)}`] } : {})
    });
    this.worker.on("message", (message: WorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new WorkspaceSearchError(message.error.code, message.error.message));
      else if (message.page) pending.resolve(message.page);
      else pending.reject(new WorkspaceSearchError("workspace-search-failed", "Workspace search returned no result"));
    });
    this.worker.on("error", (error) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const pending of this.pending.values()) pending.reject(failure);
      this.pending.clear();
    });
  }

  search(work: WorkspaceSearchWork): Promise<SearchPage> {
    if (this.activeCancellation) Atomics.store(this.activeCancellation, 0, 1);
    const cancellation = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    this.activeCancellation = cancellation;
    const id = this.nextId++;
    return new Promise<SearchPage>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (page) => {
          if (this.activeCancellation === cancellation) this.activeCancellation = undefined;
          resolve(page);
        },
        reject: (error) => {
          if (this.activeCancellation === cancellation) this.activeCancellation = undefined;
          reject(error);
        }
      });
      const request: WorkerRequest = { id, ...work, cancellation: cancellation.buffer as SharedArrayBuffer };
      this.worker.postMessage(request);
    });
  }

  async close(): Promise<void> {
    if (this.activeCancellation) Atomics.store(this.activeCancellation, 0, 1);
    await this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new WorkspaceSearchError("search-cancelled", "Search was cancelled"));
    this.pending.clear();
  }
}
