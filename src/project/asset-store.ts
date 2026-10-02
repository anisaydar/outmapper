import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Asset } from "../domain/types.js";
import { resolveProjectPath } from "./paths.js";

export const DEFAULT_ASSET_BYTE_LIMIT = 512 * 1024 * 1024;

export class AssetStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AssetStoreError";
    this.code = code;
  }
}

export function sniffAssetMime(header: Buffer): string | undefined {
  if (header.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
  const ascii = header.toString("ascii");
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  if (header[0] === 0x4d && header[1] === 0x5a) return "application/x-msdownload";
  const text = header.toString("utf8").replace(/^\uFEFF/u, "").trimStart().toLocaleLowerCase("en-US");
  if (text.startsWith("<svg") || text.startsWith("<?xml") && text.includes("<svg")) return "image/svg+xml";
  if (text.startsWith("<!doctype html") || text.startsWith("<html")) return "text/html";
  return undefined;
}

export function assertMimeMatches(declaredMime: string, detectedMime: string | undefined, filename: string): void {
  const strict = new Set([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "text/html"
  ]);
  if (detectedMime === "application/x-msdownload" && declaredMime !== detectedMime) {
    throw new AssetStoreError("forged-mime", `Executable content has forged MIME metadata: ${filename}`);
  }
  if (strict.has(declaredMime) && detectedMime !== declaredMime) {
    throw new AssetStoreError("forged-mime", `Asset MIME metadata does not match its bytes: ${filename}`);
  }
}

function safeFilename(value: string): string {
  const basename = path.basename(value.normalize("NFKC").replaceAll("\\", "/"));
  const sanitized = [...basename]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 || '<>:"|?*'.includes(character) ? "_" : character;
    })
    .join("")
    .replace(/[. ]+$/u, "")
    .slice(0, 180);
  return sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : "asset";
}

export class FileSystemAssetStore {
  readonly projectDirectory: string;
  readonly maxBytes: number;

  constructor(projectDirectory: string, options: { maxBytes?: number } = {}) {
    this.projectDirectory = path.resolve(projectDirectory);
    this.maxBytes = options.maxBytes ?? DEFAULT_ASSET_BYTE_LIMIT;
  }

  async store(input: {
    id: string;
    source: Readable;
    originalFilename: string;
    mimeType?: string;
    createdAt: string;
    signal?: AbortSignal;
  }): Promise<Asset> {
    const filename = safeFilename(input.originalFilename);
    const logicalPath = `assets/${input.id}/${filename}`;
    const target = resolveProjectPath(this.projectDirectory, logicalPath);
    const staging = resolveProjectPath(this.projectDirectory, `.outmapper/runtime/asset-staging/${input.id}.tmp`);
    await mkdir(path.dirname(staging), { recursive: true });
    const hash = createHash("sha256");
    const headerParts: Buffer[] = [];
    let headerBytes = 0;
    let byteSize = 0;
    const inspect = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        byteSize += chunk.length;
        if (byteSize > this.maxBytes) {
          callback(new AssetStoreError("asset-limit", `Asset exceeds the ${this.maxBytes}-byte limit`));
          return;
        }
        hash.update(chunk);
        if (headerBytes < 1_024) {
          const part = chunk.subarray(0, Math.min(chunk.length, 1_024 - headerBytes));
          headerParts.push(part);
          headerBytes += part.length;
        }
        callback(null, chunk);
      }
    });
    try {
      await pipeline(input.source, inspect, createWriteStream(staging, { flags: "wx" }), { signal: input.signal });
      const detectedMime = sniffAssetMime(Buffer.concat(headerParts));
      const declaredMime = (input.mimeType ?? detectedMime ?? "application/octet-stream").split(";", 1)[0]!.trim().toLocaleLowerCase("en-US");
      assertMimeMatches(declaredMime, detectedMime, filename);
      await mkdir(path.dirname(target), { recursive: true });
      try {
        await lstat(target);
        throw new AssetStoreError("asset-exists", "Asset destination already exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(staging, target);
      return {
        id: input.id,
        path: logicalPath,
        originalFilename: filename,
        mimeType: declaredMime,
        byteSize,
        sha256: hash.digest("hex"),
        createdAt: input.createdAt
      };
    } catch (error) {
      await rm(staging, { force: true });
      if (input.signal?.aborted) throw new AssetStoreError("cancelled", "Asset import was cancelled");
      throw error;
    }
  }

  createReadStream(asset: Asset, range?: { start: number; end: number }): Readable {
    return createReadStream(resolveProjectPath(this.projectDirectory, asset.path), range);
  }

  async remove(asset: Asset): Promise<void> {
    await rm(resolveProjectPath(this.projectDirectory, asset.path), { force: true });
  }
}
