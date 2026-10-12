import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildPdfIndex } from "./pdf-document-index.js";
import { DocumentError } from "./document-constants.js";
import type { PdfDocumentParser } from "./pdf-documents.js";

const MAX_PAGE_RENDER_PIXELS = 4_000_000;

/** Node.js parser used by local development and by the PDF parser Container image. */
export class LocalPdfParser implements PdfDocumentParser {
  parse(input: Uint8Array) { return buildPdfIndex(input); }

  async render(input: Uint8Array, pageNumber: number, crop: { x: number; y: number; width: number; height: number; scale?: number }): Promise<Uint8Array> {
    const scale = crop.scale ?? 1.5;
    const loadingTask = getDocument({ data: Uint8Array.from(input), stopAtErrors: true, verbosity: 0, useWorkerFetch: false, maxImageSize: MAX_PAGE_RENDER_PIXELS });
    try {
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const canvasWidth = Math.ceil(viewport.width);
      const canvasHeight = Math.ceil(viewport.height);
      if (canvasWidth * canvasHeight > MAX_PAGE_RENDER_PIXELS) throw new DocumentError("render_too_large", `Rendered page exceeds ${MAX_PAGE_RENDER_PIXELS} pixels at this scale.`, 413);
      const outputWidth = Math.max(1, Math.ceil(viewport.width * crop.width));
      const outputHeight = Math.max(1, Math.ceil(viewport.height * crop.height));
      if (outputWidth * outputHeight > MAX_PAGE_RENDER_PIXELS) throw new DocumentError("render_too_large", `Rendered crop exceeds ${MAX_PAGE_RENDER_PIXELS} pixels.`, 413);
      const canvas = createCanvas(canvasWidth, canvasHeight);
      const context = canvas.getContext("2d");
      await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
      const cropCanvas = createCanvas(outputWidth, outputHeight);
      cropCanvas.getContext("2d").drawImage(canvas, Math.floor(viewport.width * crop.x), Math.floor(viewport.height * crop.y), outputWidth, outputHeight, 0, 0, outputWidth, outputHeight);
      page.cleanup();
      const png = new Uint8Array(await cropCanvas.encode("png"));
      if (png.byteLength > 4 * 1024 * 1024) throw new DocumentError("render_too_large", "PNG output exceeds the 4 MiB response limit.", 413);
      return png;
    } catch (error) {
      if (error instanceof DocumentError) throw error;
      throw new DocumentError("page_render_failed", "The requested page region could not be rendered.", 422);
    } finally {
      await loadingTask.destroy().catch(() => undefined);
    }
  }
}
