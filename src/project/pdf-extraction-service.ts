import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { Asset } from "../domain/types.js";
import { DocumentExtractionStore, type DocumentExtractionRecord } from "./document-extraction-store.js";
import { resolveProjectPath } from "./paths.js";

interface WorkerSuccess {
  id: string;
  ok: true;
  pageCount: number;
  text: string;
  extractorVersion: string;
}

interface WorkerFailure {
  id: string;
  ok: false;
  errorCode: NonNullable<DocumentExtractionRecord["errorCode"]>;
  errorMessage: string;
  extractorVersion: string;
}

type WorkerResult = WorkerSuccess | WorkerFailure;

export interface PdfExtractionLimits {
  maxBytes: number;
  maxPages: number;
  maxTextCharacters: number;
  timeoutMs: number;
}

export const DEFAULT_PDF_EXTRACTION_LIMITS: PdfExtractionLimits = {
  maxBytes: 512 * 1024 * 1024,
  maxPages: 2_000,
  maxTextCharacters: 20_000_000,
  timeoutMs: 5 * 60_000
};

export class PdfExtractionService {
  readonly projectDirectory: string;
  readonly store: DocumentExtractionStore;
  readonly limits: PdfExtractionLimits;
  readonly now: () => string;
  private worker?: Worker;
  private queue: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, { resolve: (result: WorkerResult) => void; reject: (error: Error) => void }>();

  constructor(
    projectDirectory: string,
    options: { limits?: Partial<PdfExtractionLimits>; now?: () => string } = {}
  ) {
    this.projectDirectory = path.resolve(projectDirectory);
    this.store = new DocumentExtractionStore(this.projectDirectory);
    this.limits = { ...DEFAULT_PDF_EXTRACTION_LIMITS, ...options.limits };
    this.now = options.now ?? (() => new Date().toISOString());
  }

  extract(asset: Asset, signal?: AbortSignal): Promise<DocumentExtractionRecord> {
    const operation = this.queue.then(() => this.extractNow(asset, signal));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async extractNow(asset: Asset, signal?: AbortSignal): Promise<DocumentExtractionRecord> {
    if (asset.mimeType !== "application/pdf") throw new Error("Only PDF Assets can be extracted");
    const filePath = resolveProjectPath(this.projectDirectory, asset.path);
    const fileStats = await lstat(filePath);
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) throw new Error("PDF Asset is unavailable");
    if (fileStats.size > this.limits.maxBytes) {
      return this.writeFailure(asset, "limit", "PDF exceeds the extraction byte limit", "pdfjs-6");
    }
    if (signal?.aborted) return this.writeFailure(asset, "cancelled", "PDF extraction was cancelled", "pdfjs-6");
    const id = randomUUID();
    const worker = this.ensureWorker();
    const result = await new Promise<WorkerResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.postMessage({ type: "cancel", id });
        this.pending.delete(id);
        reject(new Error("PDF extraction timed out"));
      }, this.limits.timeoutMs);
      const abort = () => {
        clearTimeout(timeout);
        worker.postMessage({ type: "cancel", id });
        this.pending.delete(id);
        reject(new Error("PDF extraction was cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
          reject(error);
        }
      });
      worker.postMessage({
        type: "extract",
        id,
        filePath,
        maxPages: this.limits.maxPages,
        maxTextCharacters: this.limits.maxTextCharacters
      });
    }).catch(async (error: Error) => {
      const code = signal?.aborted ? "cancelled" : error.message.includes("timed out") ? "limit" : "worker-error";
      return {
        id,
        ok: false,
        errorCode: code,
        errorMessage: error.message,
        extractorVersion: "pdfjs-6"
      } satisfies WorkerFailure;
    });
    if (!result.ok) return this.writeFailure(asset, result.errorCode, result.errorMessage, result.extractorVersion);
    const record: DocumentExtractionRecord = {
      format: "outmapper-derived-document-text",
      formatVersion: 1,
      assetId: asset.id,
      assetSha256: asset.sha256,
      extractor: "pdfjs",
      extractorVersion: result.extractorVersion,
      status: "complete",
      completedAt: this.now(),
      pageCount: result.pageCount,
      text: result.text
    };
    await this.store.write(record);
    return record;
  }

  private async writeFailure(
    asset: Asset,
    errorCode: NonNullable<DocumentExtractionRecord["errorCode"]>,
    errorMessage: string,
    extractorVersion: string
  ): Promise<DocumentExtractionRecord> {
    const record: DocumentExtractionRecord = {
      format: "outmapper-derived-document-text",
      formatVersion: 1,
      assetId: asset.id,
      assetSha256: asset.sha256,
      extractor: "pdfjs",
      extractorVersion,
      status: "error",
      completedAt: this.now(),
      errorCode,
      errorMessage
    };
    await this.store.write(record);
    return record;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./pdf-extraction-worker.js", import.meta.url));
    worker.on("message", (result: WorkerResult) => {
      const pending = this.pending.get(result.id);
      if (!pending) return;
      this.pending.delete(result.id);
      pending.resolve(result);
    });
    worker.on("error", (error) => {
      const failure = error instanceof Error ? error : new Error("PDF extraction worker failed");
      for (const pending of this.pending.values()) pending.reject(failure);
      this.pending.clear();
      this.worker = undefined;
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        const error = new Error(`PDF extraction worker exited with code ${code}`);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      }
      this.worker = undefined;
    });
    this.worker = worker;
    return worker;
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }
}
