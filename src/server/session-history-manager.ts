import type { CanonicalProject } from "../domain/types.js";
import { SessionCommandHistory } from "../domain/command-history.js";
import { FileSystemProjectStore } from "../project/filesystem-project-store.js";

interface ManagedHistory {
  instanceId: string;
  directory: string;
  store: FileSystemProjectStore;
  history: SessionCommandHistory;
  lastUsed: number;
  knownFingerprint?: string;
  knownRevision?: number;
  leavingFingerprint?: string;
  leavingRevision?: number;
}

export interface HistoryActivation {
  project: CanonicalProject;
  store: FileSystemProjectStore;
  history: SessionCommandHistory;
  historyCleared: boolean;
}

/** Owns session Undo timelines by folder instance and retains at most five inactive timelines. */
export class SessionHistoryManager {
  private readonly records = new Map<string, ManagedHistory>();
  private activeInstanceId?: string;
  private serial = 0;

  constructor(private readonly inactiveLimit = 5) {}

  async activate(instanceId: string, directory: string): Promise<HistoryActivation> {
    if (this.activeInstanceId && this.activeInstanceId !== instanceId) await this.recordLeaving(this.activeInstanceId);
    let record = this.records.get(instanceId);
    if (!record) {
      const store = new FileSystemProjectStore(directory);
      record = { instanceId, directory, store, history: new SessionCommandHistory(store), lastUsed: ++this.serial };
      this.records.set(instanceId, record);
    }
    const project = await record.store.open();
    const fingerprint = await record.store.getDiskFingerprint();
    const historyCleared = record.leavingFingerprint !== undefined &&
      (record.leavingFingerprint !== fingerprint || record.leavingRevision !== project.manifest.revision);
    if (historyCleared) record.history.clear();
    record.leavingFingerprint = undefined;
    record.leavingRevision = undefined;
    record.knownFingerprint = fingerprint;
    record.knownRevision = project.manifest.revision;
    record.lastUsed = ++this.serial;
    this.activeInstanceId = instanceId;
    this.evictInactive();
    return { project, store: record.store, history: record.history, historyCleared };
  }

  async reload(): Promise<HistoryActivation> {
    const record = this.currentRecord();
    const project = await record.store.open();
    record.history.clear();
    record.leavingFingerprint = undefined;
    record.leavingRevision = undefined;
    record.lastUsed = ++this.serial;
    record.knownFingerprint = await record.store.getDiskFingerprint();
    record.knownRevision = project.manifest.revision;
    return { project, store: record.store, history: record.history, historyCleared: true };
  }

  current(): { instanceId: string; directory: string; store: FileSystemProjectStore; history: SessionCommandHistory } {
    const record = this.currentRecord();
    return { instanceId: record.instanceId, directory: record.directory, store: record.store, history: record.history };
  }

  has(instanceId: string): boolean {
    return this.records.has(instanceId);
  }

  async markCurrent(project: CanonicalProject): Promise<void> {
    const record = this.currentRecord();
    record.knownRevision = project.manifest.revision;
    record.knownFingerprint = await record.store.getDiskFingerprint();
    record.lastUsed = ++this.serial;
  }

  private currentRecord(): ManagedHistory {
    const record = this.activeInstanceId ? this.records.get(this.activeInstanceId) : undefined;
    if (!record) throw new Error("No active Project history");
    return record;
  }

  private async recordLeaving(instanceId: string): Promise<void> {
    const record = this.records.get(instanceId);
    if (!record) return;
    record.leavingRevision = record.knownRevision;
    record.leavingFingerprint = record.knownFingerprint;
    record.lastUsed = ++this.serial;
  }

  private evictInactive(): void {
    const inactive = [...this.records.values()]
      .filter(({ instanceId }) => instanceId !== this.activeInstanceId)
      .sort((left, right) => left.lastUsed - right.lastUsed);
    while (inactive.length > this.inactiveLimit) {
      const oldest = inactive.shift();
      if (oldest) this.records.delete(oldest.instanceId);
    }
  }
}
