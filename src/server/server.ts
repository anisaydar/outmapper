import fs from "node:fs";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/project-service.js";
import type { CanonicalProject, JsonObject } from "../domain/types.js";
import { AssetStoreError, COVER_HEADER_BYTES, COVER_IMAGE_TYPES, FileSystemAssetStore, inspectCoverImage, sniffAssetMime } from "../project/asset-store.js";
import { DocumentExtractionStore } from "../project/document-extraction-store.js";
import { FileSystemProjectStore } from "../project/filesystem-project-store.js";
import {
  DEFAULT_PACKAGE_LIMITS,
  ProjectPackageError,
  ProjectPackageService
} from "../project/project-package.js";
import { FileSystemSnapshotManifestStore, PublicationService } from "../project/publication-service.js";
import { PdfExtractionService } from "../project/pdf-extraction-service.js";
import { ProjectValidationError } from "../project/validation.js";
import { RUNTIME_DATABASE_PATH, SqliteSearchAdapter } from "../search/sqlite-search-adapter.js";
import type { SearchEntityKind, SearchQuery } from "../search/search-adapter.js";
import { WorkspaceSearchError, WorkspaceSearchService } from "../search/workspace-search.js";
import type { ServerConfig } from "./config.js";
import { ProjectLibrary } from "./project-library.js";
import { selectNativeFolder } from "./native-folder-picker.js";
import { FolderImportService } from "../project/folder-import-service.js";
import type { FolderImportOptions } from "../domain/folder-import.js";
import { APPLICATION_VERSION } from "../version.js";
import { WorkspaceRegistry, instanceIdForDirectory } from "./workspace-registry.js";
import { SessionHistoryManager } from "./session-history-manager.js";
import { resolveProjectPath } from "../project/paths.js";

export async function buildServer(config: ServerConfig, options: { selectFolder?: () => Promise<string | null> } = {}) {
  const server = Fastify({ logger: false });
  const library = new ProjectLibrary(config);
  let activeDirectory = await library.prepare();
  const histories = new SessionHistoryManager();
  let activeInstanceId = await instanceIdForDirectory(activeDirectory);
  const initialActivation = await histories.activate(activeInstanceId, activeDirectory);
  let projectStore = initialActivation.store;
  let projectService = new ProjectService(projectStore);
  let commandHistory = initialActivation.history;
  const registry = new WorkspaceRegistry({ stateDirectory: config.stateDirectory ?? library.projectsDirectory });
  await registry.initialize(activeDirectory, initialActivation.project);
  const workspaceSearch = new WorkspaceSearchService();
  let publicationService = new PublicationService(
    projectStore,
    new FileSystemSnapshotManifestStore(activeDirectory)
  );
  let packageService = new ProjectPackageService({ projectDirectory: activeDirectory, projectsDirectory: library.projectsDirectory });
  let assetStore = new FileSystemAssetStore(activeDirectory);
  let extractionStore = new DocumentExtractionStore(activeDirectory);
  let pdfExtraction = new PdfExtractionService(activeDirectory);
  let searchAdapter: SqliteSearchAdapter | undefined;
  let pending: Promise<void> = Promise.resolve();
  const acquire = async () => {
    const previous = pending;
    let release!: () => void;
    pending = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  };
  const exclusive = async <T,>(operation: () => Promise<T>): Promise<T> => {
    const release = await acquire();
    try { return await operation(); } finally { release(); }
  };
  let folderImport: FolderImportService;
  const makeFolderImport = () => new FolderImportService(projectStore, projectService, commandHistory, exclusive, (assets) => {
    for (const asset of assets) queuePdfExtraction(asset);
  });
  folderImport = makeFolderImport();
  const activate = async (instanceId: string) => {
    if (folderImport.busy) throw new DomainError("conflicting-save", "Finish or cancel the folder import before switching Projects.");
    const entry = registry.get(instanceId);
    if (!entry) throw new DomainError("not-found", "Workspace Project was not found.");
    if (entry.status === "missing" || entry.status === "mismatch" || entry.status === "unreadable") {
      throw new DomainError("not-found", `Project is ${entry.status}.`);
    }
    const activation = await histories.activate(instanceId, entry.directory);
    const project = activation.project;
    await folderImport.dispose();
    await packageService.dispose();
    await pdfExtraction.dispose();
    searchAdapter?.close();
    searchAdapter = undefined;
    activeDirectory = entry.directory;
    activeInstanceId = instanceId;
    projectStore = activation.store;
    projectService = new ProjectService(projectStore);
    commandHistory = activation.history;
    publicationService = new PublicationService(projectStore, new FileSystemSnapshotManifestStore(activeDirectory));
    packageService = new ProjectPackageService({ projectDirectory: activeDirectory, projectsDirectory: library.projectsDirectory });
    assetStore = new FileSystemAssetStore(activeDirectory);
    extractionStore = new DocumentExtractionStore(activeDirectory);
    pdfExtraction = new PdfExtractionService(activeDirectory);
    folderImport = makeFolderImport();
    reconcileRuntime(project);
    await registry.register(activeDirectory, project, true);
    return { project, history: commandHistory.state, instanceId: activeInstanceId, directory: activeDirectory, historyCleared: activation.historyCleared };
  };

  const reconcileRuntime = (project: CanonicalProject) => {
    searchAdapter ??= SqliteSearchAdapter.open(activeDirectory);
    return searchAdapter.reconcile(project);
  };
  const mutationResult = async () => {
    const project = await projectStore.load();
    const runtime = reconcileRuntime(project);
    await histories.markCurrent(project);
    await registry.register(activeDirectory, project);
    return { project, history: commandHistory.state, runtime, instanceId: activeInstanceId };
  };
  const failure = (reply: FastifyReply, status: number, code: string, message: string, details: Record<string, unknown> = {}) =>
    reply.code(status).send({ error: message, code, ...details });
  const domainFailure = (reply: FastifyReply, error: unknown) => {
    if (error instanceof DomainError) {
      const status = error.code === "not-found" ? 404 : error.code === "dependent-references" || error.code === "conflicting-save" || error.code === "checkpoint-unavailable" ? 409 : 400;
      return reply.code(status).send({
        error: error.message,
        code: error.code,
        ...(error.path ? { path: error.path } : {}),
        ...(error.references ? { references: error.references } : {})
      });
    }
    if (error instanceof ProjectValidationError) {
      return failure(reply, 422, "project-validation", "Project validation failed", { issues: error.issues });
    }
    if (error instanceof ProjectPackageError) {
      const status =
        error.code === "plan-not-found" ? 404 :
        error.code === "destination-exists" ? 409 :
        error.code === "archive-limit" ? 413 :
        400;
      return reply.code(status).send({ error: error.message, code: error.code });
    }
    if (error instanceof AssetStoreError) {
      const status = error.code === "asset-limit" ? 413 : error.code === "asset-exists" ? 409 : error.code === "unsupported-cover" ? 415 : 400;
      return reply.code(status).send({ error: error.message, code: error.code });
    }
    if (error instanceof WorkspaceSearchError) {
      return failure(reply, error.code === "search-cancelled" ? 409 : 500, error.code, error.message);
    }
    throw error;
  };

  server.addContentTypeParser("application/vnd.outmapper.package+zip", (request, payload, done) => {
    void request;
    done(null, payload);
  });
  server.addContentTypeParser("application/vnd.outmapper.asset", (request, payload, done) => {
    void request;
    done(null, payload);
  });

  server.addHook("onClose", async () => {
    await folderImport.dispose();
    searchAdapter?.close();
    await workspaceSearch.close();
    await packageService.dispose();
    await pdfExtraction.dispose();
  });

  const releases = new WeakMap<FastifyRequest, () => void>();
  const releaseRequest = (request: FastifyRequest) => {
    const release = releases.get(request);
    if (!release) return;
    releases.delete(request);
    release();
  };
  server.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.method === "GET" && request.url.startsWith("/api/search") && request.url.includes("scope=workspace")) return;
    const release = await acquire();
    // A client can disconnect while this request is queued behind another API call. In that case
    // onRequestAbort has already fired, so release the acquired turn immediately instead of
    // permanently blocking the request queue.
    if (request.raw.aborted) {
      release();
      return;
    }
    releases.set(request, release);
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const projectId = request.headers["x-outmapper-project-id"];
    const revision = request.headers["x-outmapper-revision"];
    if (projectId === undefined && revision === undefined) return;
    const project = await projectStore.load();
    if (projectId !== project.manifest.id || revision !== String(project.manifest.revision)) {
      return reply.code(409).send({ error: "Project changed. Reopen it before saving.", code: "conflicting-save" });
    }
  });
  server.addHook("onRequestAbort", async (request) => { releaseRequest(request); });
  server.addHook("onError", async (request) => { releaseRequest(request); });
  server.addHook("onResponse", async (request) => { releaseRequest(request); });
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError || error instanceof ProjectValidationError || error instanceof AssetStoreError || error instanceof ProjectPackageError) return domainFailure(reply, error);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return failure(reply, 404, "filesystem-not-found", "Folder or Project was not found");
    return failure(reply, 500, "internal-error", error instanceof Error ? error.message : "Project request failed");
  });

  server.addHook("onSend", async (_request, reply, payload) => {
    if (!reply.hasHeader("X-Content-Type-Options")) reply.header("X-Content-Type-Options", "nosniff");
    if (!reply.hasHeader("Referrer-Policy")) reply.header("Referrer-Policy", "no-referrer");
    if (!reply.hasHeader("Cross-Origin-Opener-Policy")) reply.header("Cross-Origin-Opener-Policy", "same-origin");
    if (!reply.hasHeader("Content-Security-Policy")) {
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'"
      );
    }
    return payload;
  });

  server.addHook("onRequest", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    if (request.headers["sec-fetch-site"] === "cross-site") {
      return failure(reply, 403, "cross-site-request", "Cross-site mutation request rejected");
    }
    const origin = request.headers.origin;
    if (!origin) return;
    try {
      const hostname = new URL(origin).hostname;
      if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]") return;
    } catch {
      return failure(reply, 403, "invalid-origin", "Invalid request origin");
    }
    return failure(reply, 403, "cross-origin-request", "Cross-origin mutation request rejected");
  });

  server.get("/api/health", async () => ({ status: "ok", version: APPLICATION_VERSION }));
  server.get("/api/project", async (_request, reply) => {
    try {
      const project = await projectStore.open();
      reconcileRuntime(project);
      return project;
    } catch (error) {
      if (error instanceof ProjectValidationError) {
        return failure(reply, 422, "project-validation", "Project validation failed", { issues: error.issues });
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return failure(reply, 404, "configured-project-not-found", "Configured Project was not found");
      }
      throw error;
    }
  });
  server.get("/api/workspace/projects", async () => ({ activeInstanceId, ...registry.list() }));
  server.post("/api/workspace/refresh", async () => ({ activeInstanceId, ...await registry.refresh() }));
  server.get("/api/workspace/incoming", async () => registry.incomingFor(await projectStore.load()));
  server.get("/api/workspace/universe", async () => {
    await registry.refresh();
    return registry.universe((entry) =>
      entry.homeCoverAssetPath && COVER_IMAGE_TYPES.includes(entry.homeCoverMimeType as (typeof COVER_IMAGE_TYPES)[number]) && (entry.status === "available" || entry.status === "duplicate")
        ? `/api/workspace/projects/${encodeURIComponent(entry.instanceId)}/home-cover`
        : undefined);
  });
  server.get<{ Params: { instanceId: string } }>("/api/workspace/projects/:instanceId/home-cover", async (request, reply) => {
    const entry = registry.get(request.params.instanceId);
    if (!entry?.homeCoverAssetPath || !COVER_IMAGE_TYPES.includes(entry.homeCoverMimeType as (typeof COVER_IMAGE_TYPES)[number]) || (entry.status !== "available" && entry.status !== "duplicate")) {
      return failure(reply, 404, "cover-not-found", "Project cover was not found");
    }
    const filePath = resolveProjectPath(entry.directory, entry.homeCoverAssetPath);
    let canonicalFile: string;
    try {
      const canonicalRoot = await realpath(entry.directory);
      canonicalFile = await realpath(filePath);
      const relative = path.relative(canonicalRoot, canonicalFile);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return failure(reply, 404, "cover-not-found", "Project cover was not found");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return failure(reply, 404, "cover-not-found", "Project cover was not found");
      throw error;
    }
    const details = await lstat(filePath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (!details?.isFile() || details.isSymbolicLink()) return failure(reply, 404, "cover-not-found", "Project cover was not found");
    const handle = await open(canonicalFile, "r");
    let detected: string | undefined;
    try {
      const header = Buffer.alloc(COVER_HEADER_BYTES);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      detected = sniffAssetMime(header.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
    if (!COVER_IMAGE_TYPES.includes(detected as (typeof COVER_IMAGE_TYPES)[number])) {
      return failure(reply, 415, "unsupported-cover", "Project cover is not a supported image");
    }
    reply.header("Content-Type", detected!);
    reply.header("Content-Disposition", "inline");
    reply.header("Content-Length", String(details.size));
    reply.header("Content-Security-Policy", "sandbox; default-src 'none'");
    return reply.send(fs.createReadStream(canonicalFile));
  });
  server.get<{ Params: { instanceId: string } }>("/api/workspace/projects/:instanceId/topics", async (request, reply) => {
    const entry = registry.get(request.params.instanceId);
    if (!entry) return failure(reply, 404, "workspace-project-not-found", "Workspace Project was not found");
    const result = await registry.reader.read(entry.directory, entry.projectId);
    if (result.status !== "available" || !result.project) return reply.code(409).send({ error: `Project is ${result.status}`, code: result.status });
    return { projectId: result.project.manifest.id, homeTopicId: result.project.manifest.homeTopicId, topics: result.project.topics };
  });
  server.get<{ Params: { projectId: string } }>("/api/workspace/resolve/:projectId", async (request) => registry.resolve(request.params.projectId));
  server.post<{ Params: { instanceId: string } }>("/api/workspace/projects/:instanceId/activate", async (request) => activate(request.params.instanceId));
  server.put<{ Params: { projectId: string }; Body: { instanceId?: string } }>("/api/workspace/preferred/:projectId", async (request, reply) => {
    try { await registry.setPreferred(request.params.projectId, request.body?.instanceId); return reply.code(204).send(); }
    catch (error) { return domainFailure(reply, error); }
  });
  server.post<{ Params: { instanceId: string } }>("/api/workspace/projects/:instanceId/remove-from-recent", async (request, reply) => {
    await registry.removeFromRecent(request.params.instanceId);
    return reply.code(204).send();
  });
  server.delete<{ Params: { instanceId: string } }>("/api/workspace/projects/:instanceId", async (request, reply) => {
    if (request.params.instanceId === activeInstanceId) return failure(reply, 409, "active-project-forget", "The active Project cannot be forgotten");
    await registry.forget(request.params.instanceId);
    return reply.code(204).send();
  });
  server.post<{ Params: { instanceId: string } }>("/api/workspace/projects/:instanceId/locate", async (request) => {
    const directory = await (options.selectFolder ?? selectNativeFolder)();
    if (!directory) return { cancelled: true };
    return { project: await registry.locate(request.params.instanceId, directory) };
  });
  server.post<{ Params: { projectId: string } }>("/api/workspace/locate/:projectId", async (request) => {
    const directory = await (options.selectFolder ?? selectNativeFolder)();
    if (!directory) return { cancelled: true };
    return { project: await registry.locateProject(request.params.projectId, directory) };
  });
  server.post<{ Params: { instanceId: string } }>("/api/workspace/projects/:instanceId/new-identity", async (request, reply) => {
    try {
      await activate(request.params.instanceId);
      const project = await projectStore.load();
      project.manifest.id = randomUUID();
      project.manifest.revision += 1;
      project.manifest.updatedAt = new Date().toISOString();
      await projectStore.save(project);
      commandHistory.clear();
      await registry.register(activeDirectory, project, true);
      return { ...await mutationResult(), historyCleared: true };
    } catch (error) { return domainFailure(reply, error); }
  });
  server.post("/api/project/reload", async () => {
    const activation = await histories.reload();
    projectStore = activation.store;
    projectService = new ProjectService(projectStore);
    commandHistory = activation.history;
    reconcileRuntime(activation.project);
    await registry.register(activeDirectory, activation.project, true);
    return { project: activation.project, history: commandHistory.state, instanceId: activeInstanceId, historyCleared: true };
  });
  server.post("/api/project/save-copy", async () => {
    if (folderImport.busy) throw new DomainError("conflicting-save", "Finish or cancel the folder import before copying this Project.");
    const project = await projectStore.load();
    const directory = await library.copyProject(activeDirectory, project.manifest.title);
    const entry = await registry.registerDirectory(directory);
    return { project: entry };
  });
  server.get("/api/projects/recent", async () => ({ instanceId: activeInstanceId, projects: registry.recent() }));
  server.post<{ Body: { title?: string; locale?: string } }>("/api/projects/new", async (request, reply) => {
    if (folderImport.busy) return reply.code(409).send({ error: "Finish or cancel the folder import before switching Projects.", code: "conflicting-save" });
    const directory = await library.create(request.body?.title ?? "", request.body?.locale ?? "en");
    const entry = await registry.registerDirectory(directory, true);
    return reply.code(201).send(await activate(entry.instanceId));
  });
  server.post("/api/projects/open", async () => {
    const directory = await (options.selectFolder ?? selectNativeFolder)();
    if (!directory) return { cancelled: true };
    const entry = await registry.registerDirectory(directory, true);
    return activate(entry.instanceId);
  });
  server.post("/api/folder-import/preview", async (request, reply) => {
    const directory = await (options.selectFolder ?? selectNativeFolder)();
    if (!directory) return { cancelled: true };
    try { return await folderImport.preview(directory); }
    catch (error) { return domainFailure(reply, error); }
  });
  server.delete<{ Params: { planId: string } }>("/api/folder-import/plans/:planId", async (request, reply) => {
    folderImport.discard(request.params.planId);
    return reply.code(204).send();
  });
  server.post<{ Params: { planId: string }; Body: FolderImportOptions }>("/api/folder-import/plans/:planId/start", async (request, reply) => {
    return reply.code(202).send(await folderImport.start(request.params.planId, request.body));
  });
  server.get<{ Params: { jobId: string } }>("/api/folder-import/jobs/:jobId", async (request) => {
    const job = folderImport.getJob(request.params.jobId);
    return job.status === "completed" ? { job, ...await mutationResult() } : { job };
  });
  server.delete<{ Params: { jobId: string } }>("/api/folder-import/jobs/:jobId", async (request, reply) => {
    folderImport.cancel(request.params.jobId);
    return reply.code(204).send();
  });
  server.post<{ Body: { title?: string; defaultLocale?: string } }>("/api/project", async (request, reply) => {
    const title = request.body?.title?.trim();
    if (!title) return failure(reply, 400, "project-title-required", "Project title is required");

    const now = new Date().toISOString();
    try {
      const project = await projectStore.create({
        manifest: {
          format: "outmapper-project",
          formatVersion: 2,
          id: randomUUID(),
          title,
          createdAt: now,
          updatedAt: now,
          revision: 0,
          defaultLocale: request.body.defaultLocale ?? "en",
          defaultDirection: "auto"
        }
      });
      commandHistory.clear();
      reconcileRuntime(project);
      return reply.code(201).send(project);
    } catch (error) {
      if ((error as Error).message === "Project directory is not empty") {
        return failure(reply, 409, "project-directory-not-empty", "Configured Project directory is not empty");
      }
      if (error instanceof ProjectValidationError) {
        return failure(reply, 422, "project-validation", "Project validation failed", { issues: error.issues });
      }
      throw error;
    }
  });

  server.patch<{ Body: { title?: string; description?: string; homeTopicId?: string } }>("/api/project", async (request, reply) => {
    try {
      const { title, description, homeTopicId } = request.body ?? {};
      const metadata = { ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}) };
      await commandHistory.run(async () => {
        if (homeTopicId !== undefined) await projectService.setHomeTopic(homeTopicId);
        if (title !== undefined || description !== undefined) await projectService.updateProjectMetadata(metadata);
      }, { coalesceKey: homeTopicId === undefined ? textCoalesceKey("project", "manifest", metadata) : undefined });
      return await mutationResult();
    } catch (error) {
      return domainFailure(reply, error);
    }
  });

  server.patch<{ Params: { topicId: string }; Body: { title?: string; description?: string } }>(
    "/api/topics/:topicId",
    async (request, reply) => {
      try {
        await commandHistory.run(() => projectService.updateTopic(request.params.topicId, request.body ?? {}), { coalesceKey: textCoalesceKey("topic", request.params.topicId, request.body) });
        return await mutationResult();
      } catch (error) {
        return domainFailure(reply, error);
      }
    }
  );
  server.delete<{ Params: { topicId: string }; Body: { removeReferences?: boolean } }>(
    "/api/topics/:topicId",
    async (request, reply) => {
      try {
        await commandHistory.run(() => projectService.deleteTopic(request.params.topicId, { removeReferences: request.body?.removeReferences === true }));
        return await mutationResult();
      } catch (error) {
        return domainFailure(reply, error);
      }
    }
  );
  server.post<{ Body: { title?: string; description?: string } }>("/api/topics", async (request, reply) => {
    try {
      await commandHistory.run(() =>
        projectService.createTopic({
          title: request.body?.title ?? "",
          ...(request.body?.description !== undefined ? { description: request.body.description } : {})
        })
      );
      return reply.code(201).send(await mutationResult());
    } catch (error) {
      return domainFailure(reply, error);
    }
  });
  server.patch<{ Params: { keyIssueId: string }; Body: { title?: string; description?: string; order?: number } }>(
    "/api/key-issues/:keyIssueId",
    async (request, reply) => {
      try {
        await commandHistory.run(() => projectService.updateKeyIssue(request.params.keyIssueId, request.body ?? {}), { coalesceKey: textCoalesceKey("keyIssue", request.params.keyIssueId, request.body) });
        return await mutationResult();
      } catch (error) {
        return domainFailure(reply, error);
      }
    }
  );
  server.delete<{ Params: { keyIssueId: string }; Body: { removeReferences?: boolean } }>(
    "/api/key-issues/:keyIssueId",
    async (request, reply) => {
      try {
        await commandHistory.run(() => projectService.deleteKeyIssue(request.params.keyIssueId, { removeReferences: request.body?.removeReferences === true }));
        return await mutationResult();
      } catch (error) {
        return domainFailure(reply, error);
      }
    }
  );
  server.post<{ Body: { topicId?: string; title?: string; description?: string; order?: number } }>(
    "/api/key-issues",
    async (request, reply) => {
      try {
        await commandHistory.run(() =>
          projectService.createKeyIssue({
            topicId: request.body?.topicId ?? "",
            title: request.body?.title ?? "",
            ...(request.body?.description !== undefined ? { description: request.body.description } : {}),
            ...(request.body?.order !== undefined ? { order: request.body.order } : {})
          })
        );
        return reply.code(201).send(await mutationResult());
      } catch (error) {
        return domainFailure(reply, error);
      }
    }
  );
  server.put<{ Params: { topicId: string }; Body: { ids?: string[] } }>(
    "/api/topics/:topicId/key-issue-order",
    async (request, reply) => {
      try {
        await commandHistory.run(() => projectService.reorderKeyIssues(request.params.topicId, request.body?.ids ?? []));
        return await mutationResult();
      } catch (error) {
        return domainFailure(reply, error);
      }
    }
  );
  server.post<{
    Body: { sourceTopicId?: string; keyIssueId?: string; targetTopicId?: string; order?: number };
  }>("/api/relationships", async (request, reply) => {
    try {
      await commandHistory.run(() =>
        projectService.connectTopics({
          sourceTopicId: request.body?.sourceTopicId ?? "",
          keyIssueId: request.body?.keyIssueId ?? "",
          targetTopicId: request.body?.targetTopicId ?? "",
          ...(request.body?.order !== undefined ? { order: request.body.order } : {})
        })
      );
      return reply.code(201).send(await mutationResult());
    } catch (error) {
      return domainFailure(reply, error);
    }
  });
  server.post<{ Body: { sourceTopicId?: string; keyIssueId?: string; title?: string } }>("/api/relationships/new-topic", async (request, reply) => {
    try {
      await commandHistory.run(() =>
        projectService.createAndConnectTopic({
          sourceTopicId: request.body?.sourceTopicId ?? "",
          keyIssueId: request.body?.keyIssueId ?? "",
          title: request.body?.title ?? ""
        })
      );
      return reply.code(201).send(await mutationResult());
    } catch (error) {
      return domainFailure(reply, error);
    }
  });
  server.delete<{ Params: { relationshipId: string } }>(
    "/api/relationships/:relationshipId",
    async (request, reply) => {
      try {
        await commandHistory.run(() => projectService.disconnectRelationship(request.params.relationshipId));
        return await mutationResult();
      } catch (error) {
        return domainFailure(reply, error);
      }
    }
  );
  server.put<{ Params: { keyIssueId: string }; Body: { ids?: string[] } }>(
    "/api/key-issues/:keyIssueId/relationship-order",
    async (request, reply) => {
      try {
        await commandHistory.run(() =>
          projectService.reorderRelationships(request.params.keyIssueId, request.body?.ids ?? [])
        );
        return await mutationResult();
      } catch (error) {
        return domainFailure(reply, error);
      }
    }
  );
  server.post<{
    Body: {
      sourceTopicId?: string;
      keyIssueId?: string;
      targetProjectId?: string;
      targetTopicId?: string;
      cachedProjectTitle?: string;
      cachedTopicTitle?: string;
      order?: number;
      note?: string;
      metadata?: JsonObject;
    };
  }>("/api/project-links", async (request, reply) => {
    try {
      const body = request.body ?? {};
      await commandHistory.run(() => projectService.linkProject({
        sourceTopicId: body.sourceTopicId ?? "",
        keyIssueId: body.keyIssueId ?? "",
        targetProjectId: body.targetProjectId ?? "",
        cachedProjectTitle: body.cachedProjectTitle ?? "",
        ...(body.targetTopicId ? { targetTopicId: body.targetTopicId } : {}),
        ...(body.cachedTopicTitle ? { cachedTopicTitle: body.cachedTopicTitle } : {}),
        ...(body.order !== undefined ? { order: body.order } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {})
      }));
      return reply.code(201).send(await mutationResult());
    } catch (error) {
      return domainFailure(reply, error);
    }
  });
  server.patch<{
    Params: { projectLinkId: string };
    Body: {
      targetProjectId?: string;
      targetTopicId?: string | null;
      cachedProjectTitle?: string;
      cachedTopicTitle?: string | null;
      order?: number;
      note?: string | null;
      metadata?: JsonObject | null;
    };
  }>("/api/project-links/:projectLinkId", async (request, reply) => {
    try {
      await commandHistory.run(() => projectService.updateProjectLink(request.params.projectLinkId, request.body ?? {}));
      return await mutationResult();
    } catch (error) {
      return domainFailure(reply, error);
    }
  });
  server.delete<{ Params: { projectLinkId: string } }>("/api/project-links/:projectLinkId", async (request, reply) => {
    try {
      await commandHistory.run(() => projectService.unlinkProject(request.params.projectLinkId));
      return await mutationResult();
    } catch (error) {
      return domainFailure(reply, error);
    }
  });
  server.put<{ Params: { keyIssueId: string }; Body: { ids?: string[] } }>("/api/key-issues/:keyIssueId/target-order", async (request, reply) => {
    try {
      await commandHistory.run(() => projectService.reorderKeyIssueTargets(request.params.keyIssueId, request.body?.ids ?? []));
      return await mutationResult();
    } catch (error) {
      return domainFailure(reply, error);
    }
  });
  server.post<{
    Body: {
      title?: string;
      body?: string;
      type?: string;
      availability?: "local" | "external";
      externalUrl?: string;
      targetKind?: "topic" | "keyIssue";
      targetId?: string;
      pinned?: boolean;
    };
  }>("/api/knowledge", async (request, reply) => {
    try {
      await commandHistory.run(() =>
        projectService.createAndAssociateKnowledge({
          item: {
            title: request.body?.title ?? "",
            type: request.body?.type ?? "note",
            availability: request.body?.availability ?? "local",
            ...(request.body?.body !== undefined ? { body: request.body.body } : {}),
            ...(request.body?.externalUrl !== undefined ? { externalUrl: request.body.externalUrl } : {})
          },
          association: {
            targetKind: request.body?.targetKind ?? "topic",
            targetId: request.body?.targetId ?? "",
            ...(request.body?.pinned !== undefined ? { pinned: request.body.pinned } : {})
          }
        })
      );
      return reply.code(201).send(await mutationResult());
    } catch (error) {
      return domainFailure(reply, error);
    }
  });
  server.patch<{ Params: { associationId: string }; Body: { pinned?: boolean } }>(
    "/api/knowledge-associations/:associationId",
    async (request, reply) => {
      try {
        await commandHistory.run(() =>
          projectService.updateKnowledgeAssociation(request.params.associationId, {
            ...(request.body?.pinned !== undefined ? { pinned: request.body.pinned } : {})
          })
        );
        return await mutationResult();
      } catch (error) {
        return domainFailure(reply, error);
      }
    }
  );
  server.patch<{ Params: { associationId: string }; Body: { title: string; body?: string; summary?: string; externalUrl?: string; scope?: "context" | "all" } }>("/api/knowledge-associations/:associationId/item", async (request, reply) => {
    try {
      if (request.body?.scope && !["context", "all"].includes(request.body.scope)) throw new DomainError("invalid-command", "Knowledge edit scope is invalid");
      const { title, body, summary, externalUrl, scope } = request.body;
      await commandHistory.run(() => projectService.editAssociatedKnowledge(request.params.associationId, { title, body, summary, externalUrl }, scope ?? "context"));
      return await mutationResult();
    } catch (error) { return domainFailure(reply, error); }
  });
  server.delete<{ Params: { associationId: string }; Body: { scope?: "context" | "all" } }>("/api/knowledge-associations/:associationId", async (request, reply) => {
    try {
      if (request.body?.scope && !["context", "all"].includes(request.body.scope)) throw new DomainError("invalid-command", "Knowledge removal scope is invalid");
      await commandHistory.run(() => projectService.removeAssociatedKnowledge(request.params.associationId, request.body?.scope ?? "context"));
      return await mutationResult();
    } catch (error) { return domainFailure(reply, error); }
  });
  server.post("/api/history/undo", async (_request, reply) => {
    try {
      await commandHistory.undo();
      return await mutationResult();
    } catch (error) {
      return domainFailure(reply, error);
    }
  });
  server.post("/api/history/redo", async (_request, reply) => {
    try {
      await commandHistory.redo();
      return await mutationResult();
    } catch (error) {
      return domainFailure(reply, error);
    }
  });
  server.post("/api/history/checkpoint", async (_request, reply) => {
    try {
      return { checkpoint: await commandHistory.checkpoint(), history: commandHistory.state };
    } catch (error) {
      return domainFailure(reply, error);
    }
  });
  server.post<{ Body: { checkpoint?: { depth?: unknown; revision?: unknown } } }>("/api/history/revert", async (request, reply) => {
    try {
      const { depth, revision } = request.body?.checkpoint ?? {};
      if (!Number.isSafeInteger(depth) || !Number.isSafeInteger(revision)) {
        throw new DomainError("invalid-command", "A history checkpoint is required");
      }
      await commandHistory.revert({ depth: depth as number, revision: revision as number });
      return await mutationResult();
    } catch (error) {
      return domainFailure(reply, error);
    }
  });
  server.post<{ Body: { title?: string; note?: string } }>("/api/publish", async (request, reply) => {
    try {
      const result = await publicationService.publish(request.body ?? {});
      commandHistory.clear();
      const runtime = reconcileRuntime(result.project);
      return { ...result, history: commandHistory.state, runtime };
    } catch (error) {
      return domainFailure(reply, error);
    }
  });
  server.get<{
    Querystring: {
      q?: string;
      match?: string;
      kinds?: string;
      types?: string;
      topics?: string;
      tags?: string;
      authors?: string;
      sources?: string;
      limit?: string;
      cursor?: string;
      scope?: string;
      continuation?: string;
    };
  }>(
    "/api/search",
    async (request, reply) => {
      try {
        const list = (value?: string) => value?.split(",").map((item) => item.trim()).filter(Boolean);
        const kinds = list(request.query.kinds);
        const allowedKinds = new Set<SearchEntityKind>(["topic", "keyIssue", "knowledgeItem"]);
        if (kinds?.some((kind) => !allowedKinds.has(kind as SearchEntityKind))) {
          return failure(reply, 400, "search-kind-invalid", "Search entity kind is invalid");
        }
        const match = request.query.match;
        if (match && match !== "all" && match !== "phrase" && match !== "prefix") {
          return failure(reply, 400, "search-match-invalid", "Search match mode is invalid");
        }
        if (request.query.scope && request.query.scope !== "project" && request.query.scope !== "workspace") {
          return failure(reply, 400, "search-scope-invalid", "Search scope is invalid");
        }
        const matchMode = match as SearchQuery["match"];
        const query: SearchQuery = {
          text: request.query.q ?? "",
          ...(matchMode ? { match: matchMode } : {}),
          ...((kinds || request.query.types || request.query.topics || request.query.tags || request.query.authors || request.query.sources)
            ? {
                filters: {
                  ...(kinds ? { entityKinds: kinds as SearchEntityKind[] } : {}),
                  ...(list(request.query.types) ? { types: list(request.query.types) } : {}),
                  ...(list(request.query.topics) ? { topicIds: list(request.query.topics) } : {}),
                  ...(list(request.query.tags) ? { tags: list(request.query.tags) } : {}),
                  ...(list(request.query.authors) ? { authors: list(request.query.authors) } : {}),
                  ...(list(request.query.sources) ? { sources: list(request.query.sources) } : {})
                }
              }
            : {}),
          ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
          ...(request.query.cursor ? { cursor: request.query.cursor } : {})
        };
        if (request.query.scope === "workspace") {
          const startIndex = Math.max(0, Number.parseInt(request.query.continuation ?? "0", 10) || 0);
          const projects = registry.searchEntries(activeInstanceId).map((entry) => ({
            instanceId: entry.instanceId,
            projectId: entry.projectId,
            projectTitle: entry.title,
            databasePath: path.join(entry.directory, ...RUNTIME_DATABASE_PATH.split("/")),
            canonicalRevision: entry.revision,
            current: entry.instanceId === activeInstanceId,
            ...(entry.lastOpenedAt ? { lastOpenedAt: entry.lastOpenedAt } : {})
          }));
          return await workspaceSearch.search({ query: { ...query, cursor: undefined }, projects, startIndex, budgetMs: 400 });
        }
        const project = await projectStore.load();
        reconcileRuntime(project);
        return await searchAdapter!.search(query);
      } catch (error) {
        return domainFailure(reply, error);
      }
    }
  );

  server.get("/api/packages/export", async (request, reply) => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "outmapper-export-"));
    const archivePath = path.join(temporaryDirectory, "project.outmapper");
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    try {
      const project = await projectStore.load();
      await packageService.exportTo(archivePath, controller.signal);
      const filename = `${project.manifest.title.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || "project"}.outmapper`;
      reply.header("Content-Type", "application/vnd.outmapper.package+zip");
      reply.header("Content-Disposition", `attachment; filename="${filename}"`);
      reply.header("X-Outmapper-Project-Link-Count", String(new Set(project.projectLinks.map(({ targetProjectId }) => targetProjectId)).size));
      reply.header("X-Content-Type-Options", "nosniff");
      reply.raw.once("close", () => void rm(temporaryDirectory, { recursive: true, force: true }));
      return reply.send(fs.createReadStream(archivePath));
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      return domainFailure(reply, error);
    }
  });

  server.post<{ Body: Readable }>("/api/packages/import/preview", async (request, reply) => {
    const filename = request.headers["x-outmapper-filename"];
    if (typeof filename !== "string" || !filename.toLocaleLowerCase("en-US").endsWith(".outmapper")) {
      return failure(reply, 400, "package-filename-required", "A .outmapper package filename is required");
    }
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "outmapper-upload-"));
    const archivePath = path.join(temporaryDirectory, "upload.outmapper");
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > DEFAULT_PACKAGE_LIMITS.maxCompressedBytes) {
          callback(new ProjectPackageError("archive-limit", "Package exceeds the compressed-size limit"));
        } else callback(null, chunk);
      }
    });
    try {
      await mkdir(temporaryDirectory, { recursive: true });
      await pipeline(request.body, limiter, createWriteStream(archivePath), { signal: controller.signal });
      const plan = await packageService.stageImport(archivePath, controller.signal);
      return reply.send(plan);
    } catch (error) {
      return domainFailure(reply, error);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  server.post<{ Params: { planId: string }; Body: { directoryName?: string; mode?: "copy" | "anyway" } }>(
    "/api/packages/import/:planId/commit",
    async (request, reply) => {
      try {
        if (folderImport.busy) throw new DomainError("conflicting-save", "Finish or cancel the folder import before switching Projects.");
        const result = await packageService.commitImport(request.params.planId, request.body?.directoryName);
        const store = new FileSystemProjectStore(result.projectDirectory);
        const project = await store.open();
        const duplicate = registry.resolve(project.manifest.id).status !== "unavailable";
        if (duplicate && request.body?.mode !== "anyway") {
          project.manifest.id = randomUUID();
          project.manifest.revision += 1;
          project.manifest.updatedAt = new Date().toISOString();
          await store.save(project);
        }
        const entry = await registry.register(result.projectDirectory, project, true);
        return { ...result, importMode: duplicate && request.body?.mode !== "anyway" ? "copy" : "anyway", ...await activate(entry.instanceId) };
      } catch (error) {
        return domainFailure(reply, error);
      }
    }
  );

  const assetHeaders = (request: { headers: Record<string, string | string[] | undefined> }): {
    originalFilename: string;
    mimeType: string;
    targetKind: "topic" | "keyIssue";
    targetId: string;
  } => {
    const encodedFilename = request.headers["x-outmapper-filename"];
    const mimeType = request.headers["x-outmapper-mime"];
    const targetKind = request.headers["x-outmapper-target-kind"];
    const targetId = request.headers["x-outmapper-target-id"];
    if (
      typeof encodedFilename !== "string" ||
      typeof targetId !== "string" ||
      (targetKind !== "topic" && targetKind !== "keyIssue")
    ) {
      throw new AssetStoreError("invalid-asset", "Asset filename and target context are required");
    }
    let originalFilename: string;
    try {
      originalFilename = decodeURIComponent(encodedFilename);
    } catch {
      throw new AssetStoreError("invalid-asset", "Asset filename encoding is invalid");
    }
    return {
      originalFilename,
      mimeType: typeof mimeType === "string" ? mimeType : "application/octet-stream",
      targetKind,
      targetId
    };
  };

  const queuePdfExtraction = (asset: CanonicalProject["assets"][number]) => {
    if (asset.mimeType !== "application/pdf") return;
    const extraction = pdfExtraction;
    const store = projectStore;
    void extraction.extract(asset).then(() => exclusive(async () => {
      if (store !== projectStore) return;
      const project = await store.load();
      reconcileRuntime(project);
    })).catch(() => undefined);
  };

  server.post<{ Body: Readable }>("/api/assets", async (request, reply) => {
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    let asset: CanonicalProject["assets"][number] | undefined;
    try {
      const headers = assetHeaders(request);
      const id = randomUUID();
      const now = new Date().toISOString();
      asset = await assetStore.store({
        id,
        source: request.body,
        originalFilename: headers.originalFilename,
        mimeType: headers.mimeType,
        createdAt: now,
        signal: controller.signal
      });
      await commandHistory.run(() => projectService.attachManagedAsset({
        asset: asset!,
        item: {
          type: asset!.mimeType === "application/pdf" ? "pdf" : asset!.mimeType.startsWith("image/") ? "image" : "attachment",
          title: asset!.originalFilename,
          availability: "local"
        },
        association: { targetKind: headers.targetKind, targetId: headers.targetId }
      }));
      const result = await mutationResult();
      queuePdfExtraction(asset);
      return reply.code(201).send({ ...result, asset, extraction: asset.mimeType === "application/pdf" ? "queued" : "not-applicable" });
    } catch (error) {
      if (asset) await assetStore.remove(asset).catch(() => undefined);
      return domainFailure(reply, error);
    }
  });

  server.post<{ Params: { assetId: string }; Body: Readable }>(
    "/api/assets/:assetId/replacement",
    async (request, reply) => {
      const controller = new AbortController();
      request.raw.once("aborted", () => controller.abort());
      let replacement: CanonicalProject["assets"][number] | undefined;
      try {
        const current = await projectStore.load();
        if (!current.assets.some(({ id }) => id === request.params.assetId)) {
          return failure(reply, 404, "asset-not-found", "Asset was not found");
        }
        const headers = assetHeaders(request);
        replacement = await assetStore.store({
          id: randomUUID(),
          source: request.body,
          originalFilename: headers.originalFilename,
          mimeType: headers.mimeType,
          createdAt: new Date().toISOString(),
          signal: controller.signal
        });
        await commandHistory.run(() => projectService.replaceManagedAsset(request.params.assetId, replacement!));
        const result = await mutationResult();
        queuePdfExtraction(replacement);
        return reply.send({ ...result, asset: replacement, extraction: replacement.mimeType === "application/pdf" ? "queued" : "not-applicable" });
      } catch (error) {
        if (replacement) await assetStore.remove(replacement).catch(() => undefined);
        return domainFailure(reply, error);
      }
    }
  );

  const coverRoutes: Array<["topic" | "keyIssue", string]> = [["topic", "/api/topics/:entityId/cover"], ["keyIssue", "/api/key-issues/:entityId/cover"]];
  for (const [kind, route] of coverRoutes) {
    server.put<{ Params: { entityId: string }; Body: Readable }>(route, async (request, reply) => {
      const controller = new AbortController();
      request.raw.once("aborted", () => controller.abort());
      let asset: CanonicalProject["assets"][number] | undefined;
      try {
        const target = { kind, id: request.params.entityId };
        const current = await projectStore.load();
        if (!(kind === "topic" ? current.topics : current.keyIssues).some(({ id }) => id === target.id)) {
          throw new DomainError("not-found", `${kind === "topic" ? "Topic" : "Key Issue"} ${target.id} does not exist`);
        }
        const encodedFilename = request.headers["x-outmapper-filename"];
        let originalFilename = "cover";
        try {
          if (typeof encodedFilename === "string") originalFilename = decodeURIComponent(encodedFilename);
        } catch {
          throw new AssetStoreError("invalid-asset", "Asset filename encoding is invalid");
        }
        // The declared MIME type is ignored: a cover is typed only by its sniffed bytes.
        asset = await assetStore.store({ id: randomUUID(), source: request.body, originalFilename, createdAt: new Date().toISOString(), signal: controller.signal });
        const image = inspectCoverImage(await assetStore.readHeader(asset, COVER_HEADER_BYTES));
        const cover = { ...asset, mimeType: image.mimeType, ...(image.width && image.height ? { width: image.width, height: image.height } : {}) };
        await commandHistory.run(() => projectService.setVisualAsset(target, cover));
        return reply.send({ ...await mutationResult(), asset: cover });
      } catch (error) {
        if (asset) await assetStore.remove(asset).catch(() => undefined);
        return domainFailure(reply, error);
      }
    });
    server.delete<{ Params: { entityId: string } }>(route, async (request, reply) => {
      try {
        await commandHistory.run(() => projectService.setVisualAsset({ kind, id: request.params.entityId }, null));
        return await mutationResult();
      } catch (error) {
        return domainFailure(reply, error);
      }
    });
  }

  server.get<{ Params: { assetId: string } }>("/api/assets/:assetId/extraction", async (request, reply) => {
    const project = await projectStore.load();
    const asset = project.assets.find(({ id }) => id === request.params.assetId);
    if (!asset) return failure(reply, 404, "asset-not-found", "Asset was not found");
    const record = await extractionStore.read(asset.id);
    if (!record || record.assetSha256 !== asset.sha256) return { status: "pending", assetId: asset.id };
    return record;
  });

  server.post<{ Params: { assetId: string } }>("/api/assets/:assetId/extraction", async (request, reply) => {
    const project = await projectStore.load();
    const asset = project.assets.find(({ id }) => id === request.params.assetId);
    if (!asset) return failure(reply, 404, "asset-not-found", "Asset was not found");
    if (asset.mimeType !== "application/pdf") return failure(reply, 400, "asset-not-pdf", "Asset is not a PDF");
    queuePdfExtraction(asset);
    return reply.code(202).send({ status: "queued", assetId: asset.id });
  });

  server.get<{ Params: { assetId: string } }>("/api/assets/:assetId", async (request, reply) => {
    const project = await projectStore.load();
    const asset = project.assets.find(({ id }) => id === request.params.assetId);
    if (!asset) return failure(reply, 404, "asset-not-found", "Asset was not found");
    const filePath = path.resolve(activeDirectory, ...asset.path.split("/"));
    let fileStats;
    try {
      fileStats = await import("node:fs/promises").then(({ lstat }) => lstat(filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return failure(reply, 404, "asset-file-missing", "Asset file is missing");
      throw error;
    }
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) return failure(reply, 404, "asset-file-unavailable", "Asset file is unavailable");
    const rangeHeader = request.headers.range;
    let range: { start: number; end: number } | undefined;
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader);
      if (!match || (!match[1] && !match[2])) {
        return reply.code(416).header("Content-Range", `bytes */${fileStats.size}`).send();
      }
      const start = match[1] ? Number(match[1]) : Math.max(0, fileStats.size - Number(match[2]));
      const end = match[2] && match[1] ? Number(match[2]) : fileStats.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= fileStats.size) {
        return reply.code(416).header("Content-Range", `bytes */${fileStats.size}`).send();
      }
      range = { start, end };
      reply.code(206).header("Content-Range", `bytes ${start}-${end}/${fileStats.size}`);
    }
    const active = asset.mimeType === "text/html" || asset.mimeType === "image/svg+xml";
    const asciiFilename = asset.originalFilename.replace(/[^a-zA-Z0-9._-]+/gu, "_") || "asset";
    reply.header("Content-Type", active ? "application/octet-stream" : asset.mimeType);
    reply.header("Content-Disposition", `${active ? "attachment" : "inline"}; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(asset.originalFilename)}`);
    reply.header("Content-Length", String(range ? range.end - range.start + 1 : fileStats.size));
    reply.header("Accept-Ranges", "bytes");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "sandbox; default-src 'none'");
    return reply.send(assetStore.createReadStream(asset, range));
  });

  server.delete<{ Params: { planId: string } }>(
    "/api/packages/import/:planId",
    async (request, reply) => {
      await packageService.cancelImport(request.params.planId);
      return reply.code(204).send();
    }
  );

  if (fs.existsSync(config.clientDirectory)) {
    await server.register(fastifyStatic, {
      root: config.clientDirectory,
      wildcard: false
    });
    server.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return failure(reply, 404, "api-not-found", "Not found");
      }
      return reply.sendFile("index.html");
    });
  }

  return server;
}

// Only pure title/description autosaves share one Undo step; other edits to the same entity stay separate.
function textCoalesceKey(kind: string, id: string, patch: object | undefined): string | undefined {
  const keys = Object.keys(patch ?? {});
  return keys.length > 0 && keys.every((key) => key === "title" || key === "description") ? `text:${kind}:${id}` : undefined;
}

export function clientAssetPath(config: ServerConfig, fileName: string): string {
  return path.join(config.clientDirectory, fileName);
}
