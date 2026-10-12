import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api.js";
import { sha256 } from "./security.js";
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_PAGES, MAX_DOCUMENT_PAGE_TEXT_CHARS, MAX_DOCUMENT_TEXT_BYTES, MAX_DOCUMENT_BLOCKS, DocumentError } from "./document-constants.js";
import { sanitizeFilename } from "./document-utils.js";
export { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_PAGES, MAX_DOCUMENT_PAGE_TEXT_CHARS, MAX_DOCUMENT_TEXT_BYTES } from "./document-constants.js";
export { sanitizeFilename } from "./document-utils.js";

export interface PdfTextBlock {
  blockId: string;
  text: string;
  bbox: [number, number, number, number];
  fontSize: number;
}

export interface PdfPageIndex {
  page: number;
  pageLabel: string | null;
  width: number;
  height: number;
  rotation: number;
  text: string;
  charCount: number;
  likelyScanned: boolean;
  annotationCount: number;
  blocks: PdfTextBlock[];
}

export interface PdfDocumentIndex {
  version: 1;
  contentHash: string;
  byteLength: number;
  pageCount: number;
  metadata: Record<string, string | number | boolean | null>;
  pages: PdfPageIndex[];
  bookmarks: Array<{ title: string; page: number | null; children: Array<{ title: string; page: number | null }> }>;
  formFields: Array<{ name: string; type: string; value: string | null }>;
  attachments: Array<{ id: string; filename: string; contentType: string | null; sizeBytes: number }>;
  warnings: string[];
  extractedAt: string;
}

export class PdfReadError extends DocumentError {}

export async function buildPdfIndex(input: Uint8Array): Promise<PdfDocumentIndex> {
  if (input.byteLength < 8 || String.fromCharCode(...input.subarray(0, 5)) !== "%PDF-") {
    throw new PdfReadError("invalid_pdf", "Upload must begin with a PDF file signature.", 415);
  }
  if (input.byteLength > MAX_DOCUMENT_BYTES) {
    throw new PdfReadError("document_too_large", `PDF upload exceeds ${MAX_DOCUMENT_BYTES} bytes.`, 413);
  }

  const data = Uint8Array.from(input);
  const byteLength = data.byteLength;
  const loadingTask = getDocument({ data, stopAtErrors: true, verbosity: 0, useWorkerFetch: false });
  try {
    const pdf = await loadingTask.promise;
    if (pdf.numPages < 1 || pdf.numPages > MAX_DOCUMENT_PAGES) {
      throw new PdfReadError("page_limit_exceeded", `PDF must contain between 1 and ${MAX_DOCUMENT_PAGES} pages.`, 413);
    }
    return await extractDocument(pdf, sha256(input), byteLength);
  } catch (error) {
    if (error instanceof PdfReadError) throw error;
    const message = error instanceof Error ? error.message : "PDF could not be parsed.";
    const passwordFailure = /password|encrypted/i.test(message);
    throw new PdfReadError(passwordFailure ? "encrypted_pdf_unsupported" : "pdf_parse_failed",
      passwordFailure ? "Password-protected PDFs are not supported by this native-text operation." : "PDF structure could not be read safely.",
      passwordFailure ? 422 : 422);
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

async function extractDocument(pdf: PDFDocumentProxy, contentHash: string, byteLength: number): Promise<PdfDocumentIndex> {
  const metadataResult = await pdf.getMetadata();
  const info = metadataResult.info as Record<string, unknown>;
  const metadata: PdfDocumentIndex["metadata"] = {};
  for (const key of ["PDFFormatVersion", "Title", "Author", "Subject", "Creator", "Producer", "CreationDate", "ModDate", "EncryptFilterName", "IsAcroFormPresent", "IsXFAPresent", "IsCollectionPresent", "IsSignaturesPresent"]) {
    const value = info[key];
    metadata[key] = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
  }

  const labels = await pdf.getPageLabels();
  const pages: PdfPageIndex[] = [];
  let totalTextBytes = 0;
  let totalBlocks = 0;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent({ disableNormalization: true });
    const blocks: PdfTextBlock[] = [];
    let pageChars = 0;
    let blockIndex = 0;
    for (const item of content.items) {
      if (!("str" in item) || !item.str) continue;
      if (++blockIndex > 25_000 || ++totalBlocks > MAX_DOCUMENT_BLOCKS) throw new PdfReadError("too_many_text_blocks", `PDF exceeds the ${MAX_DOCUMENT_BLOCKS} text block limit.`, 413);
      pageChars += item.str.length;
      if (pageChars > MAX_DOCUMENT_PAGE_TEXT_CHARS) throw new PdfReadError("page_text_too_large", `Extracted page ${pageNumber} exceeds the text limit.`, 413);
      blocks.push(toBlock(item as TextItem, pageNumber, blockIndex, viewport.width, viewport.height, viewport));
    }
    totalTextBytes += Buffer.byteLength(blocks.map((block) => block.text).join(""), "utf8");
    if (totalTextBytes > MAX_DOCUMENT_TEXT_BYTES) throw new PdfReadError("document_text_too_large", `Extracted PDF text exceeds ${MAX_DOCUMENT_TEXT_BYTES} bytes.`, 413);
    const annotations = await page.getAnnotations({ intent: "display" });
    const text = assemblePageText(content.items);
    pages.push({
      page: pageNumber,
      pageLabel: labels?.[pageNumber - 1] ?? null,
      width: Math.round(viewport.width * 100) / 100,
      height: Math.round(viewport.height * 100) / 100,
      rotation: page.rotate,
      text,
      charCount: text.length,
      likelyScanned: text.trim().length < 20,
      annotationCount: annotations.length,
      blocks,
    });
    page.cleanup();
  }

  const bookmarks = await readBookmarks(pdf);
  const fields = await pdf.getFieldObjects();
  const formFields = Object.entries(fields ?? {}).flatMap(([name, entries]) => entries.map((raw: unknown) => {
    const field = raw as Record<string, unknown>;
    return { name, type: String(field.type ?? "unknown"), value: safeFieldValue(field.value) };
  })).slice(0, 500);

  const attachments = await pdf.getAttachments();
  const attachmentList: PdfDocumentIndex["attachments"] = [];
  for (const [id, item] of Array.from(attachments?.entries() ?? []).slice(0, 200)) {
    let sizeBytes = item.content?.byteLength ?? 0;
    if (item.content === undefined) {
      try { sizeBytes = (await pdf.getAttachmentContent(id))?.byteLength ?? 0; } catch { /* retain inventory with unknown size */ }
    }
    attachmentList.push({ id: String(id).slice(0, 256), filename: sanitizeFilename(item.filename), contentType: null, sizeBytes });
  }
  const warnings: string[] = [];
  const scanPages = pages.filter((page) => page.likelyScanned).map((page) => page.page);
  if (scanPages.length) warnings.push(`Pages ${scanPages.join(", ")} have little extractable text; no OCR was run.`);
  if (metadata.EncryptFilterName) warnings.push("The PDF reports an encryption filter; only content accessible to this parser was indexed.");
  if (Boolean(metadata.IsXFAPresent)) warnings.push("XFA form content may not be represented by the native text index.");
  if (attachmentList.length) warnings.push("Embedded attachments are inventoried but not extracted or executed.");
  if (info.IsSignaturesPresent) warnings.push("A signature marker is present; cryptographic validity and trust were not checked.");
  return {
    version: 1,
    contentHash,
    byteLength,
    pageCount: pdf.numPages,
    metadata,
    pages,
    bookmarks,
    formFields,
    attachments: attachmentList,
    warnings,
    extractedAt: new Date().toISOString(),
  };
}

function toBlock(item: TextItem, pageNumber: number, blockIndex: number, pageWidth: number, pageHeight: number, viewport: ReturnType<PDFPageProxy["getViewport"]>): PdfTextBlock {
  const transform = item.transform.map(Number);
  const x = transform[4] ?? 0;
  const y = transform[5] ?? 0;
  const width = Math.max(0, Number(item.width) || 0);
  const height = Math.max(0, Number(item.height) || 0);
  const points = [
    viewport.convertToViewportPoint(x, y),
    viewport.convertToViewportPoint(x + width, y),
    viewport.convertToViewportPoint(x + width, y + height),
    viewport.convertToViewportPoint(x, y + height),
  ];
  const xs = points.map(([px]) => px);
  const ys = points.map(([, py]) => py);
  const bbox: [number, number, number, number] = [
    clamp01(Math.min(...xs) / pageWidth),
    clamp01(Math.min(...ys) / pageHeight),
    clamp01(Math.max(...xs) / pageWidth),
    clamp01(Math.max(...ys) / pageHeight),
  ];
  return { blockId: `p${pageNumber}_b${blockIndex}`, text: item.str, bbox, fontSize: Math.hypot(transform[2] ?? 0, transform[3] ?? 0) };
}

export function assemblePageText(sourceItems: Array<unknown>): string {
  let result = "";
  let previous: TextItem | null = null;
  for (const item of sourceItems) {
    if (!item || typeof item !== "object" || !("str" in item)) { previous = null; continue; }
    const current = item as TextItem;
    if (!current.str) {
      if (current.hasEOL && result && !result.endsWith("\n")) result += "\n";
      continue;
    }
    if (previous && result && !result.endsWith("\n")) {
      const yDelta = Math.abs((previous.transform[5] ?? 0) - (current.transform[5] ?? 0));
      const previousX = (previous.transform[4] ?? 0) + previous.width;
      const gap = (current.transform[4] ?? 0) - previousX;
      const size = Math.max(1, current.height || previous.height || 10);
      if (yDelta > size * 0.5) result += "\n";
      else if (gap > size * 0.15 && !result.endsWith(" ")) result += " ";
    }
    result += current.str;
    if (current.hasEOL && !result.endsWith("\n")) result += "\n";
    previous = current;
  }
  return result.replace(/[\t\u00a0 ]+\n/g, "\n").trim();
}

async function readBookmarks(pdf: PDFDocumentProxy): Promise<PdfDocumentIndex["bookmarks"]> {
  const outline = await pdf.getOutline();
  if (!outline) return [];
  const resolved = await Promise.all(outline.slice(0, 100).map(async (item) => ({
    title: safeText(item.title, 300),
    page: await resolveOutlinePage(pdf, item.dest),
    children: await Promise.all((item.items ?? []).slice(0, 20).map(async (child) => ({
      title: safeText(child.title, 300),
      page: await resolveOutlinePage(pdf, child.dest),
    }))),
  })));
  return resolved;
}

async function resolveOutlinePage(pdf: PDFDocumentProxy, destination: unknown): Promise<number | null> {
  try {
    const target = typeof destination === "string" ? await pdf.getDestination(destination) : destination;
    if (!Array.isArray(target) || !target[0]) return null;
    return await pdf.getPageIndex(target[0]) + 1;
  } catch { return null; }
}

function safeFieldValue(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return safeText(String(value), 2_000);
  if (Array.isArray(value)) return safeText(value.map(String).join(", "), 2_000);
  return null;
}

function safeText(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max);
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }
