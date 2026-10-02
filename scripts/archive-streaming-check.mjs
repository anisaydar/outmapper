import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { BlobReader, Uint8ArrayReader, ZipReader, ZipWriter } from "@zip.js/zip.js";

const root = await mkdtemp(path.join(os.tmpdir(), "outmapper-archive-check-"));
const sourcePath = path.join(root, "source.bin");
const archivePath = path.join(root, "proof.outmapper");
const extractedPath = path.join(root, "extracted.bin");
const sourceBytes = 64 * 1024 * 1024;

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

try {
  await mkdir(root, { recursive: true });
  const handle = await writeFile(sourcePath, randomBytes(1024));
  void handle;
  const source = createWriteStream(sourcePath, { flags: "a" });
  const chunk = randomBytes(1024 * 1024);
  for (let offset = 1024; offset < sourceBytes; offset += chunk.length) {
    if (!source.write(chunk)) await new Promise((resolve) => source.once("drain", resolve));
  }
  await new Promise((resolve, reject) => source.end((error) => (error ? reject(error) : resolve())));

  const memoryBefore = process.memoryUsage().rss;
  const archiveStream = createWriteStream(archivePath);
  const writer = new ZipWriter(Writable.toWeb(archiveStream), { zip64: true });
  await writer.add("assets/source.bin", new BlobReader(await openAsBlob(sourcePath)), {
    level: 0,
    lastModDate: new Date("1980-01-01T00:00:00.000Z"),
    zip64: true
  });
  await writer.add(
    "project.json",
    new Uint8ArrayReader(new globalThis.TextEncoder().encode('{"format":"outmapper-project"}\n')),
    { lastModDate: new Date("1980-01-01T00:00:00.000Z") }
  );
  await writer.close(undefined, { zip64: true });
  const memoryAfterWrite = process.memoryUsage().rss;

  const reader = new ZipReader(new BlobReader(await openAsBlob(archivePath)), { checkAmbiguity: true });
  const entries = await reader.getEntries();
  const assetEntry = entries.find((entry) => entry.filename === "assets/source.bin");
  if (!assetEntry?.getData) throw new Error("Asset entry was not readable");
  await assetEntry.getData(Writable.toWeb(createWriteStream(extractedPath)), { checkSignature: true });
  const memoryAfterRead = process.memoryUsage().rss;
  await reader.close();

  const cancelled = new globalThis.AbortController();
  cancelled.abort();
  let cancellationObserved = false;
  const cancelReader = new ZipReader(new BlobReader(await openAsBlob(archivePath)));
  try {
    const [entry] = await cancelReader.getEntries();
    await entry.getData(Writable.toWeb(createWriteStream(path.join(root, "cancelled.bin"))), {
      signal: cancelled.signal
    });
  } catch {
    cancellationObserved = true;
  } finally {
    await cancelReader.close();
  }

  const archiveStats = await stat(archivePath);
  const hashesMatch = (await sha256(sourcePath)) === (await sha256(extractedPath));
  const result = {
    sourceBytes,
    archiveBytes: archiveStats.size,
    entries: entries.length,
    zip64Visible: Boolean(assetEntry.zip64),
    hashesMatch,
    cancellationObserved,
    maxRssDeltaMiB: Number(
      ((Math.max(memoryAfterWrite, memoryAfterRead) - memoryBefore) / 1024 / 1024).toFixed(1)
    )
  };
  result.accepted =
    result.entries === 2 &&
    result.zip64Visible &&
    result.hashesMatch &&
    result.cancellationObserved &&
    result.maxRssDeltaMiB < 48;
  console.log(JSON.stringify(result));
  if (!result.accepted) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
