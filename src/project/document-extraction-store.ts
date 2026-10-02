import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CanonicalProject } from "../domain/types.js";
import { resolveProjectPath } from "./paths.js";
import { serializeCanonicalJson } from "./serialization.js";

export interface DocumentExtractionRecord {
  format: "outmapper-derived-document-text";
  formatVersion: 1;
  assetId: string;
  assetSha256: string;
  extractor: "pdfjs";
  extractorVersion: string;
  status: "complete" | "error";
  completedAt: string;
  pageCount?: number;
  text?: string;
  errorCode?: "encrypted" | "invalid-pdf" | "limit" | "cancelled" | "worker-error";
  errorMessage?: string;
}

function recordPath(assetId: string): string {
  return `.outmapper/extracted-text/${assetId}.json`;
}

function isRecord(value: unknown): value is DocumentExtractionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<DocumentExtractionRecord>;
  return record.format === "outmapper-derived-document-text" &&
    record.formatVersion === 1 &&
    typeof record.assetId === "string" &&
    typeof record.assetSha256 === "string" &&
    (record.status === "complete" || record.status === "error");
}

export class DocumentExtractionStore {
  readonly projectDirectory: string;

  constructor(projectDirectory: string) {
    this.projectDirectory = path.resolve(projectDirectory);
  }

  async read(assetId: string): Promise<DocumentExtractionRecord | undefined> {
    try {
      const value = JSON.parse(await readFile(resolveProjectPath(this.projectDirectory, recordPath(assetId)), "utf8")) as unknown;
      return isRecord(value) ? value : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async write(record: DocumentExtractionRecord): Promise<void> {
    const target = resolveProjectPath(this.projectDirectory, recordPath(record.assetId));
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp`;
    await writeFile(temporary, serializeCanonicalJson(record), "utf8");
    await rename(temporary, target);
  }
}

export function readCurrentDocumentText(projectDirectory: string, project: CanonicalProject): {
  textByAssetId: Map<string, string>;
  revision: string;
} {
  const textByAssetId = new Map<string, string>();
  const revisionParts: string[] = [];
  for (const asset of [...project.assets].sort((left, right) => left.id.localeCompare(right.id))) {
    const filePath = resolveProjectPath(projectDirectory, recordPath(asset.id));
    if (!existsSync(filePath)) continue;
    try {
      const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (!isRecord(value) || value.status !== "complete" || value.assetSha256 !== asset.sha256 || typeof value.text !== "string") {
        continue;
      }
      textByAssetId.set(asset.id, value.text);
      revisionParts.push(`${asset.id}\u0000${asset.sha256}\u0000${value.text}`);
    } catch {
      continue;
    }
  }
  return {
    textByAssetId,
    revision: createHash("sha256").update(revisionParts.join("\u0001")).digest("hex")
  };
}
