import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { Worker } from "node:worker_threads";

function pdf(pageTexts, paddingBytes = 0) {
  const objects = new Map();
  const pageIds = pageTexts.map((_, index) => 4 + index * 2);
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  objects.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pageTexts.forEach((text, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const safe = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
    const stream = `BT /F1 12 Tf 72 720 Td (${safe}) Tj ET`;
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  let output = "%PDF-1.7\n";
  if (paddingBytes) output += `%${"p".repeat(paddingBytes - 2)}\n`;
  const offsets = [0];
  const maxId = Math.max(...objects.keys());
  for (let id = 1; id <= maxId; id += 1) {
    offsets[id] = Buffer.byteLength(output);
    output += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) output += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

async function extract(data) {
  const worker = new Worker(new URL("./pdf-extraction-check-worker.mjs", import.meta.url));
  try {
    return await new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`PDF worker exited with code ${code}`));
      });
      worker.once("message", resolve);
      const transferable = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      worker.postMessage({ id: "pdf-extraction-check", data: transferable }, [transferable]);
    });
  } finally {
    await worker.terminate();
  }
}

const directory = await mkdtemp(path.join(os.tmpdir(), "outmapper-pdf-check-"));
try {
  const normal = pdf(["Outmapper PDF extraction evidence"]);
  const manyPage = pdf(Array.from({ length: 100 }, (_, index) => `Evidence page ${index + 1}`), 8 * 1024 * 1024);
  await writeFile(path.join(directory, "normal.pdf"), normal);
  await writeFile(path.join(directory, "many-page.pdf"), manyPage);
  const rssBefore = process.memoryUsage().rss;
  const normalResult = await extract(normal);
  const manyPageResult = await extract(manyPage);
  const malformedResult = await extract(Buffer.from("%PDF-1.7\nmalformed"));
  let stableImports = 0;
  for (let index = 0; index < 40; index += 1) {
    const result = await extract(normal);
    if (result.ok) stableImports += 1;
  }
  const result = {
    normal: { ok: normalResult.ok, pageCount: normalResult.pageCount, name: normalResult.name, message: normalResult.message, durationMs: Number(normalResult.durationMs.toFixed(1)) },
    manyPage: { ok: manyPageResult.ok, pageCount: manyPageResult.pageCount, name: manyPageResult.name, message: manyPageResult.message, bytes: manyPage.length, durationMs: Number(manyPageResult.durationMs.toFixed(1)) },
    malformedIsolated: malformedResult.ok === false,
    stableWorkerImports: stableImports,
    rssDeltaMiB: Number(((process.memoryUsage().rss - rssBefore) / 1024 / 1024).toFixed(1))
  };
  result.accepted = normalResult.ok && normalResult.text.includes("Outmapper") && manyPageResult.ok && manyPageResult.pageCount === 100 && malformedResult.ok === false && stableImports === 40;
  console.log(JSON.stringify(result));
  if (!result.accepted) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
