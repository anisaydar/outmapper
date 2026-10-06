import type { Asset, CanonicalProject, JsonObject } from "../../domain/types.js";
import type { IncomingProjectLinks, ProjectResolution, WorkspaceProjectEntry, WorkspaceRegistryData, WorkspaceUniverse } from "../../domain/workspace.js";
import type { PublishedSnapshot } from "../../domain/types.js";
import type { SearchPage, SearchQuery } from "../../search/search-adapter.js";
import type { FolderImportJob, FolderImportOptions, FolderImportPlan } from "../../domain/folder-import.js";
import type { Locale } from "../locales.js";
import { localizeServerError } from "../server-error-locales.js";

let currentProject: { id: string; revision: number } | undefined;
let requestLocale: Locale = "en";
export function trackProject(project: CanonicalProject): void { currentProject = project.manifest; }
export function setRequestLocale(locale: Locale): void { requestLocale = locale; }
function projectHeaders(): Record<string, string> {
  return currentProject ? { "X-Outmapper-Project-Id": currentProject.id, "X-Outmapper-Revision": String(currentProject.revision) } : {};
}
export class ProjectRequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

export type ProjectLoader = () => Promise<CanonicalProject>;

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

/** A session history position: absolute undo depth plus the Project revision seen there. */
export interface HistoryCheckpoint {
  depth: number;
  revision: number;
}

export type EntityTarget = { kind: "topic" | "keyIssue"; id: string };

export interface ProjectMutationResponse {
  project: CanonicalProject;
  history: HistoryState;
  instanceId?: string;
  historyCleared?: boolean;
  snapshot?: PublishedSnapshot;
}

export interface ProjectAssetMutationResponse extends ProjectMutationResponse {
  asset: Asset;
  extraction: "queued" | "not-applicable";
}

export type UploadProgress = (fraction: number) => void;

export interface ProjectAssetApi {
  attachAsset(
    file: File,
    target: EntityTarget,
    onProgress?: UploadProgress
  ): Promise<ProjectAssetMutationResponse>;
  setCover(file: File, target: EntityTarget, onProgress?: UploadProgress): Promise<ProjectMutationResponse & { asset: Asset }>;
  removeCover(target: EntityTarget): Promise<ProjectMutationResponse>;
}

export interface ImportPlan {
  id: string;
  projectId: string;
  projectTitle: string;
  projectRevision: number;
  formatVersion: number;
  compressedBytes: number;
  expandedBytes: number;
  entryCount: number;
  assetCount: number;
  missingAssets: string[];
  warnings: string[];
  suggestedDirectoryName: string;
}

export interface ProjectTransferApi {
  exportProject(): Promise<number>;
  previewImport(file: File, onProgress?: UploadProgress): Promise<ImportPlan>;
  commitImport(planId: string, directoryName: string, mode?: "copy" | "anyway"): Promise<{ plan: ImportPlan; projectDirectory: string; project?: CanonicalProject; history?: HistoryState; instanceId?: string; historyCleared?: boolean }>;
  cancelImport(planId: string): Promise<void>;
}

export type ProjectSearch = (query: SearchQuery) => Promise<SearchPage>;

async function requestJson<T>(url: string, init: RequestInit = {}, includeProjectHeaders = true): Promise<T> {
  // Fastify rejects an empty body declared as JSON, so bodyless requests (such as most DELETEs) omit Content-Type.
  const response = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...(includeProjectHeaders && init.method && init.method !== "GET" ? projectHeaders() : {}), ...init.headers }
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
    const fallback = detail?.error ?? `Project request failed with status ${response.status}`;
    throw new ProjectRequestError(localizeServerError(detail?.code, requestLocale, fallback), detail?.code);
  }
  return (await response.json()) as T;
}

export const loadConfiguredProject: ProjectLoader = async () => {
  const project = await requestJson<CanonicalProject>("/api/project");
  trackProject(project);
  return project;
};

export interface ProjectApi {
  createTopic(input: { title: string; description?: string }): Promise<ProjectMutationResponse>;
  createAndConnectTopic(input: { sourceTopicId: string; keyIssueId: string; title: string }): Promise<ProjectMutationResponse>;
  updateProject(patch: { title?: string; description?: string; homeTopicId?: string }): Promise<ProjectMutationResponse>;
  editKnowledge(associationId: string, input: { title: string; body?: string; summary?: string; externalUrl?: string; scope: "context" | "all" }): Promise<ProjectMutationResponse>;
  removeKnowledge(associationId: string, scope: "context" | "all"): Promise<ProjectMutationResponse>;
  updateTopic(id: string, patch: { title?: string; description?: string }): Promise<ProjectMutationResponse>;
  updateKeyIssue(id: string, patch: { title?: string; description?: string; order?: number }): Promise<ProjectMutationResponse>;
  deleteTopic(id: string): Promise<ProjectMutationResponse>;
  deleteKeyIssue(id: string): Promise<ProjectMutationResponse>;
  createKeyIssue(input: { topicId: string; title: string; description?: string }): Promise<ProjectMutationResponse>;
  reorderKeyIssues(topicId: string, ids: string[]): Promise<ProjectMutationResponse>;
  connectTopics(input: { sourceTopicId: string; keyIssueId: string; targetTopicId: string }): Promise<ProjectMutationResponse>;
  disconnectRelationship(id: string): Promise<ProjectMutationResponse>;
  reorderRelationships(keyIssueId: string, ids: string[]): Promise<ProjectMutationResponse>;
  linkProject(input: { sourceTopicId: string; keyIssueId: string; targetProjectId: string; targetTopicId?: string; cachedProjectTitle: string; cachedTopicTitle?: string; note?: string; metadata?: JsonObject }): Promise<ProjectMutationResponse>;
  unlinkProject(id: string): Promise<ProjectMutationResponse>;
  reorderKeyIssueTargets(keyIssueId: string, ids: string[]): Promise<ProjectMutationResponse>;
  createKnowledge(input: {
    title: string;
    body?: string;
    type?: string;
    availability?: "local" | "external";
    externalUrl?: string;
    targetKind: "topic" | "keyIssue";
    targetId: string;
  }): Promise<ProjectMutationResponse>;
  updateKnowledgeAssociation(id: string, patch: { pinned?: boolean }): Promise<ProjectMutationResponse>;
  undo(): Promise<ProjectMutationResponse>;
  redo(): Promise<ProjectMutationResponse>;
  checkpoint(): Promise<{ checkpoint: HistoryCheckpoint; history: HistoryState }>;
  revert(checkpoint: HistoryCheckpoint): Promise<ProjectMutationResponse>;
  publish(): Promise<ProjectMutationResponse>;
}

export const projectApi: ProjectApi = {
  createTopic: (input) => requestJson("/api/topics", { method: "POST", body: JSON.stringify(input) }),
  createAndConnectTopic: (input) => requestJson("/api/relationships/new-topic", { method: "POST", body: JSON.stringify(input) }),
  updateProject: (patch) => requestJson("/api/project", { method: "PATCH", body: JSON.stringify(patch) }),
  editKnowledge: (id, input) => requestJson(`/api/knowledge-associations/${encodeURIComponent(id)}/item`, { method: "PATCH", body: JSON.stringify(input) }),
  removeKnowledge: (id, scope) => requestJson(`/api/knowledge-associations/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ scope }) }),
  updateTopic: (id, patch) =>
    requestJson(`/api/topics/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  updateKeyIssue: (id, patch) =>
    requestJson(`/api/key-issues/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteTopic: (id) =>
    requestJson(`/api/topics/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ removeReferences: true }) }),
  deleteKeyIssue: (id) =>
    requestJson(`/api/key-issues/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ removeReferences: true }) }),
  createKeyIssue: (input) =>
    requestJson("/api/key-issues", { method: "POST", body: JSON.stringify(input) }),
  reorderKeyIssues: (topicId, ids) =>
    requestJson(`/api/topics/${encodeURIComponent(topicId)}/key-issue-order`, {
      method: "PUT",
      body: JSON.stringify({ ids })
    }),
  connectTopics: (input) =>
    requestJson("/api/relationships", { method: "POST", body: JSON.stringify(input) }),
  disconnectRelationship: (id) =>
    requestJson(`/api/relationships/${encodeURIComponent(id)}`, { method: "DELETE" }),
  reorderRelationships: (keyIssueId, ids) =>
    requestJson(`/api/key-issues/${encodeURIComponent(keyIssueId)}/relationship-order`, {
      method: "PUT",
      body: JSON.stringify({ ids })
    }),
  linkProject: (input) => requestJson("/api/project-links", { method: "POST", body: JSON.stringify(input) }),
  unlinkProject: (id) => requestJson(`/api/project-links/${encodeURIComponent(id)}`, { method: "DELETE" }),
  reorderKeyIssueTargets: (keyIssueId, ids) => requestJson(`/api/key-issues/${encodeURIComponent(keyIssueId)}/target-order`, { method: "PUT", body: JSON.stringify({ ids }) }),
  createKnowledge: (input) =>
    requestJson("/api/knowledge", { method: "POST", body: JSON.stringify(input) }),
  updateKnowledgeAssociation: (id, patch) =>
    requestJson(`/api/knowledge-associations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    }),
  undo: () => requestJson("/api/history/undo", { method: "POST", body: "{}" }),
  redo: () => requestJson("/api/history/redo", { method: "POST", body: "{}" }),
  checkpoint: () => requestJson("/api/history/checkpoint", { method: "POST", body: "{}" }),
  revert: (checkpoint) => requestJson("/api/history/revert", { method: "POST", body: JSON.stringify({ checkpoint }) }),
  publish: () => requestJson("/api/publish", { method: "POST", body: "{}" })
};

async function responseError(response: Response): Promise<Error> {
  const detail = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
  const fallback = detail?.error ?? `Project request failed with status ${response.status}`;
  return new ProjectRequestError(localizeServerError(detail?.code, requestLocale, fallback), detail?.code);
}

function upload<T>(url: string, headers: Record<string, string>, body: File, onProgress?: UploadProgress, method = "POST"): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, url);
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.responseType = "text";
    request.upload.onprogress = (event) => { if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total); };
    request.onerror = () => reject(new ProjectRequestError("The upload could not reach Outmapper. Check that it is still running."));
    request.onabort = () => reject(new ProjectRequestError("The upload was interrupted."));
    request.onload = () => {
      let detail: { error?: string; code?: string } | null;
      try { detail = JSON.parse(request.responseText) as { error?: string; code?: string }; } catch { detail = null; }
      if (request.status >= 200 && request.status < 300 && detail) resolve(detail as T);
      else {
        const fallback = detail?.error ?? `Project request failed with status ${request.status}`;
        reject(new ProjectRequestError(localizeServerError(detail?.code, requestLocale, fallback), detail?.code));
      }
    };
    request.send(body);
  });
}

export const projectAssetApi: ProjectAssetApi = {
  attachAsset: (file, target, onProgress) => upload<ProjectAssetMutationResponse>("/api/assets", {
    ...projectHeaders(),
    Accept: "application/json",
    "Content-Type": "application/vnd.outmapper.asset",
    "X-Outmapper-Filename": encodeURIComponent(file.name),
    "X-Outmapper-Mime": file.type || "application/octet-stream",
    "X-Outmapper-Target-Kind": target.kind,
    "X-Outmapper-Target-Id": target.id
  }, file, onProgress),
  setCover: (file, target, onProgress) => upload(coverUrl(target), {
    ...projectHeaders(),
    Accept: "application/json",
    "Content-Type": "application/vnd.outmapper.asset",
    "X-Outmapper-Filename": encodeURIComponent(file.name)
  }, file, onProgress, "PUT"),
  removeCover: (target) => requestJson(coverUrl(target), { method: "DELETE", body: "{}" })
};

function coverUrl(target: EntityTarget): string {
  return `/api/${target.kind === "topic" ? "topics" : "key-issues"}/${encodeURIComponent(target.id)}/cover`;
}

export const projectTransferApi: ProjectTransferApi = {
  exportProject: async () => {
    const response = await fetch("/api/packages/export", { headers: { Accept: "application/vnd.outmapper.package+zip" } });
    if (!response.ok) throw await responseError(response);
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const linkCount = Number(response.headers.get("X-Outmapper-Project-Link-Count") ?? "0");
    const filename = /filename="([^"]+)"/u.exec(disposition)?.[1] ?? "project.outmapper";
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    return Number.isSafeInteger(linkCount) && linkCount > 0 ? linkCount : 0;
  },
  previewImport: (file, onProgress) => upload<ImportPlan>("/api/packages/import/preview", {
    Accept: "application/json",
    "Content-Type": "application/vnd.outmapper.package+zip",
    "X-Outmapper-Filename": encodeURIComponent(file.name)
  }, file, onProgress),
  commitImport: (planId, directoryName, mode) =>
    requestJson(`/api/packages/import/${encodeURIComponent(planId)}/commit`, {
      method: "POST",
      body: JSON.stringify({ directoryName, mode })
    }, false),
  cancelImport: async (planId) => {
    const response = await fetch(`/api/packages/import/${encodeURIComponent(planId)}`, { method: "DELETE" });
    if (!response.ok) throw await responseError(response);
  }
};

export interface ProjectLibraryApi {
  workspace(): Promise<WorkspaceRegistryData & { activeInstanceId: string }>;
  refresh(): Promise<WorkspaceRegistryData & { activeInstanceId: string }>;
  create(title: string, locale: string): Promise<ProjectMutationResponse>;
  open(): Promise<ProjectMutationResponse | { cancelled: true }>;
  activate(instanceId: string): Promise<ProjectMutationResponse>;
  topics(instanceId: string): Promise<{ projectId: string; homeTopicId?: string; topics: CanonicalProject["topics"] }>;
  resolve(projectId: string): Promise<ProjectResolution>;
  prefer(projectId: string, instanceId?: string): Promise<void>;
  locate(instanceId: string): Promise<{ project: WorkspaceProjectEntry } | { cancelled: true }>;
  locateProject(projectId: string): Promise<{ project: WorkspaceProjectEntry } | { cancelled: true }>;
  removeFromRecent(instanceId: string): Promise<void>;
  forget(instanceId: string): Promise<void>;
  newIdentity(instanceId: string): Promise<ProjectMutationResponse>;
  saveCopy(): Promise<{ project: WorkspaceProjectEntry }>;
  reload(): Promise<ProjectMutationResponse>;
  incoming?(): Promise<IncomingProjectLinks>;
  universe?(): Promise<WorkspaceUniverse>;
}

async function requestEmpty(url: string, init: RequestInit, includeProjectHeaders = true): Promise<void> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(includeProjectHeaders ? projectHeaders() : {}), ...init.headers }
  });
  if (!response.ok) throw await responseError(response);
}
export const projectLibraryApi: ProjectLibraryApi = {
  workspace: () => requestJson("/api/workspace/projects"),
  refresh: () => requestJson("/api/workspace/refresh", { method: "POST", body: "{}" }, false),
  create: (title, locale) => requestJson("/api/projects/new", { method: "POST", body: JSON.stringify({ title, locale }) }, false),
  open: () => requestJson("/api/projects/open", { method: "POST", body: "{}" }, false),
  activate: (instanceId) => requestJson(`/api/workspace/projects/${encodeURIComponent(instanceId)}/activate`, { method: "POST", body: "{}" }, false),
  topics: (instanceId) => requestJson(`/api/workspace/projects/${encodeURIComponent(instanceId)}/topics`),
  resolve: (projectId) => requestJson(`/api/workspace/resolve/${encodeURIComponent(projectId)}`),
  prefer: (projectId, instanceId) => requestEmpty(`/api/workspace/preferred/${encodeURIComponent(projectId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instanceId }) }, false),
  locate: (instanceId) => requestJson(`/api/workspace/projects/${encodeURIComponent(instanceId)}/locate`, { method: "POST", body: "{}" }, false),
  locateProject: (projectId) => requestJson(`/api/workspace/locate/${encodeURIComponent(projectId)}`, { method: "POST", body: "{}" }, false),
  removeFromRecent: (instanceId) => requestEmpty(`/api/workspace/projects/${encodeURIComponent(instanceId)}/remove-from-recent`, { method: "POST" }, false),
  forget: (instanceId) => requestEmpty(`/api/workspace/projects/${encodeURIComponent(instanceId)}`, { method: "DELETE" }, false),
  newIdentity: (instanceId) => requestJson(`/api/workspace/projects/${encodeURIComponent(instanceId)}/new-identity`, { method: "POST", body: "{}" }, false),
  saveCopy: () => requestJson("/api/project/save-copy", { method: "POST", body: "{}" }),
  reload: () => requestJson("/api/project/reload", { method: "POST", body: "{}" }, false),
  incoming: () => requestJson("/api/workspace/incoming"),
  universe: () => requestJson("/api/workspace/universe")
};
export interface FolderImportApi {
  preview(signal: AbortSignal): Promise<FolderImportPlan | { cancelled: true }>;
  discard(id: string): Promise<void>;
  start(id: string, options: FolderImportOptions): Promise<FolderImportJob>;
  status(id: string): Promise<{ job: FolderImportJob; project?: CanonicalProject; history?: HistoryState }>;
  cancel(id: string): Promise<void>;
}
export const folderImportApi: FolderImportApi = {
  preview: (signal) => requestJson("/api/folder-import/preview", { method: "POST", body: "{}", signal }),
  discard: async (id) => { const response = await fetch(`/api/folder-import/plans/${encodeURIComponent(id)}`, { method: "DELETE", headers: projectHeaders() }); if (!response.ok) throw await responseError(response); },
  start: (id, options) => requestJson(`/api/folder-import/plans/${encodeURIComponent(id)}/start`, { method: "POST", body: JSON.stringify(options) }),
  status: (id) => requestJson(`/api/folder-import/jobs/${encodeURIComponent(id)}`),
  cancel: async (id) => { const response = await fetch(`/api/folder-import/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }); if (!response.ok) throw await responseError(response); }
};

let activeSearch: AbortController | undefined;
export const searchProject: ProjectSearch = (query) => {
  activeSearch?.abort();
  activeSearch = new AbortController();
  const parameters = new URLSearchParams({ q: query.text });
  if (query.scope) parameters.set("scope", query.scope);
  if (query.continuation) parameters.set("continuation", query.continuation);
  if (query.match) parameters.set("match", query.match);
  if (query.cursor) parameters.set("cursor", query.cursor);
  if (query.limit !== undefined) parameters.set("limit", String(query.limit));
  const fields: Array<[keyof NonNullable<SearchQuery["filters"]>, string]> = [
    ["entityKinds", "kinds"],
    ["types", "types"],
    ["topicIds", "topics"],
    ["tags", "tags"],
    ["authors", "authors"],
    ["sources", "sources"]
  ];
  for (const [field, parameter] of fields) {
    const values = query.filters?.[field];
    if (values?.length) parameters.set(parameter, values.join(","));
  }
  return requestJson<SearchPage>(`/api/search?${parameters.toString()}`, { signal: activeSearch.signal });
};
