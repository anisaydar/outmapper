import { parentPort } from "node:worker_threads";
import { getDocument, version } from "pdfjs-dist/legacy/build/pdf.mjs";

interface ExtractRequest {
  type: "extract";
  id: string;
  filePath: string;
  maxPages: number;
  maxTextCharacters: number;
}

interface CancelRequest {
  type: "cancel";
  id: string;
}

const tasks = new Map<string, ReturnType<typeof getDocument>>();
const standardFontDataUrl = new URL("../../standard_fonts/", import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href;

parentPort?.on("message", async (request: ExtractRequest | CancelRequest) => {
  if (request.type === "cancel") {
    await tasks.get(request.id)?.destroy().catch(() => undefined);
    tasks.delete(request.id);
    return;
  }
  let task: ReturnType<typeof getDocument> | undefined;
  try {
    task = getDocument({
      url: request.filePath,
      standardFontDataUrl,
      useSystemFonts: false,
      useWorkerFetch: false,
      verbosity: 0
    });
    tasks.set(request.id, task);
    const document = await task.promise;
    if (document.numPages > request.maxPages) throw new Error("PDF exceeds the page-count limit");
    const pages: string[] = [];
    let textCharacters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ disableNormalization: false });
      const text = content.items.map((item) => "str" in item ? item.str : "").join(" ").trim();
      textCharacters += text.length;
      if (textCharacters > request.maxTextCharacters) throw new Error("PDF exceeds the extracted-text limit");
      pages.push(text);
      page.cleanup();
    }
    await task.destroy();
    tasks.delete(request.id);
    parentPort?.postMessage({
      id: request.id,
      ok: true,
      pageCount: pages.length,
      text: pages.join("\n\n"),
      extractorVersion: version
    });
  } catch (error) {
    await task?.destroy().catch(() => undefined);
    tasks.delete(request.id);
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : "PDF extraction failed";
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      errorCode: name === "PasswordException" ? "encrypted" : message.includes("limit") ? "limit" : name === "InvalidPDFException" || name === "FormatError" ? "invalid-pdf" : "worker-error",
      errorMessage: message,
      extractorVersion: version
    });
  }
});
