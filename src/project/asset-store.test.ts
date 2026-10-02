import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { FileSystemAssetStore } from "./asset-store.js";

describe("filesystem Asset store", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "outmapper-assets-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("streams a Project-owned Asset with stable identity and integrity metadata", async () => {
    const bytes = Buffer.from("portable asset bytes");
    const store = new FileSystemAssetStore(directory);

    const asset = await store.store({
      id: "asset-stable",
      source: Readable.from([bytes.subarray(0, 8), bytes.subarray(8)]),
      originalFilename: "../Research notes.txt",
      mimeType: "text/plain",
      createdAt: "2026-09-30T00:00:00.000Z"
    });

    expect(asset).toMatchObject({
      id: "asset-stable",
      path: "assets/asset-stable/Research notes.txt",
      originalFilename: "Research notes.txt",
      mimeType: "text/plain",
      byteSize: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
    expect(await readFile(path.join(directory, ...asset.path.split("/")))).toEqual(bytes);
  });

  it("rejects forged PDF metadata and bounded-size violations without committing bytes", async () => {
    const executable = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
    const store = new FileSystemAssetStore(directory, { maxBytes: 8 });

    await expect(store.store({
      id: "asset-forged",
      source: Readable.from([executable]),
      originalFilename: "report.pdf",
      mimeType: "application/pdf",
      createdAt: "2026-09-30T00:00:00.000Z"
    })).rejects.toMatchObject({ code: "forged-mime" });
    await expect(store.store({
      id: "asset-large",
      source: Readable.from([Buffer.alloc(9)]),
      originalFilename: "large.bin",
      mimeType: "application/octet-stream",
      createdAt: "2026-09-30T00:00:00.000Z"
    })).rejects.toMatchObject({ code: "asset-limit" });
    await expect(readFile(path.join(directory, "assets", "asset-forged", "report.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
