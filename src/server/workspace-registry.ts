import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CanonicalProject, EntityId } from "../domain/types.js";
import { DomainError } from "../domain/errors.js";
import type {
  ProjectFingerprint,
  ProjectResolution,
  IncomingProjectLinks,
  WorkspaceUniverse,
  WorkspaceProjectEntry,
  WorkspaceRegistryData
} from "../domain/workspace.js";
import { ProjectReader } from "../project/project-reader.js";

const EMPTY_REGISTRY = (): WorkspaceRegistryData => ({ formatVersion: 1, projects: {}, preferredInstance: {} });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validEntry(value: unknown): value is WorkspaceProjectEntry {
  if (!isRecord(value)) return false;
  return typeof value.instanceId === "string" && typeof value.directory === "string" &&
    typeof value.projectId === "string" && typeof value.title === "string" &&
    typeof value.revision === "number" && typeof value.formatVersion === "number" &&
    typeof value.status === "string" && typeof value.firstSeenAt === "string" &&
    typeof value.lastSeenAt === "string" && typeof value.hiddenFromRecent === "boolean" &&
    Array.isArray(value.outgoingLinks);
}

function parseRegistry(content: string): WorkspaceRegistryData {
  const value: unknown = JSON.parse(content);
  if (!isRecord(value) || value.formatVersion !== 1 || !isRecord(value.projects) || !isRecord(value.preferredInstance)) {
    throw new Error("Workspace registry is invalid");
  }
  for (const [instanceId, entry] of Object.entries(value.projects)) {
    if (!validEntry(entry) || entry.instanceId !== instanceId) throw new Error("Workspace registry contains an invalid Project entry");
  }
  if (Object.values(value.preferredInstance).some((instanceId) => typeof instanceId !== "string")) {
    throw new Error("Workspace registry contains an invalid preference");
  }
  return structuredClone(value) as unknown as WorkspaceRegistryData;
}

function sameFingerprint(left?: ProjectFingerprint, right?: ProjectFingerprint): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeRegistry(left: WorkspaceRegistryData, right: WorkspaceRegistryData): WorkspaceRegistryData {
  const projects = { ...left.projects };
  for (const [id, entry] of Object.entries(right.projects)) {
    const previous = projects[id];
    projects[id] = !previous || entry.lastSeenAt >= previous.lastSeenAt ? entry : previous;
  }
  return {
    formatVersion: 1,
    projects,
    preferredInstance: { ...left.preferredInstance, ...right.preferredInstance }
  };
}

function recomputeDuplicateStatuses(data: WorkspaceRegistryData): void {
  const counts = new Map<string, number>();
  for (const entry of Object.values(data.projects)) {
    if (entry.status === "available" || entry.status === "duplicate") {
      counts.set(entry.projectId, (counts.get(entry.projectId) ?? 0) + 1);
    }
  }
  for (const entry of Object.values(data.projects)) {
    if (entry.status === "available" || entry.status === "duplicate") {
      entry.status = (counts.get(entry.projectId) ?? 0) > 1 ? "duplicate" : "available";
    }
  }
}

async function canonicalDirectory(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(directory);
    throw error;
  }
}

export async function instanceIdForDirectory(directory: string, platform = process.platform): Promise<string> {
  const resolved = await canonicalDirectory(directory);
  const key = platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  return createHash("sha256").update(key).digest("hex");
}

export interface WorkspaceRegistryOptions {
  stateDirectory: string;
  reader?: ProjectReader;
  now?: () => string;
  platform?: NodeJS.Platform;
}

export class WorkspaceRegistry {
  readonly filePath: string;
  readonly recentFilePath: string;
  readonly reader: ProjectReader;
  private data = EMPTY_REGISTRY();
  private readonly now: () => string;
  private readonly platform: NodeJS.Platform;
  private incomingByTargetProject = new Map<EntityId, Array<{
    linkId: EntityId;
    sourceInstanceId: string;
    sourceProjectId: EntityId;
    sourceProjectTitle: string;
    sourceTopicId: EntityId;
    sourceTopicTitle: string;
    keyIssueId: EntityId;
    keyIssueTitle: string;
    targetTopicId?: EntityId;
    availability: "available" | "unavailable";
  }>>();

  constructor(options: WorkspaceRegistryOptions) {
    this.filePath = path.join(options.stateDirectory, "workspace", "registry.json");
    this.recentFilePath = path.join(options.stateDirectory, "recent-projects.json");
    this.reader = options.reader ?? new ProjectReader();
    this.now = options.now ?? (() => new Date().toISOString());
    this.platform = options.platform ?? process.platform;
  }

  async initialize(activeDirectory: string, activeProject: CanonicalProject): Promise<void> {
    let corrupt = false;
    try {
      this.data = parseRegistry(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") corrupt = true;
      this.data = EMPTY_REGISTRY();
    }

    let recent: Array<{ directory: string; title: string; id: string }> = [];
    try {
      const value: unknown = JSON.parse(await readFile(this.recentFilePath, "utf8"));
      if (Array.isArray(value)) {
        recent = value.filter((entry): entry is { directory: string; title: string; id: string } =>
          isRecord(entry) && typeof entry.directory === "string" && typeof entry.title === "string" && typeof entry.id === "string");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }

    if (corrupt || Object.keys(this.data.projects).length === 0) {
      for (const record of recent) await this.addLegacyRecord(record);
    }
    await this.putProject(activeDirectory, activeProject, true);
    await this.refreshInMemory();
    await this.writeMerged((data) => {
      const combined = mergeRegistry(data, this.data);
      data.projects = combined.projects;
      data.preferredInstance = combined.preferredInstance;
    });
    await unlink(this.recentFilePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  list(): WorkspaceRegistryData {
    return structuredClone(this.data);
  }

  get(instanceId: string): WorkspaceProjectEntry | undefined {
    const entry = this.data.projects[instanceId];
    return entry ? structuredClone(entry) : undefined;
  }

  recent(): WorkspaceProjectEntry[] {
    return Object.values(this.data.projects)
      .filter(({ hiddenFromRecent }) => !hiddenFromRecent)
      .sort((left, right) => (right.lastOpenedAt ?? "").localeCompare(left.lastOpenedAt ?? "") || right.lastSeenAt.localeCompare(left.lastSeenAt))
      .map((entry) => structuredClone(entry));
  }

  incomingFor(project: CanonicalProject): IncomingProjectLinks {
    const home = project.topics.find(({ id }) => id === project.manifest.homeTopicId) ??
      [...project.topics].sort((left, right) => left.id.localeCompare(right.id))[0];
    if (!home) return { projectId: project.manifest.id, groups: [], total: 0 };
    const topicIds = new Set(project.topics.map(({ id }) => id));
    const groups = new Map<EntityId, IncomingProjectLinks["groups"][number]["links"]>();
    for (const indexed of this.incomingByTargetProject.get(project.manifest.id) ?? []) {
      const topicId = indexed.targetTopicId && topicIds.has(indexed.targetTopicId) ? indexed.targetTopicId : home.id;
      const links = groups.get(topicId) ?? [];
      links.push({
        linkId: indexed.linkId,
        sourceInstanceId: indexed.sourceInstanceId,
        sourceProjectId: indexed.sourceProjectId,
        sourceProjectTitle: indexed.sourceProjectTitle,
        sourceTopicId: indexed.sourceTopicId,
        sourceTopicTitle: indexed.sourceTopicTitle,
        keyIssueId: indexed.keyIssueId,
        keyIssueTitle: indexed.keyIssueTitle,
        availability: indexed.availability
      });
      groups.set(topicId, links);
    }
    const ordered = [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([topicId, links]) => ({
        topicId,
        links: links.sort((left, right) =>
          left.sourceProjectTitle.localeCompare(right.sourceProjectTitle) ||
          left.sourceTopicTitle.localeCompare(right.sourceTopicTitle) ||
          left.keyIssueTitle.localeCompare(right.keyIssueTitle) ||
          left.linkId.localeCompare(right.linkId))
      }));
    return { projectId: project.manifest.id, groups: ordered, total: ordered.reduce((total, group) => total + group.links.length, 0) };
  }

  universe(assetUrl: (entry: WorkspaceProjectEntry) => string | undefined): WorkspaceUniverse {
    const selected = this.selectedEntries();
    const duplicateCounts = new Map<string, number>();
    for (const entry of Object.values(this.data.projects)) {
      duplicateCounts.set(entry.projectId, (duplicateCounts.get(entry.projectId) ?? 0) + 1);
    }
    const selectedProjectIds = new Set(selected.map(({ projectId }) => projectId));
    const nodes = selected.map((entry) => {
      const coverUrl = assetUrl(entry);
      return {
        instanceId: entry.instanceId,
        projectId: entry.projectId,
        title: entry.title,
        ...(entry.description ? { description: entry.description } : {}),
        status: entry.status,
        duplicateCount: duplicateCounts.get(entry.projectId) ?? 1,
        ...(entry.homeTopicId ? { homeTopicId: entry.homeTopicId } : {}),
        ...(entry.homeTopicTitle ? { homeTopicTitle: entry.homeTopicTitle } : {}),
        ...(coverUrl ? { coverUrl } : {}),
        ...(entry.lastOpenedAt ? { lastOpenedAt: entry.lastOpenedAt } : {})
      };
    });
    const counts = new Map<string, { sourceProjectId: string; targetProjectId: string; count: number }>();
    for (const entry of selected) {
      for (const link of entry.outgoingLinks) {
        if (!selectedProjectIds.has(link.targetProjectId)) continue;
        const key = `${entry.projectId}\u0000${link.targetProjectId}`;
        const current = counts.get(key);
        if (current) current.count += 1;
        else counts.set(key, { sourceProjectId: entry.projectId, targetProjectId: link.targetProjectId, count: 1 });
      }
    }
    const edges = [...counts.values()]
      .sort((left, right) => left.sourceProjectId.localeCompare(right.sourceProjectId) || left.targetProjectId.localeCompare(right.targetProjectId))
      .map((edge) => ({ id: `${edge.sourceProjectId}:${edge.targetProjectId}`, ...edge }));
    return { nodes, edges };
  }

  searchEntries(activeInstanceId: string): WorkspaceProjectEntry[] {
    const active = this.data.projects[activeInstanceId];
    const selected = this.selectedEntries().filter(({ projectId }) => !active || projectId !== active.projectId);
    selected.sort((left, right) =>
      (right.lastOpenedAt ?? "").localeCompare(left.lastOpenedAt ?? "") ||
      right.lastSeenAt.localeCompare(left.lastSeenAt) ||
      left.projectId.localeCompare(right.projectId));
    return [...(active ? [structuredClone(active)] : []), ...selected];
  }

  async refresh(): Promise<WorkspaceRegistryData> {
    await this.writeMerged(async (data) => {
      this.data = data;
      await this.refreshInMemory();
    });
    return this.list();
  }

  async register(directory: string, project: CanonicalProject, opened = false): Promise<WorkspaceProjectEntry> {
    let entry!: WorkspaceProjectEntry;
    await this.writeMerged(async (data) => {
      this.data = data;
      entry = await this.putProject(directory, project, opened);
    });
    return structuredClone(entry);
  }

  async registerDirectory(directory: string, opened = false, expectedProjectId?: string): Promise<WorkspaceProjectEntry> {
    const canonical = await canonicalDirectory(directory);
    const instanceId = await instanceIdForDirectory(canonical, this.platform);
    const expected = expectedProjectId ?? this.data.projects[instanceId]?.projectId;
    const result = await this.reader.read(canonical, expected);
    if (result.status !== "available" || !result.project) {
      throw new DomainError("invalid-command", result.status === "mismatch" ? "Selected folder contains a different Project" : `Project is ${result.status}`);
    }
    return this.register(directory, result.project, opened);
  }

  async removeFromRecent(instanceId: string): Promise<void> {
    await this.writeMerged((data) => {
      const entry = data.projects[instanceId];
      if (entry) entry.hiddenFromRecent = true;
      this.data = data;
    });
  }

  async forget(instanceId: string): Promise<void> {
    await this.writeMerged((data) => {
      delete data.projects[instanceId];
      for (const [projectId, preferred] of Object.entries(data.preferredInstance)) {
        if (preferred === instanceId) delete data.preferredInstance[projectId];
      }
      this.data = data;
    });
  }

  async setPreferred(projectId: string, instanceId?: string): Promise<void> {
    await this.writeMerged((data) => {
      if (instanceId) {
        const entry = data.projects[instanceId];
        if (!entry || entry.projectId !== projectId) throw new Error("Preferred Project instance does not match the Project ID");
        data.preferredInstance[projectId] = instanceId;
      } else delete data.preferredInstance[projectId];
      this.data = data;
    });
  }

  resolve(projectId: string): ProjectResolution {
    const projects = Object.values(this.data.projects).filter((entry) => entry.projectId === projectId);
    const available = projects.filter(({ status }) => status === "available" || status === "duplicate");
    const preferred = this.data.preferredInstance[projectId];
    const selected = preferred ? available.find(({ instanceId }) => instanceId === preferred) : undefined;
    if (selected) return { status: "resolved", project: structuredClone(selected) };
    if (available.length === 1) return { status: "resolved", project: structuredClone(available[0]!) };
    if (available.length > 1) return { status: "choose", projects: available.map((entry) => structuredClone(entry)) };
    return { status: "unavailable", projects: projects.map((entry) => structuredClone(entry)) };
  }

  async locate(instanceId: string, directory: string): Promise<WorkspaceProjectEntry> {
    const expected = this.data.projects[instanceId];
    if (!expected) throw new DomainError("not-found", "Workspace Project was not found");
    const result = await this.reader.read(directory, expected.projectId);
    if (result.status !== "available" || !result.project) throw new DomainError("invalid-command", result.status === "mismatch" ? "Selected folder contains a different Project" : `Project is ${result.status}`);
    let replacement!: WorkspaceProjectEntry;
    await this.writeMerged(async (data) => {
      const previous = data.projects[instanceId];
      delete data.projects[instanceId];
      this.data = data;
      replacement = await this.putProject(directory, result.project!, false, result.fingerprint);
      replacement.hiddenFromRecent = previous?.hiddenFromRecent ?? false;
      if (data.preferredInstance[expected.projectId] === instanceId) data.preferredInstance[expected.projectId] = replacement.instanceId;
    });
    return structuredClone(replacement);
  }

  async locateProject(projectId: string, directory: string): Promise<WorkspaceProjectEntry> {
    const result = await this.reader.read(directory, projectId);
    if (result.status !== "available" || !result.project) throw new DomainError("invalid-command", result.status === "mismatch" ? "Selected folder contains a different Project" : `Project is ${result.status}`);
    return this.register(directory, result.project, false);
  }

  private async addLegacyRecord(record: { directory: string; title: string; id: string }): Promise<void> {
    const result = await this.reader.read(record.directory, record.id);
    if (result.status === "available" && result.project) {
      await this.putProject(record.directory, result.project, false, result.fingerprint);
      return;
    }
    const directory = await canonicalDirectory(record.directory);
    const instanceId = await instanceIdForDirectory(directory, this.platform);
    const now = this.now();
    this.data.projects[instanceId] = {
      instanceId,
      directory,
      projectId: record.id,
      title: record.title,
      revision: 0,
      formatVersion: 1,
      ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}),
      status: result.status,
      firstSeenAt: now,
      lastSeenAt: now,
      lastOpenedAt: now,
      hiddenFromRecent: false,
      outgoingLinks: []
    };
  }

  private async putProject(
    directory: string,
    project: CanonicalProject,
    opened: boolean,
    fingerprint?: ProjectFingerprint
  ): Promise<WorkspaceProjectEntry> {
    const canonical = await canonicalDirectory(directory);
    const instanceId = await instanceIdForDirectory(canonical, this.platform);
    const previous = this.data.projects[instanceId];
    if (previous && previous.projectId !== project.manifest.id && this.data.preferredInstance[previous.projectId] === instanceId) {
      delete this.data.preferredInstance[previous.projectId];
    }
    const now = this.now();
    const home = project.topics.find(({ id }) => id === project.manifest.homeTopicId);
    const cover = project.assets.find(({ id }) => id === home?.visualAssetId);
    const actualFingerprint = fingerprint ?? (await this.reader.probe(canonical)).fingerprint;
    const entry: WorkspaceProjectEntry = {
      instanceId,
      directory: canonical,
      projectId: project.manifest.id,
      title: project.manifest.title,
      ...(project.manifest.description ? { description: project.manifest.description } : {}),
      ...(home ? { homeTopicId: home.id, homeTopicTitle: home.title } : {}),
      ...(cover ? { homeCoverAssetPath: cover.path, homeCoverMimeType: cover.mimeType } : {}),
      revision: project.manifest.revision,
      formatVersion: project.manifest.formatVersion,
      ...(actualFingerprint ? { fingerprint: actualFingerprint } : {}),
      status: "available",
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
      ...((opened || previous?.lastOpenedAt) ? { lastOpenedAt: opened ? now : previous?.lastOpenedAt } : {}),
      hiddenFromRecent: opened ? false : previous?.hiddenFromRecent ?? false,
      outgoingLinks: project.projectLinks.map((link) => ({
        id: link.id,
        sourceTopicId: link.sourceTopicId,
        ...(project.topics.find(({ id }) => id === link.sourceTopicId)?.title
          ? { sourceTopicTitle: project.topics.find(({ id }) => id === link.sourceTopicId)!.title }
          : {}),
        keyIssueId: link.keyIssueId,
        ...(project.keyIssues.find(({ id }) => id === link.keyIssueId)?.title
          ? { keyIssueTitle: project.keyIssues.find(({ id }) => id === link.keyIssueId)!.title }
          : {}),
        targetProjectId: link.targetProjectId,
        ...(link.targetTopicId ? { targetTopicId: link.targetTopicId } : {}),
        cachedProjectTitle: link.cachedProjectTitle,
        ...(link.cachedTopicTitle ? { cachedTopicTitle: link.cachedTopicTitle } : {})
      }))
    };
    this.data.projects[instanceId] = entry;
    recomputeDuplicateStatuses(this.data);
    return entry;
  }

  private async refreshInMemory(): Promise<void> {
    for (const entry of Object.values(this.data.projects)) {
      const probe = await this.reader.probe(entry.directory);
      if (probe.status === "missing" || probe.status === "unreadable" || probe.status === "needs-open") {
        entry.status = probe.status;
        if (probe.fingerprint) entry.fingerprint = probe.fingerprint;
        entry.lastSeenAt = this.now();
        continue;
      }
      const completeCache = entry.outgoingLinks.every(({ sourceTopicTitle, keyIssueTitle }) => sourceTopicTitle && keyIssueTitle) &&
        (!entry.homeCoverAssetPath || Boolean(entry.homeCoverMimeType));
      if (sameFingerprint(entry.fingerprint, probe.fingerprint) && completeCache && (entry.status === "available" || entry.status === "duplicate" || entry.status === "mismatch")) continue;
      const result = await this.reader.read(entry.directory, entry.projectId);
      if (result.status === "available" && result.project) {
        await this.putProject(entry.directory, result.project, false, result.fingerprint);
      } else {
        entry.status = result.status;
        if (result.fingerprint) entry.fingerprint = result.fingerprint;
        entry.lastSeenAt = this.now();
      }
    }
    recomputeDuplicateStatuses(this.data);
  }

  private async readDisk(): Promise<WorkspaceRegistryData> {
    try {
      return parseRegistry(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("Workspace registry"))) {
        return EMPTY_REGISTRY();
      }
      throw error;
    }
  }

  private async writeMerged(operation: (data: WorkspaceRegistryData) => void | Promise<void>): Promise<void> {
    const disk = await this.readDisk();
    const merged = mergeRegistry(disk, this.data);
    await operation(merged);
    this.data = merged;
    recomputeDuplicateStatuses(this.data);
    this.rebuildIncomingIndex();
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }

  private selectedEntries(): WorkspaceProjectEntry[] {
    const groups = new Map<string, WorkspaceProjectEntry[]>();
    for (const entry of Object.values(this.data.projects)) {
      const entries = groups.get(entry.projectId) ?? [];
      entries.push(entry);
      groups.set(entry.projectId, entries);
    }
    return [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectId, entries]) => {
        const preferred = this.data.preferredInstance[projectId];
        return structuredClone(
          entries.find(({ instanceId }) => instanceId === preferred) ??
          [...entries].sort((left, right) =>
            (right.lastOpenedAt ?? "").localeCompare(left.lastOpenedAt ?? "") ||
            right.lastSeenAt.localeCompare(left.lastSeenAt) ||
            left.instanceId.localeCompare(right.instanceId))[0]!
        );
      });
  }

  private rebuildIncomingIndex(): void {
    const next = new Map<EntityId, Array<{
      linkId: EntityId;
      sourceInstanceId: string;
      sourceProjectId: EntityId;
      sourceProjectTitle: string;
      sourceTopicId: EntityId;
      sourceTopicTitle: string;
      keyIssueId: EntityId;
      keyIssueTitle: string;
      targetTopicId?: EntityId;
      availability: "available" | "unavailable";
    }>>();
    for (const source of Object.values(this.data.projects)) {
      const availability = source.status === "available" || source.status === "duplicate" ? "available" : "unavailable";
      for (const link of source.outgoingLinks) {
        const links = next.get(link.targetProjectId) ?? [];
        links.push({
          linkId: link.id,
          sourceInstanceId: source.instanceId,
          sourceProjectId: source.projectId,
          sourceProjectTitle: source.title,
          sourceTopicId: link.sourceTopicId,
          sourceTopicTitle: link.sourceTopicTitle ?? link.sourceTopicId,
          keyIssueId: link.keyIssueId,
          keyIssueTitle: link.keyIssueTitle ?? link.keyIssueId,
          ...(link.targetTopicId ? { targetTopicId: link.targetTopicId } : {}),
          availability
        });
        next.set(link.targetProjectId, links);
      }
    }
    this.incomingByTargetProject = next;
  }
}
