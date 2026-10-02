import { parentPort } from "node:worker_threads";
import { URL } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const standardFontDataUrl = new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).href;

parentPort.on("message", async ({ id, data }) => {
  const started = performance.now();
  let task;
  try {
    task = getDocument({
      data: new Uint8Array(data),
      standardFontDataUrl,
      useSystemFonts: false,
      useWorkerFetch: false,
      verbosity: 0
    });
    const document = await task.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ disableNormalization: false });
      pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
      page.cleanup();
    }
    await task.destroy();
    parentPort.postMessage({ id, ok: true, pageCount: pages.length, text: pages.join("\n"), durationMs: performance.now() - started });
  } catch (error) {
    await task?.destroy().catch(() => undefined);
    parentPort.postMessage({ id, ok: false, name: error?.name, message: error?.message, durationMs: performance.now() - started });
  }
});
