import type { Asset, CanonicalProject } from "../../domain/types.js";
import type { PublishedSnapshot } from "../../domain/types.js";
import type { SearchPage, SearchQuery } from "../../search/search-adapter.js";
import type { FolderImportJob, FolderImportOptions, FolderImportPlan } from "../../domain/folder-import.js";

let currentProject: { id: string; revision: number } | undefined;
export function trackProject(project: CanonicalProject): void { currentProject = project.manifest; }
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

export interface ProjectMutationResponse {
  project: CanonicalProject;
  history: HistoryState;
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
    target: { kind: "topic" | "keyIssue"; id: string },
    onProgress?: UploadProgress
  ): Promise<ProjectAssetMutationResponse>;
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
  exportProject(): Promise<void>;
  previewImport(file: File, onProgress?: UploadProgress): Promise<ImportPlan>;
  commitImport(planId: string, directoryName: string): Promise<{ plan: ImportPlan; projectDirectory: string; project?: CanonicalProject; history?: HistoryState }>;
  cancelImport(planId: string): Promise<void>;
}

export type ProjectSearch = (query: SearchQuery) => Promise<SearchPage>;

async function requestJson<T>(url: string, init: RequestInit = {}, includeProjectHeaders = true): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(includeProjectHeaders && init.method && init.method !== "GET" ? projectHeaders() : {}), ...init.headers }
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
    throw new ProjectRequestError(detail?.error ?? `Project request failed with status ${response.status}`, detail?.code);
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
  publish(): Promise<ProjectMutationResponse>;
}

export const projectApi: ProjectApi = {
  createTopic: (input) => requestJson("/api/topics", { method: "POST", body: JSON.stringify(input) }),
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
  createKnowledge: (input) =>
    requestJson("/api/knowledge", { method: "POST", body: JSON.stringify(input) }),
  updateKnowledgeAssociation: (id, patch) =>
    requestJson(`/api/knowledge-associations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    }),
  undo: () => requestJson("/api/history/undo", { method: "POST", body: "{}" }),
  redo: () => requestJson("/api/history/redo", { method: "POST", body: "{}" }),
  publish: () => requestJson("/api/publish", { method: "POST", body: "{}" })
};

async function responseError(response: Response): Promise<Error> {
  const detail = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
  return new ProjectRequestError(detail?.error ?? `Project request failed with status ${response.status}`, detail?.code);
}

function upload<T>(url: string, headers: Record<string, string>, body: File, onProgress?: UploadProgress): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.responseType = "text";
    request.upload.onprogress = (event) => { if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total); };
    request.onerror = () => reject(new ProjectRequestError("The upload could not reach Outmapper. Check that it is still running."));
    request.onabort = () => reject(new ProjectRequestError("The upload was interrupted."));
    request.onload = () => {
      let detail: { error?: string; code?: string } | null;
      try { detail = JSON.parse(request.responseText) as { error?: string; code?: string }; } catch { detail = null; }
      if (request.status >= 200 && request.status < 300 && detail) resolve(detail as T);
      else reject(new ProjectRequestError(detail?.error ?? `Project request failed with status ${request.status}`, detail?.code));
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
  }, file, onProgress)
};

export const projectTransferApi: ProjectTransferApi = {
  exportProject: async () => {
    const response = await fetch("/api/packages/export", { headers: { Accept: "application/vnd.outmapper.package+zip" } });
    if (!response.ok) throw await responseError(response);
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const filename = /filename="([^"]+)"/u.exec(disposition)?.[1] ?? "project.outmapper";
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  },
  previewImport: (file, onProgress) => upload<ImportPlan>("/api/packages/import/preview", {
    Accept: "application/json",
    "Content-Type": "application/vnd.outmapper.package+zip",
    "X-Outmapper-Filename": encodeURIComponent(file.name)
  }, file, onProgress),
  commitImport: (planId, directoryName) =>
    requestJson(`/api/packages/import/${encodeURIComponent(planId)}/commit`, {
      method: "POST",
      body: JSON.stringify({ directoryName })
    }, false),
  cancelImport: async (planId) => {
    const response = await fetch(`/api/packages/import/${encodeURIComponent(planId)}`, { method: "DELETE" });
    if (!response.ok) throw await responseError(response);
  }
};

export interface ProjectLibraryApi {
  recent(): Promise<{ directory: string; projects: Array<{ directory: string; title: string; id: string }> }>;
  create(title: string, locale: string): Promise<ProjectMutationResponse>;
  open(directory?: string): Promise<ProjectMutationResponse | { cancelled: true }>;
}
export const projectLibraryApi: ProjectLibraryApi = {
  recent: () => requestJson("/api/projects/recent"),
  create: (title, locale) => requestJson("/api/projects/new", { method: "POST", body: JSON.stringify({ title, locale }) }, false),
  open: (directory) => requestJson("/api/projects/open", { method: "POST", body: JSON.stringify({ directory }) }, false)
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

export const searchProject: ProjectSearch = (query) => {
  const parameters = new URLSearchParams({ q: query.text });
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
  return requestJson<SearchPage>(`/api/search?${parameters.toString()}`);
};
