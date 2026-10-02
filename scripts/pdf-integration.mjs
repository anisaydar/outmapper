import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PdfExtractionService } from "../dist/server/src/project/pdf-extraction-service.js";

const passwordPadding = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a
]);

function rc4(key, data) {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let index = 0; index < 256; index += 1) {
    j = (j + state[index] + key[index % key.length]) & 255;
    [state[index], state[j]] = [state[j], state[index]];
  }
  const output = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let offset = 0; offset < data.length; offset += 1) {
    i = (i + 1) & 255;
    j = (j + state[i]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
    output[offset] = data[offset] ^ state[(state[i] + state[j]) & 255];
  }
  return output;
}

function paddedPassword(value) {
  return Buffer.concat([Buffer.from(value, "binary"), passwordPadding]).subarray(0, 32);
}

function assemblePdf(objects, trailer) {
  const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "binary")];
  const offsets = [0];
  let byteLength = chunks[0].length;
  for (let id = 1; id <= objects.length; id += 1) {
    offsets[id] = byteLength;
    const chunk = Buffer.concat([Buffer.from(`${id} 0 obj\n`), objects[id - 1], Buffer.from("\nendobj\n")]);
    chunks.push(chunk);
    byteLength += chunk.length;
  }
  const xref = byteLength;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= objects.length; id += 1) table += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  chunks.push(Buffer.from(`${table}trailer\n${trailer}\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

function simplePdf(text) {
  const pageTexts = Array.isArray(text) ? text : [text];
  const pageIds = pageTexts.map((_, index) => 4 + index * 2);
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  ];
  pageTexts.forEach((pageText, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const stream = Buffer.from(`BT /F1 12 Tf 72 720 Td (${pageText}) Tj ET`);
    objects.push(
      Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`),
      Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from("\nendstream")])
    );
  });
  return assemblePdf(objects, `<< /Size ${objects.length + 1} /Root 1 0 R >>`);
}

function encryptedPdf(text) {
  const fileId = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const ownerKey = createHash("md5").update(paddedPassword("owner")).digest().subarray(0, 5);
  const owner = rc4(ownerKey, paddedPassword("secret"));
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const encryptionKey = createHash("md5")
    .update(Buffer.concat([paddedPassword("secret"), owner, permissions, fileId]))
    .digest()
    .subarray(0, 5);
  const user = rc4(encryptionKey, passwordPadding);
  const objectSuffix = Buffer.from([5, 0, 0, 0, 0]);
  const objectKey = createHash("md5").update(Buffer.concat([encryptionKey, objectSuffix])).digest().subarray(0, 10);
  const stream = rc4(objectKey, Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`));
  return assemblePdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [4 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>"),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from("\nendstream")]),
    Buffer.from(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString("hex")}> /U <${user.toString("hex")}> /P -4 >>`)
  ], `<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<${fileId.toString("hex")}><${fileId.toString("hex")}>] >>`);
}

function asset(id, filename, bytes) {
  return {
    id,
    path: `assets/${id}/${filename}`,
    originalFilename: filename,
    mimeType: "application/pdf",
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "outmapper-pdf-integration-"));
const service = new PdfExtractionService(projectDirectory, { limits: { timeoutMs: 30_000 } });
try {
  const normalBytes = simplePdf("Searchable integration evidence");
  const encryptedBytes = encryptedPdf("Protected evidence");
  const malformedBytes = Buffer.from("%PDF-1.7\nmalformed");
  const cancellationBytes = simplePdf(Array.from({ length: 800 }, (_, index) => `Cancellation page ${index + 1}`));
  const fixtures = [
    asset("normal", "normal.pdf", normalBytes),
    asset("encrypted", "encrypted.pdf", encryptedBytes),
    asset("malformed", "malformed.pdf", malformedBytes),
    asset("cancel", "cancel.pdf", cancellationBytes)
  ];
  const bytesById = new Map([["normal", normalBytes], ["encrypted", encryptedBytes], ["malformed", malformedBytes], ["cancel", cancellationBytes]]);
  for (const fixture of fixtures) {
    await mkdir(path.join(projectDirectory, path.dirname(fixture.path)), { recursive: true });
    await writeFile(path.join(projectDirectory, fixture.path), bytesById.get(fixture.id));
  }

  const normal = await service.extract(fixtures[0]);
  const encrypted = await service.extract(fixtures[1]);
  const malformed = await service.extract(fixtures[2]);
  const aborted = new globalThis.AbortController();
  const cancellation = service.extract(fixtures[3], aborted.signal);
  setTimeout(() => aborted.abort(), 5);
  const cancelled = await cancellation;
  const accepted = normal.status === "complete" && normal.pageCount === 1 && normal.text?.includes("Searchable integration evidence") === true &&
    encrypted.status === "error" && encrypted.errorCode === "encrypted" &&
    malformed.status === "error" && malformed.errorCode === "invalid-pdf" &&
    cancelled.status === "error" && cancelled.errorCode === "cancelled";
  console.log(JSON.stringify({ normal, encrypted, malformed, cancelled, accepted }, null, 2));
  if (!accepted) process.exitCode = 1;
} finally {
  await service.dispose();
  await rm(projectDirectory, { recursive: true, force: true });
}
