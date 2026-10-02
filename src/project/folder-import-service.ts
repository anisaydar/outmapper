import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "../domain/errors.js";
import type { SessionCommandHistory } from "../domain/command-history.js";
import type { ProjectService } from "../domain/project-service.js";
import type { CanonicalProject, Asset, KnowledgeItem } from "../domain/types.js";
import type { FolderFileKind, FolderImportFile, FolderImportJob, FolderImportOptions, FolderImportPlan } from "../domain/folder-import.js";
import { DEFAULT_ASSET_BYTE_LIMIT, FileSystemAssetStore, assertMimeMatches, sniffAssetMime } from "./asset-store.js";
import type { FileSystemProjectStore } from "./filesystem-project-store.js";

const formats: Record<string, [FolderFileKind, string]> = {
  ".pdf": ["pdf", "application/pdf"], ".md": ["note", "text/markdown"], ".markdown": ["note", "text/markdown"], ".txt": ["note", "text/plain"],
  ".url": ["link", "text/plain"], ".webloc": ["link", "text/plain"], ".link": ["link", "text/plain"],
  ".png": ["attachment", "image/png"], ".jpg": ["attachment", "image/jpeg"], ".jpeg": ["attachment", "image/jpeg"], ".gif": ["attachment", "image/gif"], ".webp": ["attachment", "image/webp"],
  ".csv": ["attachment", "text/csv"], ".tsv": ["attachment", "text/tab-separated-values"], ".json": ["attachment", "application/json"],
  ".docx": ["attachment", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], ".xlsx": ["attachment", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], ".pptx": ["attachment", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ".mp3": ["attachment", "audio/mpeg"], ".wav": ["attachment", "audio/wav"], ".ogg": ["attachment", "audio/ogg"], ".mp4": ["attachment", "video/mp4"], ".webm": ["attachment", "video/webm"]
};

export function validatedLink(text: string, extension: string): string {
  let candidate = text.trim().replace(/^\uFEFF/u, "");
  if (extension === ".url") {
    if (!/^\[InternetShortcut\]\s*$/imu.test(candidate)) throw new Error("Invalid Internet Shortcut file");
    const urls = [...candidate.matchAll(/^URL=(.+)$/gimu)];
    if (urls.length !== 1) throw new Error("Link file must contain one URL");
    candidate = urls[0]![1]!.trim();
  } else if (extension === ".webloc") {
    if (/<!DOCTYPE[^>]*\[/iu.test(candidate) || /<!ENTITY/iu.test(candidate)) throw new Error("Unsupported link-file XML");
    const urls = [...candidate.matchAll(/<key>\s*URL\s*<\/key>\s*<string>([^<]+)<\/string>/gu)];
    if (urls.length !== 1) throw new Error("Link file must contain one URL");
    candidate = urls[0]![1]!.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
  }
  if (!/^https?:\/\//iu.test(candidate) || [...candidate].some((character) => /\s/u.test(character) || (character.codePointAt(0) ?? 0) <= 31)) throw new Error("Link must be a valid HTTP or HTTPS URL");
  const url = new URL(candidate);
  if (!url.hostname || url.username || url.password) throw new Error("Link contains an invalid host or embedded credentials");
  return url.href;
}

interface InspectedFile extends FolderImportFile { sha256?: string; mime?: string; body?: string; url?: string }
interface StoredPlan { public: FolderImportPlan; files: InspectedFile[]; project: CanonicalProject; root: string; created: number }
type ImportEntry = { asset: Asset; item: Omit<KnowledgeItem, "id" | "createdAt" | "updatedAt"> };

export class FolderImportService {
  private readonly plans = new Map<string, StoredPlan>();
  private readonly jobs = new Map<string, { state: FolderImportJob; controller: AbortController; done: Promise<void> }>();

  constructor(private readonly store: FileSystemProjectStore, private readonly service: ProjectService, private readonly history: SessionCommandHistory, private readonly exclusive: <T>(operation: () => Promise<T>) => Promise<T>, private readonly onImported: (assets: Asset[]) => void) {}

  get busy(): boolean { return [...this.jobs.values()].some(({ state }) => state.status === "running"); }

  private async openSource(root: string, relative: string) {
    const filename = path.join(root, ...relative.split("/"));
    const resolved = await realpath(filename);
    const difference = path.relative(root, resolved);
    if (difference.startsWith("..") || path.isAbsolute(difference) || (await lstat(filename)).isSymbolicLink()) throw new Error("Source file is outside the selected folder or is a symbolic link");
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!(await handle.stat()).isFile()) { await handle.close(); throw new Error("Source is not a regular file"); }
    return handle;
  }

  async preview(directory: string): Promise<FolderImportPlan> {
    for (const [id, plan] of this.plans) if (Date.now() - plan.created > 30 * 60_000) this.plans.delete(id);
    if (this.plans.size >= 4) throw new DomainError("invalid-command", "Close an existing import preview before selecting another folder");
    const root = await realpath(directory);
    const project = await this.store.load();
    const known = new Set(project.assets.map(({ sha256 }) => sha256));
    const links = new Set(project.knowledgeItems.flatMap(({ externalUrl }) => externalUrl ? [externalUrl] : []));
    const files: InspectedFile[] = [];
    let totalBytes = 0;
    const visit = async (relative: string, depth: number): Promise<void> => {
      if (depth > 20) throw new DomainError("invalid-command", "Folder nesting exceeds the import limit");
      const entries = await readdir(path.join(root, relative), { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const logicalPath = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { await visit(logicalPath, depth + 1); continue; }
        if (files.length >= 2000) throw new DomainError("invalid-command", "Folder exceeds the 2,000-file preview limit");
        const file: InspectedFile = { id: randomUUID(), path: logicalPath, bytes: 0, duplicate: false };
        files.push(file);
        try {
          if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Symbolic links and special files are excluded");
          const format = formats[path.extname(entry.name).toLowerCase()];
          if (!format) throw new Error("Unsupported file type");
          [file.kind, file.mime] = format;
          const handle = await this.openSource(root, logicalPath);
          try {
            file.bytes = (await handle.stat()).size;
            if (file.bytes > DEFAULT_ASSET_BYTE_LIMIT || (file.kind === "note" || file.kind === "link") && file.bytes > 4 * 1024 * 1024) throw new Error("File exceeds the supported size limit");
            totalBytes += file.bytes;
            if (totalBytes > 2 * 1024 * 1024 * 1024) throw new DomainError("invalid-command", "Folder exceeds the 2 GB preview limit");
            const hash = createHash("sha256");
            const header = Buffer.alloc(1024);
            const { bytesRead } = await handle.read(header, 0, 1024, 0);
            const detected = sniffAssetMime(header.subarray(0, bytesRead));
            assertMimeMatches(file.mime, detected, entry.name);
            if (detected === "application/x-msdownload" || detected === "text/html" || detected === "image/svg+xml") throw new Error("Active or executable content is excluded");
            for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk as Buffer);
            file.sha256 = hash.digest("hex");
            if (file.kind === "note" || file.kind === "link") {
              const bytes = Buffer.alloc(file.bytes);
              await handle.read(bytes, 0, file.bytes, 0);
              const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
              if (text.includes("\0")) throw new Error("Text file contains binary content");
              if (file.kind === "link") file.url = validatedLink(text, path.extname(entry.name).toLowerCase());
              else file.body = text;
            }
            file.duplicate = known.has(file.sha256) || Boolean(file.url && links.has(file.url));
            known.add(file.sha256);
            if (file.url) links.add(file.url);
          } finally { await handle.close(); }
        } catch (error) {
          if (error instanceof DomainError) throw error;
          file.error = error instanceof Error ? error.message : "File could not be read";
        }
      }
    };
    await visit("", 0);
    const publicPlan: FolderImportPlan = { id: randomUUID(), folder: root, files: files.map(({ id, path: filePath, bytes, kind, duplicate, error }) => ({ id, path: filePath, bytes, kind, duplicate, ...(error ? { error } : {}) })) };
    this.plans.set(publicPlan.id, { public: publicPlan, files, project, root, created: Date.now() });
    return publicPlan;
  }

  discard(id: string): void { this.plans.delete(id); }
  getJob(id: string): FolderImportJob {
    const job = this.jobs.get(id);
    if (!job) throw new DomainError("not-found", "Folder import was not found");
    return structuredClone(job.state);
  }
  cancel(id: string): void { this.jobs.get(id)?.controller.abort(); }

  async start(id: string, options: FolderImportOptions): Promise<FolderImportJob> {
    if (this.busy) throw new DomainError("invalid-command", "A folder import is already running");
    const plan = this.plans.get(id);
    if (!plan || Date.now() - plan.created > 30 * 60_000) throw new DomainError("not-found", "Folder preview expired. Select the folder again.");
    const current = await this.store.load();
    if (JSON.stringify(current) !== JSON.stringify(plan.project)) throw new DomainError("conflicting-save", "Project changed after preview. Select the folder again.");
    if (!options.target || !["topic", "keyIssue"].includes(options.target.kind) || !(options.target.kind === "topic" ? current.topics : current.keyIssues).some(({ id }) => id === options.target.id)) throw new DomainError("invalid-reference", "Select an existing Topic or Key Issue");
    if (!["skip", "keep"].includes(options.duplicates) || !Array.isArray(options.fileIds) || new Set(options.fileIds).size !== options.fileIds.length) throw new DomainError("invalid-command", "Import options are invalid");
    const selected = options.fileIds.map((id) => plan.files.find((file) => file.id === id));
    if (!selected.length || selected.some((file) => !file || file.error)) throw new DomainError("invalid-command", "Select supported files from the preview");
    this.plans.delete(id);
    for (const [jobId, job] of this.jobs) if (job.state.status !== "running") this.jobs.delete(jobId);
    const state: FolderImportJob = { id: randomUUID(), status: "running", processed: 0, total: selected.length, imported: 0, skipped: 0, failures: [] };
    const controller = new AbortController();
    const done = this.run(plan, selected as InspectedFile[], options, state, controller.signal);
    this.jobs.set(state.id, { state, controller, done });
    return structuredClone(state);
  }

  private async run(plan: StoredPlan, files: InspectedFile[], options: FolderImportOptions, state: FolderImportJob, signal: AbortSignal): Promise<void> {
    const assets = new FileSystemAssetStore(this.store.projectDirectory);
    const entries: ImportEntry[] = [];
    const known = new Set(plan.project.assets.map(({ sha256 }) => sha256));
    const links = new Set(plan.project.knowledgeItems.flatMap(({ externalUrl }) => externalUrl ? [externalUrl] : []));
    let committed = false;
    try {
      for (const file of files) {
        signal.throwIfAborted();
        state.currentFile = file.path;
        if (options.duplicates === "skip" && (known.has(file.sha256!) || Boolean(file.url && links.has(file.url)))) { state.skipped++; state.processed++; continue; }
        let asset: Asset | undefined;
        try {
          const handle = await this.openSource(plan.root, file.path);
          try {
            asset = await assets.store({ id: randomUUID(), source: handle.createReadStream({ autoClose: false }), originalFilename: path.basename(file.path), mimeType: file.mime, createdAt: new Date().toISOString(), signal });
          } finally { await handle.close(); }
          if (asset.sha256 !== file.sha256 || asset.byteSize !== file.bytes) throw new Error("File changed since preview. Select the folder again.");
          entries.push({ asset, item: {
            title: path.basename(file.path, path.extname(file.path)), type: file.kind === "link" ? "web-link" : file.kind === "note" ? "note" : file.kind === "pdf" ? "pdf" : asset.mimeType.startsWith("image/") ? "image" : "attachment",
            availability: file.url ? "external" : "local", attachmentAssetIds: [asset.id],
            ...(file.body !== undefined ? { body: file.body } : {}), ...(file.url ? { externalUrl: file.url } : {})
          } });
          known.add(file.sha256!);
          if (file.url) links.add(file.url);
        } catch (error) {
          if (asset) await assets.remove(asset);
          signal.throwIfAborted();
          state.failures.push({ path: file.path, error: error instanceof Error ? error.message : "File import failed" });
        }
        state.processed++;
      }
      await this.exclusive(async () => {
        signal.throwIfAborted();
        const current = await this.store.load();
        if (JSON.stringify(current) !== JSON.stringify(plan.project)) throw new DomainError("conflicting-save", "Project changed during import. No files were added.");
        if (entries.length) await this.history.run(() => this.service.importKnowledge(entries, options.target));
        committed = true;
        state.imported = entries.length;
        state.status = "completed";
        delete state.currentFile;
        this.onImported(entries.map(({ asset }) => asset));
      });
    } catch (error) {
      state.status = signal.aborted ? "cancelled" : "failed";
      if (!signal.aborted) state.error = error instanceof Error ? error.message : "Folder import failed";
    } finally {
      if (!committed) for (const { asset } of entries) await assets.remove(asset).catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    for (const { controller } of this.jobs.values()) controller.abort();
    await Promise.all([...this.jobs.values()].map(({ done }) => done));
    this.plans.clear();
  }
}
