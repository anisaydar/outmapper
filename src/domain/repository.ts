import type { CanonicalProject } from "./types.js";

export interface ProjectRepository {
  load(): Promise<CanonicalProject>;
  save(project: CanonicalProject): Promise<void>;
}
