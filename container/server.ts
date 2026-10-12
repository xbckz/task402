import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { LocalPdfParser } from "../src/local-pdf-parser.js";
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_INDEX_BYTES, DocumentError } from "../src/document-constants.js";

const token = process.env.DOCUMENT_CONTAINER_TOKEN ?? "";
const parser = new LocalPdfParser();

const server = createServer(async (request, response) => {
  if (request.headers["x-document-container-token"] !== token) return finish(response, 404, "Not found");
  if (request.method === "GET" && request.url === "/health") return finish(response, 200, "ok", "text/plain; charset=utf-8");
  const url = new URL(request.url ?? "/", "http://container");
  if (request.method !== "POST" || (url.pathname !== "/parse" && url.pathname !== "/render")) return finish(response, 404, "Not found");
  try {
    const bytes = await readBody(request);
    if (url.pathname === "/parse") {
      const index = await parser.parse(bytes);
      const output = Buffer.from(JSON.stringify(index));
      if (output.byteLength > MAX_DOCUMENT_INDEX_BYTES) throw new DocumentError("document_index_too_large", "Extracted PDF index exceeds the output limit.", 413);
      return finish(response, 200, output, "application/json");
    }
    const number = (name: string) => Number(url.searchParams.get(name));
    const page = number("page");
    const crop = { x: number("x"), y: number("y"), width: number("width"), height: number("height"), scale: number("scale") };
    if (!Number.isInteger(page) || page < 1 || !Object.values(crop).every(Number.isFinite)) throw new DocumentError("invalid_crop", "Render parameters are invalid.", 400);
    const png = await parser.render(bytes, page, crop);
    return finish(response, 200, Buffer.from(png), "image/png");
  } catch (error) {
    const documentError = error instanceof DocumentError;
    return finish(response, documentError ? error.status : 422, JSON.stringify({ error: { code: documentError ? error.code : "pdf_parse_failed", message: error instanceof Error ? error.message : "PDF processing failed." } }), "application/json");
  }
});

server.listen(8080, "0.0.0.0");

function readBody(request: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_DOCUMENT_BYTES) { request.destroy(); reject(new DocumentError("document_too_large", "PDF upload exceeds the document limit.", 413)); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    request.on("error", reject);
  });
}

function finish(response: ServerResponse, status: number, body: string | Uint8Array, contentType = "text/plain; charset=utf-8"): void {
  const bytes = Buffer.from(body);
  response.writeHead(status, { "content-type": contentType, "content-length": bytes.byteLength, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(bytes);
}
