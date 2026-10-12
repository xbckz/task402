import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleRequest } from "../src/api.js";
import type { ApiRuntime } from "../src/api.js";
import { assemblePageText, buildPdfIndex } from "../src/pdf-document-index.js";
import { PdfDocumentService } from "../src/pdf-documents.js";
import { LocalPdfParser } from "../src/local-pdf-parser.js";
import type { PdfDocumentRow, PdfDocumentStore } from "../src/types.js";
import { MemoryArtifacts, makeService, paymentPayload } from "./helpers.js";

class MemoryDocuments implements PdfDocumentStore {
  readonly data = new Map<string, PdfDocumentRow>();
  async findByIdempotencyHash(hash: string): Promise<PdfDocumentRow | null> { return [...this.data.values()].find((row) => row.idempotencyHash === hash) ?? null; }
  async get(id: string): Promise<PdfDocumentRow | null> { return this.data.get(id) ?? null; }
  async findByPaymentKey(key: string): Promise<PdfDocumentRow | null> { return [...this.data.values()].find((row) => row.paymentKey === key) ?? null; }
  async insert(row: PdfDocumentRow): Promise<boolean> { if ([...this.data.values()].some((existing) => existing.idempotencyHash === row.idempotencyHash)) return false; this.data.set(row.id, row); return true; }
  async updatePayment(id: string, state: NonNullable<PdfDocumentRow["paymentState"]>, settlement: PdfDocumentRow["settlement"] = null, errorCode: string | null = null, expectedState?: NonNullable<PdfDocumentRow["paymentState"]>): Promise<boolean> { const row = this.data.get(id); if (!row || (expectedState && (row.paymentState ?? "complete") !== expectedState)) return false; this.data.set(id, { ...row, paymentState: state, settlement, errorCode }); return true; }
  async listExpired(now: number, limit: number): Promise<PdfDocumentRow[]> { return [...this.data.values()].filter((row) => row.expiresAt <= now).slice(0, limit); }
  async delete(id: string): Promise<void> { this.data.delete(id); }
}

const secret = "document-tests-use-a-secret-that-is-over-thirty-two-characters";
const recoveryKey = "recovery-".repeat(6);
const samplePdf = new Uint8Array(await readFile(new URL("../examples/sample-report.pdf", import.meta.url)));
const secondPdf = new Uint8Array(await readFile(new URL("../examples/local-demo.pdf", import.meta.url)));

test("text assembly preserves later text and line boundaries after empty items and marked content", () => {
  const item = (str: string, x: number, hasEOL = false) => ({ str, transform: [1, 0, 0, 10, x, 100], width: str.length * 5, height: 10, hasEOL });
  assert.equal(assemblePageText([item("First", 0), item("", 25, true), item("Second", 0), { type: "beginMarkedContent" }, item("Final", 40)]), "First\nSecondFinal");
  assert.equal(assemblePageText([item("First", 0), item("", 25), item("Second", 40)]), "First Second");
});

test("comparison counts an added blank page and validation rejects whitespace expectations", async () => {
  const fixture = makeDocuments();
  const left = await fixture.service.ingest(samplePdf, "left.pdf", "blank-left-key", recoveryKey);
  const right = await fixture.service.ingest(samplePdf, "right.pdf", "blank-right-key", recoveryKey);
  const row = fixture.rows.data.get(right.documentId)!;
  const index = JSON.parse(new TextDecoder().decode(fixture.artifacts.data.get(row.indexKey)!));
  index.pages.push({ ...index.pages[0], page: 3, text: "", charCount: 0, blocks: [] });
  index.pageCount = 3;
  fixture.artifacts.data.set(row.indexKey, new TextEncoder().encode(JSON.stringify(index)));
  const comparison = await fixture.service.compare(left.documentId, left.capability, right.documentId, right.capability);
  assert.equal(comparison.changedPageCount, 1);
  await assert.rejects(() => fixture.service.validate(left.documentId, left.capability, { requiredText: [" \n "] }), { code: "invalid_expectation" });
});

function makeDocuments(options: { ttlSeconds?: number } = {}) {
  const rows = new MemoryDocuments();
  const artifacts = new MemoryArtifacts();
  const service = new PdfDocumentService(rows, artifacts, { capabilitySecret: secret, publicBaseUrl: "http://127.0.0.1:8787", parser: new LocalPdfParser(), ...options });
  return { service, rows, artifacts };
}

test("native PDF index enforces signature and byte limits and retains bounded layout evidence", async () => {
  await assert.rejects(() => buildPdfIndex(new TextEncoder().encode("not a PDF")), { code: "invalid_pdf", status: 415 });
  const tooLarge = new Uint8Array(20 * 1024 * 1024 + 1);
  tooLarge.set(new TextEncoder().encode("%PDF-"));
  await assert.rejects(() => buildPdfIndex(tooLarge), { code: "document_too_large", status: 413 });
  const index = await buildPdfIndex(samplePdf);
  assert.equal(index.byteLength, samplePdf.byteLength);
  assert.equal(index.pageCount, 2);
  assert.equal(index.metadata.Title, "Quarterly Research Brief");
  assert.ok(index.pages[0]!.text.includes("Predictable pagination"));
  assert.ok(index.pages[0]!.blocks.length > 10);
  assert.ok(index.pages.every((page) => page.blocks.every((block) => block.bbox.every((v) => v >= 0 && v <= 1))));
});

test("document capability covers inspect, map, search, read, citation, compare, validate, crop, retries, and expiry", async () => {
  const fixture = makeDocuments({ ttlSeconds: 3600 });
  const first = await fixture.service.ingest(samplePdf, "quarterly report.pdf", "document-key-0001", recoveryKey);
  assert.equal(first.fileName, "quarterly report.pdf");
  assert.equal(first.pageCount, 2);
  assert.match(first.capability, /^[A-Za-z0-9_-]{40,64}$/);
  assert.equal((await fixture.service.inspect(first.documentId, first.capability)).byteLength, samplePdf.byteLength);
  await assert.rejects(() => fixture.service.inspect(first.documentId, "wrong"), { status: 404 });
  const otherScope = await fixture.service.ingest(samplePdf, "quarterly report.pdf", "document-key-0001", "x".repeat(40));
  assert.notEqual(otherScope.documentId, first.documentId);
  await assert.rejects(() => fixture.service.ingest(secondPdf, "different.pdf", "document-key-0001", recoveryKey), { status: 409 });

  const resumed = await fixture.service.ingest(samplePdf, "quarterly report.pdf", "document-key-0001", recoveryKey);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.documentId, first.documentId);
  assert.equal(resumed.capability, first.capability);

  const map = await fixture.service.getMap(first.documentId, first.capability) as { pages: Array<{ page: number; preview: string; annotationCount: number }> };
  assert.deepEqual(map.pages.map((page) => page.page), [1, 2]);
  assert.ok(map.pages[0]!.preview.includes("Quarterly Research Brief"));
  assert.equal(typeof map.pages[0]!.annotationCount, "number");
  const positionedMap = await fixture.service.getMap(first.documentId, first.capability, 1) as { pages: Array<{ blocks: Array<{ text: string; bbox: number[] }>; blockCount: number }> };
  assert.ok(positionedMap.pages[0]!.blockCount > 10);
  assert.ok(positionedMap.pages[0]!.blocks.every((block) => block.bbox.length === 4));

  const search = await fixture.service.search(first.documentId, first.capability, "predictable pagination", { limit: 2 }) as { totalMatches: number; hits: Array<{ page: number; excerpt: string }> };
  assert.equal(search.totalMatches, 1);
  assert.equal(search.hits[0]!.page, 1);
  assert.ok(search.hits[0]!.excerpt.includes("Predictable pagination"));
  await assert.rejects(() => fixture.service.search(first.documentId, first.capability, "x".repeat(201)), { code: "invalid_query" });

  const batch = await fixture.service.batchSearch(first.documentId, first.capability, ["Northstar Research", "End of report."]) as { results: Array<{ totalMatches: number }> };
  assert.deepEqual(batch.results.map((result) => result.totalMatches), [1, 1]);
  const context = await fixture.service.prepareContext(first.documentId, first.capability, "predictable pagination", 2000) as { selectedPages: number[]; text: string; evidence: unknown[] };
  assert.deepEqual(context.selectedPages, [1]);
  assert.match(context.text, /Predictable pagination/);
  assert.ok(context.evidence.length > 0);
  const fields = await fixture.service.extractFields(first.documentId, first.capability, [{ name: "invoice", label: "Invoice number" }]) as { fields: Array<{ value: string | null }> };
  assert.equal(fields.fields[0]!.value, null);
  await assert.rejects(() => fixture.service.batchSearch(first.documentId, first.capability, Array.from({ length: 21 }, () => "term")), { code: "invalid_queries" });

  const read = await fixture.service.read(first.documentId, first.capability, [1, 2]) as { pages: Array<{ text: string }>; truncated: boolean };
  assert.equal(read.truncated, false);
  assert.ok(read.pages[1]!.text.includes("End of report."));
  await assert.rejects(() => fixture.service.read(first.documentId, first.capability, [1, 2, 3]), { code: "invalid_page_selection" });

  const citation = await fixture.service.verifyCitation(first.documentId, first.capability, 1, "Predictable pagination makes reports easier to review.") as { verified: boolean; evidence: unknown[] };
  assert.equal(citation.verified, true);
  assert.ok(citation.evidence.length > 0);
  assert.equal((await fixture.service.verifyCitation(first.documentId, first.capability, 1, "A quote that is not in the report." ) as { verified: boolean }).verified, false);

  const validation = await fixture.service.validate(first.documentId, first.capability, { pageCount: 2, requiredText: ["Northstar Research", "End of report."] }) as { valid: boolean };
  assert.equal(validation.valid, true);
  const failedValidation = await fixture.service.validate(first.documentId, first.capability, { pageCount: 1, requiredText: ["absent marker"] }) as { valid: boolean };
  assert.equal(failedValidation.valid, false);

  const identical = await fixture.service.compare(first.documentId, first.capability, first.documentId, first.capability) as { identicalBytes: boolean; changedPageCount: number };
  assert.equal(identical.identicalBytes, true);
  assert.equal(identical.changedPageCount, 0);
  const second = await fixture.service.ingest(secondPdf, "local demo.pdf", "document-key-0002", recoveryKey);
  const different = await fixture.service.compare(first.documentId, first.capability, second.documentId, second.capability) as { identicalBytes: boolean; changedPageCount: number };
  assert.equal(different.identicalBytes, false);
  assert.ok(different.changedPageCount > 0);

  const png = await fixture.service.renderPage(first.documentId, first.capability, 1, { x: 0, y: 0, width: 0.5, height: 0.5, scale: 1 });
  assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.byteLength > 100);
  await assert.rejects(() => fixture.service.renderPage(first.documentId, first.capability, 1, { x: 0.8, y: 0, width: 0.5, height: 0.5 }), { code: "invalid_crop" });

  const row = fixture.rows.data.get(first.documentId)!;
  fixture.rows.data.set(first.documentId, { ...row, expiresAt: Date.now() - 1 });
  assert.equal(await fixture.service.cleanupExpired(), 1);
  assert.equal(fixture.rows.data.has(first.documentId), false);
  await assert.rejects(() => fixture.service.inspect(first.documentId, first.capability), { status: 404 });
});

test("concurrent identical uploads converge to one recoverable document and remove losing artifacts", async () => {
  const fixture = makeDocuments();
  const [left, right] = await Promise.all([
    fixture.service.ingest(samplePdf, "concurrent.pdf", "same-upload-key-001", recoveryKey),
    fixture.service.ingest(samplePdf, "concurrent.pdf", "same-upload-key-001", recoveryKey),
  ]);
  assert.equal(left.documentId, right.documentId);
  assert.equal(left.capability, right.capability);
  assert.equal(fixture.rows.data.size, 1);
  assert.equal(fixture.artifacts.data.size, 2);
});

test("REST document routes enforce capability, JSON limits, and explicit non-local runtime behavior", async () => {
  const pdf = makeDocuments();
  const generator = makeService();
  const runtime: ApiRuntime = { service: generator.service, priceUsd: "0.01", paymentMode: "dev-bypass", allowedMcpOrigins: new Set(), documents: pdf.service };
  const ingest = await handleRequest(new Request("http://localhost/v1/documents", {
    method: "POST", headers: { "content-type": "application/pdf", "x-file-name": "api.pdf", "idempotency-key": "http-ingest-0001", "x-document-recovery-key": recoveryKey }, body: samplePdf,
  }), runtime);
  assert.equal(ingest.status, 201);
  const doc = await ingest.json() as { documentId: string; capability: string };
  const denied = await handleRequest(new Request(`http://localhost/v1/documents/${doc.documentId}`), runtime);
  assert.equal(denied.status, 404);
  const inspect = await handleRequest(new Request(`http://localhost/v1/documents/${doc.documentId}`, { headers: { authorization: `Bearer ${doc.capability}` } }), runtime);
  assert.equal(inspect.status, 200);
  assert.equal((await inspect.json() as { pageCount: number }).pageCount, 2);
  const search = await handleRequest(new Request(`http://localhost/v1/documents/${doc.documentId}/search`, {
    method: "POST", headers: { authorization: `Bearer ${doc.capability}`, "content-type": "application/json" }, body: JSON.stringify({ query: "Northstar Research" }),
  }), runtime);
  assert.equal(search.status, 200);
  assert.equal((await search.json() as { totalMatches: number }).totalMatches, 1);
  const render = await handleRequest(new Request(`http://localhost/v1/documents/${doc.documentId}/pages/1/render?x=0&y=0&width=0.2&height=0.2&scale=0.5`, { headers: { authorization: `Bearer ${doc.capability}` } }), runtime);
  assert.equal(render.headers.get("content-type"), "image/png");
  const wrongMime = await handleRequest(new Request("http://localhost/v1/documents", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), runtime);
  assert.equal(wrongMime.status, 415);

  const unavailable = await handleRequest(new Request("http://localhost/v1/documents", { method: "POST", headers: { "content-type": "application/pdf" }, body: samplePdf }), { service: runtime.service, priceUsd: runtime.priceUsd, paymentMode: runtime.paymentMode, allowedMcpOrigins: runtime.allowedMcpOrigins });
  assert.equal(unavailable.status, 501);
  generator.jobs.close();
});

test("live document indexing returns an x402 challenge and settles after indexing", async () => {
  const documents = makeDocuments();
  const generator = makeService({ live: true });
  const runtime: ApiRuntime = { service: generator.service, priceUsd: "0.01", documentPriceUsd: "0.01", paymentMode: "live", allowedMcpOrigins: new Set(), documents: documents.service };
  const challenge = await handleRequest(new Request("https://pdf.example.test/v1/documents", { method: "POST", headers: { "content-type": "application/pdf" }, body: samplePdf }), runtime);
  assert.equal(challenge.status, 402);
  const required = await challenge.json() as { paymentRequired: { accepts: Array<{ amount: string }> } };
  assert.equal(required.paymentRequired.accepts[0]?.amount, "10000");
  const paid = await handleRequest(new Request("https://pdf.example.test/v1/documents", { method: "POST", headers: { "content-type": "application/pdf", "payment-signature": Buffer.from(JSON.stringify(paymentPayload(`0x${"55".repeat(32)}`, "https://pdf.example.test/v1/documents"))).toString("base64"), "x-file-name": "paid.pdf", "idempotency-key": "paid-document-0001", "x-document-recovery-key": recoveryKey }, body: samplePdf }), runtime);
  assert.equal(paid.status, 201);
  assert.equal(generator.gateway.settleCalls, 1);
  assert.equal((await paid.json() as { settlement?: { amount: string } }).settlement?.amount, "10000");
  const replay = await handleRequest(new Request("https://pdf.example.test/v1/documents", { method: "POST", headers: { "content-type": "application/pdf", "payment-signature": Buffer.from(JSON.stringify(paymentPayload(`0x${"55".repeat(32)}`, "https://pdf.example.test/v1/documents"))).toString("base64"), "x-file-name": "paid-2.pdf", "idempotency-key": "paid-document-0002", "x-document-recovery-key": "recovery-other-".repeat(5) }, body: samplePdf }), runtime);
  assert.equal(replay.status, 409);
  generator.jobs.close();
});

test("official MCP client exposes local PDF document tools and invokes bounded native-text search", async () => {
  const documents = makeDocuments();
  const doc = await documents.service.ingest(samplePdf, "mcp.pdf", "mcp-ingest-0001", recoveryKey);
  const generator = makeService();
  const runtime: ApiRuntime = { service: generator.service, priceUsd: "0.01", paymentMode: "dev-bypass", allowedMcpOrigins: new Set(), documents: documents.service };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, { method: incoming.method ?? "GET", headers: incoming.headers as HeadersInit, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      const response = await handleRequest(request, runtime);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new Client({ name: "pdf-documents-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)) as unknown as Parameters<typeof client.connect>[0]);
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "inspect_pdf"));
    assert.ok(listed.tools.some((tool) => tool.name === "render_pdf_page_region"));
    assert.ok(listed.tools.some((tool) => tool.name === "extract_document_fields"));
    const result = await client.callTool({ name: "search_document", arguments: { document_id: doc.documentId, capability: doc.capability, query: "Predictable pagination" } });
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as { totalMatches: number }).totalMatches, 1);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    generator.jobs.close();
  }
});
