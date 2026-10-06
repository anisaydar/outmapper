import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { FileSystemAssetStore, inspectCoverImage } from "./asset-store.js";

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

describe("cover image validation", () => {
  const riff = (chunk: Buffer) => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), chunk]);

  it("accepts PNG, JPEG, and still WebP and reads their dimensions", () => {
    const png = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(360, 20);
    expect(inspectCoverImage(png)).toEqual({ mimeType: "image/png", width: 640, height: 360 });

    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x01, 0x00]);
    expect(inspectCoverImage(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]))).toEqual({ mimeType: "image/jpeg", width: 640, height: 480 });

    const lossy = Buffer.alloc(18);
    lossy.write("VP8 ", 0, "ascii");
    Buffer.from([0x9d, 0x01, 0x2a]).copy(lossy, 11);
    lossy.writeUInt16LE(800, 14);
    lossy.writeUInt16LE(600, 16);
    expect(inspectCoverImage(riff(lossy))).toEqual({ mimeType: "image/webp", width: 800, height: 600 });

    const lossless = Buffer.alloc(13);
    lossless.write("VP8L", 0, "ascii");
    lossless[8] = 0x2f;
    lossless.writeUInt32LE((99) | (49 << 14), 9);
    expect(inspectCoverImage(riff(lossless))).toEqual({ mimeType: "image/webp", width: 100, height: 50 });

    const still = Buffer.alloc(18);
    still.write("VP8X", 0, "ascii");
    still.writeUIntLE(1279, 12, 3);
    still.writeUIntLE(719, 15, 3);
    expect(inspectCoverImage(riff(still))).toEqual({ mimeType: "image/webp", width: 1280, height: 720 });
  });

  it("rejects animated WebP, GIF, SVG, and other files", () => {
    const animated = Buffer.alloc(18);
    animated.write("VP8X", 0, "ascii");
    animated[8] = 0x02;
    expect(() => inspectCoverImage(riff(animated))).toThrow(expect.objectContaining({ code: "unsupported-cover" }));
    expect(() => inspectCoverImage(Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"))).toThrow(expect.objectContaining({ code: "unsupported-cover" }));
    expect(() => inspectCoverImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toThrow(expect.objectContaining({ code: "unsupported-cover" }));
    expect(() => inspectCoverImage(Buffer.from("plain text"))).toThrow(expect.objectContaining({ code: "unsupported-cover" }));
  });
});
