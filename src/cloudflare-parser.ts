import type { PdfDocumentIndex } from "./pdf-document-index.js";
import type { PdfDocumentParser } from "./pdf-documents.js";
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_INDEX_BYTES, MAX_DOCUMENT_PAGES, MAX_DOCUMENT_PAGE_TEXT_CHARS, MAX_DOCUMENT_BLOCKS, MAX_DOCUMENT_TEXT_BYTES, DocumentError } from "./document-constants.js";
import { z } from "zod";

const finite = z.number().finite();
const pageReference = z.number().int().min(1).max(MAX_DOCUMENT_PAGES).nullable();
const bookmark = z.object({ title: z.string(), page: pageReference });
const indexSchema = z.object({
  version: z.literal(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
  pageCount: z.number().int().min(1).max(MAX_DOCUMENT_PAGES),
  metadata: z.record(z.string(), z.union([z.string(), finite, z.boolean(), z.null()])),
  pages: z.array(z.object({
    page: z.number().int().min(1).max(MAX_DOCUMENT_PAGES), pageLabel: z.string().nullable(),
    width: finite.positive(), height: finite.positive(), rotation: finite,
    text: z.string().max(MAX_DOCUMENT_PAGE_TEXT_CHARS), charCount: z.number().int().nonnegative(),
    likelyScanned: z.boolean(), annotationCount: z.number().int().nonnegative(),
    blocks: z.array(z.object({ blockId: z.string(), text: z.string(), bbox: z.tuple([finite.min(0).max(1), finite.min(0).max(1), finite.min(0).max(1), finite.min(0).max(1)]), fontSize: finite })),
  })).max(MAX_DOCUMENT_PAGES),
  bookmarks: z.array(bookmark.extend({ children: z.array(bookmark) })),
  formFields: z.array(z.object({ name: z.string(), type: z.string(), value: z.string().nullable() })).max(500),
  attachments: z.array(z.object({ id: z.string(), filename: z.string(), contentType: z.string().nullable(), sizeBytes: z.number().int().nonnegative() })),
  warnings: z.array(z.string()), extractedAt: z.string(),
});

const MAX_PNG_BYTES = 4 * 1024 * 1024;
export type ParserRequest = (request: Request) => Promise<Response>;

export class CloudflarePdfParser implements PdfDocumentParser {
  constructor(private readonly request: ParserRequest, private readonly token: string) {}

  async parse(input: Uint8Array): Promise<PdfDocumentIndex> {
    const response = await this.call("/parse", input);
    const bytes = await readBounded(response, MAX_DOCUMENT_INDEX_BYTES);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("PDF parser returned invalid JSON."); }
    const parsed = indexSchema.safeParse(value);
    if (!parsed.success) throw new Error("PDF parser returned an invalid index schema.");
    const index = parsed.data;
    if (index.byteLength !== input.byteLength || index.pages.length !== index.pageCount || index.pages.some((page, position) => page.page !== position + 1) ||
        index.pages.reduce((count, page) => count + page.blocks.length, 0) > MAX_DOCUMENT_BLOCKS ||
        index.pages.reduce((count, page) => count + new TextEncoder().encode(page.text).byteLength, 0) > MAX_DOCUMENT_TEXT_BYTES) throw new Error("PDF parser returned an index outside the document limits.");
    return index;
  }

  async render(input: Uint8Array, pageNumber: number, crop: { x: number; y: number; width: number; height: number; scale?: number }): Promise<Uint8Array> {
    const params = new URLSearchParams({ page: String(pageNumber), x: String(crop.x), y: String(crop.y), width: String(crop.width), height: String(crop.height), scale: String(crop.scale ?? 1.5) });
    const response = await this.call(`/render?${params}`, input);
    const bytes = await readBounded(response, MAX_PNG_BYTES);
    if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("image/png") || bytes.byteLength < 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, position) => bytes[position] === byte)) throw new Error("PDF parser returned an invalid PNG.");
    return bytes;
  }

  private async call(path: string, body: Uint8Array): Promise<Response> {
    if (body.byteLength < 1 || body.byteLength > MAX_DOCUMENT_BYTES) throw new Error("PDF parser input exceeds the document limit.");
    const response = await this.request(new Request(`https://pdf-parser${path}`, { method: "POST", headers: { "content-type": "application/pdf", "content-length": String(body.byteLength), "x-document-container-token": this.token }, body: Uint8Array.from(body) }));
    if (!response.ok) {
      const bytes = await readBounded(response, 4096);
      let code = "document_parser_failed";
      try {
        const value = JSON.parse(new TextDecoder().decode(bytes));
        if (typeof value?.error?.code === "string" && /^[a-z_]{1,64}$/.test(value.error.code)) code = value.error.code;
      } catch { /* Do not expose runtime internals in public errors. */ }
      throw new DocumentError(code, response.status === 503 ? "PDF processing is temporarily unavailable; retry shortly." : "The PDF could not be processed safely.", [400, 413, 415, 422, 503].includes(response.status) ? response.status : 503);
    }
    return response;
  }
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximum) throw new Error("PDF parser response exceeded the bounded output limit.");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) { await reader.cancel(); throw new Error("PDF parser response exceeded the bounded output limit."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
