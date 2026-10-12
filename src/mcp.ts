import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PdfService } from "./service.js";
import { MAX_REQUEST_BYTES } from "./security.js";
import type { PaymentPayloadV2 } from "./types.js";
import type { PdfDocumentService } from "./pdf-documents.js";
import type { ToolStatsStore } from "./types.js";
import type { PaidToolService, PaidToolDefinition } from "./paid-tools.js";
import { fetchWebEvidence, inspectOpenApi, planOpenApiRequest, diffOpenApi, readChainBalance, type PublicHostResolver } from "./agent-tools.js";
import { usdToSixDecimals } from "./payments.js";

const EXAMPLE_ADDRESS = "0xAEA6fDF13ca10aD6B906884ffAcBb58a0e9E144A";
const EXAMPLE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const EXAMPLE_TX_HASH = "0x6a20a573804c89b1bf0104ac23ea9bbcd5bcfad53d8f0fd1ead2edbe40209c3f";

// Smithery scores the executable MCP contract, not just the human-facing listing.
// Keep descriptions and useful structured result schemas on every tool so clients
// can plan calls without reverse-engineering implementation details.  Every field
// is optional because paid tools also return a structured error/challenge envelope;
// passthrough preserves forward-compatible fields as the service evolves.
function structuredOutput(shape: Record<string, z.ZodTypeAny>, description: string) {
  return z.object(shape).passthrough().describe(description);
}

const jobOutputSchema = structuredOutput({
  jobId: z.string().uuid().optional(), state: z.string().optional(), title: z.string().optional(),
  createdAt: z.string().optional(), expiresAt: z.string().optional(), statusUrl: z.string().url().optional(),
  downloadUrl: z.string().url().optional(), capability: z.string().optional(), artifactBytes: z.number().int().nonnegative().optional(),
  settlement: z.unknown().optional(), resumed: z.boolean().optional(), errorCode: z.string().optional(),
}, "PDF job status, download capability, and settlement details.");
const inspectPdfOutputSchema = structuredOutput({
  documentId: z.string().uuid().optional(), fileName: z.string().optional(), contentHash: z.string().optional(), byteLength: z.number().int().nonnegative().optional(),
  pageCount: z.number().int().nonnegative().optional(), metadata: z.unknown().optional(), bookmarks: z.array(z.unknown()).optional(), formFields: z.array(z.unknown()).optional(),
  attachments: z.array(z.unknown()).optional(), warnings: z.array(z.string()).optional(), createdAt: z.string().optional(), expiresAt: z.string().optional(), operations: z.array(z.string()).optional(),
}, "PDF metadata, page count, extracted capabilities, and parser warnings.");
const documentMapOutputSchema = structuredOutput({ documentId: z.string().uuid().optional(), pageCount: z.number().int().nonnegative().optional(), bookmarks: z.array(z.unknown()).optional(), pages: z.array(z.unknown()).optional(), warnings: z.array(z.string()).optional() }, "PDF page map with dimensions, text coverage, and optional positioned blocks.");
const searchOutputSchema = structuredOutput({ documentId: z.string().uuid().optional(), query: z.string().optional(), totalMatches: z.number().int().nonnegative().optional(), truncated: z.boolean().optional(), hits: z.array(z.unknown()).optional() }, "Bounded native-text search hits with page evidence.");
const batchSearchOutputSchema = structuredOutput({ documentId: z.string().uuid().optional(), results: z.array(z.unknown()).optional() }, "Results for each bounded native-text search query.");
const fieldsOutputSchema = structuredOutput({ documentId: z.string().uuid().optional(), fields: z.array(z.unknown()).optional(), warning: z.string().optional() }, "Literal PDF field values with page and block evidence.");
const contextOutputSchema = structuredOutput({ documentId: z.string().uuid().optional(), query: z.string().optional(), maxChars: z.number().int().nonnegative().optional(), selectedPages: z.array(z.number().int()).optional(), omittedPages: z.array(z.number().int()).optional(), text: z.string().optional(), pages: z.array(z.unknown()).optional(), evidence: z.array(z.unknown()).optional(), truncated: z.boolean().optional(), method: z.string().optional(), warning: z.string().optional() }, "Bounded cited context ranked from native PDF text.");
const readDocumentOutputSchema = structuredOutput({ documentId: z.string().uuid().optional(), pages: z.array(z.unknown()).optional(), truncated: z.boolean().optional() }, "Native text for the requested PDF pages.");
const citationOutputSchema = structuredOutput({ documentId: z.string().uuid().optional(), verified: z.boolean().optional(), page: z.number().int().optional(), pageLabel: z.string().optional(), quote: z.string().optional(), pageTextOffset: z.number().int().optional(), evidence: z.array(z.unknown()).optional(), reason: z.string().optional(), method: z.string().optional(), warning: z.string().optional() }, "Citation verification result with exact page and text evidence.");
const compareOutputSchema = structuredOutput({ left: z.unknown().optional(), right: z.unknown().optional(), identicalBytes: z.boolean().optional(), identicalExtractedPageText: z.boolean().optional(), changedPageCount: z.number().int().nonnegative().optional(), changedPages: z.array(z.unknown()).optional(), truncated: z.boolean().optional(), method: z.string().optional(), warning: z.string().optional() }, "Page-by-page normalized native-text comparison result.");
const validateOutputSchema = structuredOutput({ documentId: z.string().uuid().optional(), valid: z.boolean().optional(), checks: z.array(z.unknown()).optional(), warnings: z.array(z.string()).optional() }, "PDF parsing, page-count, required-text, and native-text coverage checks.");
const renderOutputSchema = structuredOutput({ documentId: z.string().uuid().optional(), page: z.number().int().optional(), contentType: z.string().optional(), bytes: z.number().int().nonnegative().optional() }, "Rendered PDF crop metadata; the image is returned as an MCP image content block.");
const webEvidenceOutputSchema = structuredOutput({ url: z.string().url().optional(), finalUrl: z.string().url().optional(), status: z.number().int().optional(), contentType: z.string().optional(), title: z.string().nullable().optional(), description: z.string().nullable().optional(), fetchedAt: z.string().optional(), extraction: z.string().optional(), text: z.string().optional(), matches: z.array(z.unknown()).optional(), links: z.array(z.unknown()).optional(), sourceHash: z.string().optional(), truncated: z.boolean().optional(), warnings: z.array(z.string()).optional() }, "Citation-ready bounded evidence fetched from a public HTTPS page.");
const openApiInspectOutputSchema = structuredOutput({ title: z.string().nullable().optional(), version: z.string().optional(), openapi: z.string().optional(), servers: z.array(z.string()).optional(), operations: z.array(z.unknown()).optional(), warnings: z.array(z.string()).optional(), resolvedReferences: z.number().int().nonnegative().optional() }, "OpenAPI version, servers, operations, response codes, and warnings.");
const openApiPlanOutputSchema = structuredOutput({ operation: z.unknown().optional(), request: z.unknown().optional(), warnings: z.array(z.string()).optional() }, "Safe request plan for a selected OpenAPI operation; no request is executed.");
const openApiDiffOutputSchema = structuredOutput({ added: z.array(z.string()).optional(), removed: z.array(z.string()).optional(), changed: z.array(z.unknown()).optional(), breaking: z.boolean().optional(), comparedAt: z.string().optional() }, "OpenAPI operation additions, removals, compatibility changes, and breaking flag.");
const chainBalanceOutputSchema = structuredOutput({ network: z.string().optional(), address: z.string().optional(), block: z.string().optional(), balanceWei: z.string().optional(), observedAt: z.string().optional() }, "Native Base balance in wei at the requested block.");
const chainTransactionOutputSchema = structuredOutput({ network: z.string().optional(), hash: z.string().optional(), status: z.string().optional(), blockNumber: z.number().int().nullable().optional(), confirmations: z.number().int().nonnegative().optional(), transaction: z.unknown().nullable().optional(), receipt: z.unknown().nullable().optional(), observedAt: z.string().optional() }, "Base transaction, receipt, status, and confirmation count.");
const erc20BalanceOutputSchema = structuredOutput({ network: z.string().optional(), token: z.string().optional(), address: z.string().optional(), block: z.string().optional(), balanceAtomic: z.string().optional(), decimals: z.number().int().nonnegative().optional(), symbol: z.string().optional(), observedAt: z.string().optional() }, "ERC-20 token balance in atomic units with optional token metadata.");

function described<T extends z.ZodTypeAny>(schema: T, description: string): T {
  return schema.describe(description) as T;
}

/** Canonical HTTPS resource advertised to x402/Bazaar clients. */
export function mcpPdfResource(service: PdfService): string {
  return `${service.config.publicBaseUrl.replace(/\/+$/, "")}/mcp`;
}

export async function handleMcpRequest(request: Request, service: PdfService, allowedOrigins: Set<string>, documents?: PdfDocumentService, stats?: ToolStatsStore, paidTools?: PaidToolService, prices: { webEvidencePriceUsd?: string; openApiPriceUsd?: string; chainPriceUsd?: string; webHostResolver?: PublicHostResolver; webFetch?: typeof fetch } = {}): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins.has(origin)) {
    return Response.json({ error: { code: "origin_not_allowed", message: "MCP Origin is not allowed." } }, { status: 403 });
  }

  const discoveryMethod = await inspectDiscoveryMethod(request);

  const server = new McpServer({ name: "x402-pdf", version: "0.3.1" });
  server.registerTool("generate_pdf", {
    title: "Generate PDF",
    description: "Create a professionally formatted, paginated PDF from Markdown. Returns a short-lived download capability.",
    annotations: { idempotentHint: true, destructiveHint: false, readOnlyHint: false, openWorldHint: false },
    outputSchema: jobOutputSchema,
    inputSchema: {
      title: described(z.string().min(1).max(160), "Human-readable title for the generated PDF."),
      markdown: described(z.string().min(1).max(240 * 1024), "Markdown content to paginate into the PDF."),
      idempotency_key: described(z.string().min(8).max(128), "Stable key used to make a paid retry idempotent."),
    },
  }, async (args, extra): Promise<CallToolResult> => withToolStats(stats, "generate_pdf", async () => {
    const payment = asPaymentPayload(extra._meta?.["x402/payment"]);
    const outcome = await service.create(
      { title: args.title, markdown: args.markdown },
      args.idempotency_key,
      payment,
      mcpPdfResource(service),
    );
    if (outcome.kind === "payment_required") return paymentRequiredResult(outcome.paymentRequired);
    if (outcome.kind === "error") return serviceErrorResult(outcome.error.code, outcome.error.message, outcome.error.details);

    const job = outcome.job;
    return {
      content: [{ type: "text", text: JSON.stringify(job) }],
      structuredContent: { ...job },
      ...(job.settlement ? { _meta: { "x402/payment-response": job.settlement } } : {}),
    };
  }, service.config.payment.requirements?.amount));

  server.registerTool("get_pdf_job", {
    title: "Get PDF job status",
    description: "Read the status for a PDF job using its unguessable capability.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: jobOutputSchema,
    inputSchema: {
      job_id: described(z.string().uuid(), "Job UUID returned by generate_pdf."),
      capability: described(z.string().min(40).max(64), "Short-lived capability returned by generate_pdf."),
    },
  }, async ({ job_id, capability }): Promise<CallToolResult> => withToolStats(stats, "get_pdf_job", async () => {
    const row = await service.getJob(job_id, capability);
    if (!row) return serviceErrorResult("job_not_found", "The job does not exist, has expired, or the capability is invalid.");
    const result = {
      jobId: row.id,
      state: row.state,
      title: row.title,
      createdAt: new Date(row.createdAt).toISOString(),
      expiresAt: new Date(row.expiresAt).toISOString(),
      ...service.jobUrls(row.id),
      ...(row.artifactBytes !== null ? { artifactBytes: row.artifactBytes } : {}),
      ...(row.errorCode ? { errorCode: row.errorCode } : {}),
      ...(row.settlement ? { settlement: row.settlement } : {}),
    };
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  }));

  if (documents) {
    server.registerTool("inspect_pdf", {
      title: "Inspect PDF",
      description: "Inspect a previously uploaded PDF using its document capability. Upload binary PDFs through POST /v1/documents; persist both the returned capability and recovery key securely.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: inspectPdfOutputSchema,
      inputSchema: { document_id: described(z.string().uuid(), "UUID returned by POST /v1/documents."), capability: described(z.string().min(40).max(64), "Document capability returned by POST /v1/documents.") },
    }, async ({ document_id, capability }) => withToolStats(stats, "inspect_pdf", () => documentToolResult(() => documents.inspect(document_id, capability))));

    server.registerTool("get_document_map", {
      title: "Get PDF page map",
      description: "Return page labels, sizes, native-text previews, bookmarks, and sparse-text warnings. Set page to include up to 500 positioned text blocks for that page.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: documentMapOutputSchema,
      inputSchema: { document_id: described(z.string().uuid(), "UUID returned by POST /v1/documents."), capability: described(z.string().min(40).max(64), "Document capability returned by POST /v1/documents."), page: described(z.number().int().min(1).max(100), "Optional 1-based page number.").optional() },
    }, async ({ document_id, capability, page }) => withToolStats(stats, "get_document_map", () => documentToolResult(() => documents.getMap(document_id, capability, page))));

    server.registerTool("search_document", {
      title: "Search PDF text",
      description: "Find exact normalized text matches in native PDF text (no OCR). Results and excerpts are bounded.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: searchOutputSchema,
      inputSchema: {
        document_id: described(z.string().uuid(), "UUID returned by POST /v1/documents."), capability: described(z.string().min(40).max(64), "Document capability returned by POST /v1/documents."), query: described(z.string().min(1).max(200), "Exact or normalized text to find."),
        page: described(z.number().int().min(1), "Optional 1-based page filter.").optional(), limit: described(z.number().int().min(1).max(20), "Maximum number of matches to return.").optional(),
      },
    }, async ({ document_id, capability, query, page, limit }) => withToolStats(stats, "search_document", () => documentToolResult(() => documents.search(document_id, capability, query, { ...(page !== undefined ? { page } : {}), ...(limit !== undefined ? { limit } : {}) }))));

    server.registerTool("batch_search_document", {
      title: "Batch search PDF text",
      description: "Search up to 20 exact normalized-text queries in one bounded call. Useful when an agent needs several clauses or fields from one PDF.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: batchSearchOutputSchema,
      inputSchema: { document_id: described(z.string().uuid(), "UUID returned by POST /v1/documents."), capability: described(z.string().min(40).max(64), "Document capability returned by POST /v1/documents."), queries: described(z.array(z.string().min(1).max(200)).min(1).max(20), "One to twenty exact or normalized text queries."), page: described(z.number().int().min(1), "Optional 1-based page filter.").optional(), limit: described(z.number().int().min(1).max(20), "Maximum matches per query.").optional() },
    }, async ({ document_id, capability, queries, page, limit }) => withToolStats(stats, "batch_search_document", () => documentToolResult(() => documents.batchSearch(document_id, capability, queries, { ...(page !== undefined ? { page } : {}), ...(limit !== undefined ? { limit } : {}) }))));

    server.registerTool("prepare_document_context", {
      title: "Prepare cited PDF context",
      description: "Rank native-text pages for a question and return a bounded context pack with page, block, and excerpt evidence. No model call or OCR is used.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: contextOutputSchema,
      inputSchema: { document_id: described(z.string().uuid(), "UUID returned by POST /v1/documents."), capability: described(z.string().min(40).max(64), "Document capability returned by POST /v1/documents."), query: described(z.string().min(1).max(200), "Question or terms used for deterministic page ranking."), max_chars: described(z.number().int().min(1000).max(32000), "Maximum context characters.").optional(), pages: described(z.array(z.number().int().min(1).max(100)).max(100), "Optional 1-based pages to search.").optional() },
    }, async ({ document_id, capability, query, max_chars, pages }) => withToolStats(stats, "prepare_document_context", () => documentToolResult(() => documents.prepareContext(document_id, capability, query, max_chars, pages))));

    server.registerTool("extract_document_fields", {
      title: "Extract labeled PDF fields",
      description: "Extract caller-supplied literal labels and adjacent native-text values with page and block evidence. Missing labels return null; no semantic extraction or OCR is performed.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: fieldsOutputSchema,
      inputSchema: { document_id: described(z.string().uuid(), "UUID returned by POST /v1/documents."), capability: described(z.string().min(40).max(64), "Document capability returned by POST /v1/documents."), fields: described(z.array(z.object({ name: z.string().min(1).max(80).describe("Output field name."), label: z.string().min(1).max(160).describe("Literal label to locate."), page: z.number().int().min(1).max(100).optional().describe("Optional 1-based page filter.") })).min(1).max(20), "One to twenty literal labels to extract.") },
    }, async ({ document_id, capability, fields }) => withToolStats(stats, "extract_document_fields", () => documentToolResult(() => documents.extractFields(document_id, capability, fields))));

    server.registerTool("read_document", {
      title: "Read PDF pages",
      description: "Read extractable native text from up to 10 selected pages. Output is limited to 32,000 characters; scanned pages need OCR, which is not provided.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: readDocumentOutputSchema,
      inputSchema: { document_id: described(z.string().uuid(), "UUID returned by POST /v1/documents."), capability: described(z.string().min(40).max(64), "Document capability returned by POST /v1/documents."), pages: described(z.array(z.number().int().min(1)).min(1).max(10), "One to ten 1-based page numbers to read.") },
    }, async ({ document_id, capability, pages }) => withToolStats(stats, "read_document", () => documentToolResult(() => documents.read(document_id, capability, pages))));

    server.registerTool("verify_document_citation", {
      title: "Verify PDF text citation",
      description: "Check that a quote of 5 to 500 characters appears on the stated page in extracted native text. This does not establish truth or visual reading order.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: citationOutputSchema,
      inputSchema: { document_id: described(z.string().uuid(), "UUID returned by POST /v1/documents."), capability: described(z.string().min(40).max(64), "Document capability returned by POST /v1/documents."), page: described(z.number().int().min(1), "1-based page containing the quote."), quote: described(z.string().min(5).max(500), "Quote to verify in native PDF text.") },
    }, async ({ document_id, capability, page, quote }) => withToolStats(stats, "verify_document_citation", () => documentToolResult(() => documents.verifyCitation(document_id, capability, page, quote))));

    server.registerTool("compare_pdfs", {
      title: "Compare PDFs",
      description: "Compare page count and normalized native text between two separately authorized uploaded PDFs. Image-only and visual differences are not compared.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: compareOutputSchema,
      inputSchema: {
        left_document_id: described(z.string().uuid(), "UUID of the earlier PDF."), left_capability: described(z.string().min(40).max(64), "Capability for the earlier PDF."),
        right_document_id: described(z.string().uuid(), "UUID of the later PDF."), right_capability: described(z.string().min(40).max(64), "Capability for the later PDF."),
      },
    }, async ({ left_document_id, left_capability, right_document_id, right_capability }) => withToolStats(stats, "compare_pdfs", () => documentToolResult(() => documents.compare(left_document_id, left_capability, right_document_id, right_capability))));

    server.registerTool("validate_pdf_text", {
      title: "Validate PDF text expectations",
      description: "Check that the PDF parses, has an optional expected page count, and contains required text. This does not perform PDF/A, signature, visual, or OCR validation.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: validateOutputSchema,
      inputSchema: {
        document_id: described(z.string().uuid(), "UUID returned by POST /v1/documents."), capability: described(z.string().min(40).max(64), "Document capability returned by POST /v1/documents."),
        page_count: described(z.number().int().min(1).max(100), "Expected number of pages.").optional(), required_text: described(z.array(z.string().min(1).max(500)).max(20), "Literal text strings that must be present.").optional(),
      },
    }, async ({ document_id, capability, page_count, required_text }) => withToolStats(stats, "validate_pdf_text", () => documentToolResult(() => documents.validate(document_id, capability, { ...(page_count !== undefined ? { pageCount: page_count } : {}), ...(required_text !== undefined ? { requiredText: required_text } : {}) }))));

    server.registerTool("render_pdf_page_region", {
      title: "Render PDF page region",
      description: "Render one authorized PDF page crop as PNG. x/y/width/height are normalized 0-1 page fractions; output is bounded to four million pixels.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: renderOutputSchema,
      inputSchema: {
        document_id: described(z.string().uuid(), "UUID returned by POST /v1/documents."), capability: described(z.string().min(40).max(64), "Document capability returned by POST /v1/documents."), page: described(z.number().int().min(1), "1-based page to render."),
        x: described(z.number().min(0).max(1), "Normalized left crop coordinate."), y: described(z.number().min(0).max(1), "Normalized top crop coordinate."), width: described(z.number().min(0.001).max(1), "Normalized crop width."), height: described(z.number().min(0.001).max(1), "Normalized crop height."), scale: described(z.number().min(0.5).max(3), "Render scale multiplier.").optional(),
      },
    }, async ({ document_id, capability, page, x, y, width, height, scale }) => withToolStats(stats, "render_pdf_page_region", async () => {
      try {
        const png = await documents.renderPage(document_id, capability, page, { x, y, width, height, ...(scale !== undefined ? { scale } : {}) });
        const data = Buffer.from(png).toString("base64");
        return { content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: JSON.stringify({ documentId: document_id, page, contentType: "image/png", bytes: png.byteLength }) }], structuredContent: { documentId: document_id, page, contentType: "image/png", bytes: png.byteLength } };
      } catch (error) { return documentToolError(error); }
    }));
  }

  if (paidTools) {
    registerPaidTools(server, paidTools, stats, prices);
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    allowedOrigins: [...allowedOrigins],
    enableDnsRebindingProtection: allowedOrigins.size > 0,
    maxRequestBodySize: MAX_REQUEST_BYTES,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  response.headers.set("cache-control", "no-store");
  if (discoveryMethod && response.status < 400) await stats?.recordTraffic?.({ event: discoveryMethod === "initialize" ? "mcp_initialize_request" : "mcp_tools_list_request" }).catch(() => undefined);
  return response;
}

async function withToolStats(stats: ToolStatsStore | undefined, tool: string, operation: () => Promise<CallToolResult>, configuredAmount?: string): Promise<CallToolResult> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    const paymentRequired = result.isError && isPaymentRequiredResult(result);
    const job = result.structuredContent as { resumed?: boolean; settlement?: { amount?: unknown } } | undefined;
    const meta = result._meta as { [key: string]: unknown } | undefined;
    const paymentResponse = meta?.["x402/payment-response"] as { amount?: unknown } | undefined;
    const resumed = Boolean(job?.resumed || meta?.["x402/resumed"] === true);
    const metered = tool === "generate_pdf" || configuredAmount !== undefined;
    const amount = !result.isError && !resumed && metered ? job?.settlement?.amount ?? paymentResponse?.amount ?? configuredAmount : undefined;
    const settledAmountAtomic = typeof amount === "string" && /^\d+$/.test(amount) ? amount : undefined;
    await stats?.record({ tool, status: paymentRequired ? 402 : result.isError ? 400 : 200, outcome: paymentRequired ? "payment_required" : result.isError ? "error" : "success", durationMs: Date.now() - startedAt, ...(settledAmountAtomic !== undefined ? { settledAmountAtomic } : {}) }).catch(() => undefined);
    if (paymentRequired) await stats?.recordTraffic?.({ event: tool === "generate_pdf" ? "generation_payment_challenge" : "paid_tool_payment_challenge" }).catch(() => undefined);
    else if (!result.isError && tool === "generate_pdf" && !resumed) await stats?.recordTraffic?.({ event: "generation_completed" }).catch(() => undefined);
    else if (!result.isError && tool !== "generate_pdf" && tool !== "get_pdf_job" && !resumed) await stats?.recordTraffic?.({ event: "paid_tool_completed" }).catch(() => undefined);
    return result;
  } catch (error) {
    await stats?.record({ tool, status: 500, outcome: "error", durationMs: Date.now() - startedAt }).catch(() => undefined);
    throw error;
  }
}

function registerPaidTools(server: McpServer, paidTools: PaidToolService, stats: ToolStatsStore | undefined, prices: { webEvidencePriceUsd?: string; openApiPriceUsd?: string; chainPriceUsd?: string; webHostResolver?: PublicHostResolver; webFetch?: typeof fetch }): void {
  const webDefinition: PaidToolDefinition = { name: "web_evidence", resourcePath: "/mcp", priceUsd: prices.webEvidencePriceUsd ?? "0.005", description: "Fetch a public HTTPS page and return bounded citation-ready evidence.", inputSchema: { type: "object", required: ["url", "idempotency_key"], additionalProperties: false, properties: { url: { type: "string", format: "uri", maxLength: 2048 }, query: { type: "string", maxLength: 200 }, max_chars: { type: "integer", minimum: 2000, maximum: 24000 }, idempotency_key: { type: "string", minLength: 8, maxLength: 128 } } }, example: { url: "https://example.com/", query: "Example Domain", max_chars: 4000, idempotency_key: "web-evidence-0001" }, outputExample: { text: "...", sourceHash: "sha256" } };
  server.registerTool("web_evidence", { title: "Web evidence", description: webDefinition.description, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, outputSchema: webEvidenceOutputSchema, inputSchema: { url: described(z.string().url().max(2048), "Public HTTPS page URL to fetch."), query: described(z.string().max(200), "Optional phrase to locate in the page.").optional(), max_chars: described(z.number().int().min(2000).max(24000), "Maximum characters to return.").optional(), idempotency_key: described(z.string().min(8).max(128), "Stable key used to make a paid retry idempotent.") } }, async ({ url, query, max_chars, idempotency_key }, extra) => {
    const input = { url, ...(query !== undefined ? { query } : {}), ...(max_chars !== undefined ? { max_chars } : {}) };
    return withToolStats(stats, "web_evidence", () => paidMcpCall(paidTools, webDefinition, input, idempotency_key, extra._meta?.["x402/payment"], () => fetchWebEvidence(input, prices.webFetch ?? fetch, prices.webHostResolver)), usdToSixDecimals(webDefinition.priceUsd));
  });

  const inspectDefinition: PaidToolDefinition = { name: "inspect_openapi", resourcePath: "/mcp", priceUsd: prices.openApiPriceUsd ?? "0.001", description: "Inspect a caller-supplied OpenAPI JSON document without fetching remote references.", inputSchema: { type: "object", required: ["spec", "idempotency_key"], additionalProperties: false, properties: { spec: {}, idempotency_key: { type: "string", minLength: 8, maxLength: 128 } } }, example: { spec: { openapi: "3.1.0", info: { title: "Example", version: "1" }, paths: {} }, idempotency_key: "openapi-inspect-0001" }, outputExample: { operations: [] } };
  server.registerTool("inspect_openapi", { title: "Inspect OpenAPI", description: inspectDefinition.description, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, outputSchema: openApiInspectOutputSchema, inputSchema: { spec: described(z.any(), "OpenAPI JSON document to inspect; remote references are not fetched."), idempotency_key: described(z.string().min(8).max(128), "Stable key used to make a paid retry idempotent.") } }, async ({ spec, idempotency_key }, extra) => {
    return withToolStats(stats, "inspect_openapi", () => paidMcpCall(paidTools, inspectDefinition, { spec }, idempotency_key, extra._meta?.["x402/payment"], () => Promise.resolve(inspectOpenApi(spec))), usdToSixDecimals(inspectDefinition.priceUsd));
  });

  const planDefinition: PaidToolDefinition = { name: "plan_api_request", resourcePath: "/mcp", priceUsd: "0.002", description: "Select an OpenAPI operation and generate a safe request plan without executing it.", inputSchema: { type: "object", required: ["spec", "idempotency_key"], additionalProperties: false, properties: { spec: {}, operation_id: { type: "string" }, path: { type: "string" }, method: { type: "string" }, idempotency_key: { type: "string", minLength: 8, maxLength: 128 } } }, example: { spec: { openapi: "3.1.0", info: { title: "Example API", version: "1" }, servers: [{ url: "https://api.example.com" }], paths: { "/users/{id}": { get: { operationId: "getUser", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK" } } } } } }, operation_id: "getUser", idempotency_key: "openapi-plan-0001" }, outputExample: { request: { method: "GET", url: "https://api.example.com/users/{id}" } } };
  server.registerTool("plan_api_request", { title: "Plan API request", description: planDefinition.description, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, outputSchema: openApiPlanOutputSchema, inputSchema: { spec: described(z.any(), "OpenAPI JSON document containing the operation to plan."), operation_id: described(z.string(), "Preferred operationId selector.").optional(), path: described(z.string(), "Optional path selector.").optional(), method: described(z.string(), "Optional HTTP method selector.").optional(), idempotency_key: described(z.string().min(8).max(128), "Stable key used to make a paid retry idempotent.") } }, async ({ spec, operation_id, path, method, idempotency_key }, extra) => {
    const selector = { ...(operation_id ? { operation_id } : {}), ...(path ? { path } : {}), ...(method ? { method } : {}) };
    return withToolStats(stats, "plan_api_request", () => paidMcpCall(paidTools, planDefinition, { spec, operation_id, path, method }, idempotency_key, extra._meta?.["x402/payment"], () => Promise.resolve(planOpenApiRequest(spec, selector))), usdToSixDecimals(planDefinition.priceUsd));
  });

  const diffDefinition: PaidToolDefinition = {
    name: "diff_openapi", resourcePath: "/mcp", priceUsd: "0.002", description: "Compare two caller-supplied OpenAPI JSON documents.",
    inputSchema: { type: "object", required: ["before", "after", "idempotency_key"], additionalProperties: false, properties: { before: {}, after: {}, idempotency_key: { type: "string", minLength: 8, maxLength: 128 } } },
    example: {
      before: { openapi: "3.1.0", info: { title: "Example API", version: "1" }, paths: {} },
      after: { openapi: "3.1.0", info: { title: "Example API", version: "2" }, paths: { "/health": { get: { operationId: "health", responses: { "200": { description: "OK" } } } } } },
      idempotency_key: "openapi-diff-0001",
    },
    outputExample: { added: ["GET /health"], removed: [], changed: [] },
  };
  server.registerTool("diff_openapi", { title: "Diff OpenAPI", description: diffDefinition.description, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, outputSchema: openApiDiffOutputSchema, inputSchema: { before: described(z.any(), "Earlier OpenAPI JSON document."), after: described(z.any(), "Later OpenAPI JSON document."), idempotency_key: described(z.string().min(8).max(128), "Stable key used to make a paid retry idempotent.") } }, async ({ before, after, idempotency_key }, extra) => {
    return withToolStats(stats, "diff_openapi", () => paidMcpCall(paidTools, diffDefinition, { before, after }, idempotency_key, extra._meta?.["x402/payment"], () => Promise.resolve(diffOpenApi(before, after))), usdToSixDecimals(diffDefinition.priceUsd));
  });

  registerChainMcpTool(server, paidTools, stats, prices.chainPriceUsd ?? "0.001", "get_chain_balance", "Read a native Base balance.", { address: z.string(), network: z.string().optional(), block: z.union([z.string(), z.number()]).optional(), idempotency_key: z.string().min(8).max(128) }, "balance");
  registerChainMcpTool(server, paidTools, stats, prices.chainPriceUsd ?? "0.001", "get_chain_transaction", "Read a Base transaction and receipt.", { tx_hash: z.string(), network: z.string().optional(), idempotency_key: z.string().min(8).max(128) }, "transaction");
  registerChainMcpTool(server, paidTools, stats, prices.chainPriceUsd ?? "0.001", "get_erc20_balance", "Read one ERC-20 balance on Base.", { token: z.string(), address: z.string(), network: z.string().optional(), block: z.union([z.string(), z.number()]).optional(), idempotency_key: z.string().min(8).max(128) }, "erc20-balance");
}

function registerChainMcpTool(server: McpServer, paidTools: PaidToolService, stats: ToolStatsStore | undefined, priceUsd: string, name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, kind: "balance" | "transaction" | "erc20-balance"): void {
  const common = { network: { type: "string", enum: ["eip155:8453", "eip155:84532"] }, idempotency_key: { type: "string", minLength: 8, maxLength: 128 } };
  const schema = kind === "transaction"
    ? { type: "object", required: ["tx_hash", "idempotency_key"], additionalProperties: false, properties: { tx_hash: { type: "string", minLength: 1 }, ...common } }
    : kind === "erc20-balance"
      ? { type: "object", required: ["token", "address", "idempotency_key"], additionalProperties: false, properties: { token: { type: "string", minLength: 1 }, address: { type: "string", minLength: 1 }, block: { anyOf: [{ type: "string" }, { type: "number" }] }, ...common } }
      : { type: "object", required: ["address", "idempotency_key"], additionalProperties: false, properties: { address: { type: "string", minLength: 1 }, block: { anyOf: [{ type: "string" }, { type: "number" }] }, ...common } };
  const definition: PaidToolDefinition = { name, resourcePath: "/mcp", priceUsd, description, inputSchema: schema, example: kind === "transaction" ? { network: "eip155:8453", tx_hash: EXAMPLE_TX_HASH, idempotency_key: `${name}-0001` } : kind === "erc20-balance" ? { network: "eip155:8453", token: EXAMPLE_USDC, address: EXAMPLE_ADDRESS, idempotency_key: `${name}-0001` } : { network: "eip155:8453", address: EXAMPLE_ADDRESS, idempotency_key: `${name}-0001` }, outputExample: { network: "eip155:8453", observedAt: "2026-01-01T00:00:00.000Z" } };
  server.registerTool(name, { title: name, description, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, outputSchema: kind === "balance" ? chainBalanceOutputSchema : kind === "transaction" ? chainTransactionOutputSchema : erc20BalanceOutputSchema, inputSchema: describeChainInput(inputSchema, kind) }, async (args: Record<string, unknown>, extra) => withToolStats(stats, name, () => { const { idempotency_key, ...input } = args; return paidMcpCall(paidTools, definition, input, String(idempotency_key), extra._meta?.["x402/payment"], () => readChainBalance(input as never, kind)); }, usdToSixDecimals(priceUsd)));
}

function describeChainInput(inputSchema: Record<string, z.ZodTypeAny>, kind: "balance" | "transaction" | "erc20-balance"): Record<string, z.ZodTypeAny> {
  const descriptions: Record<string, string> = {
    network: "CAIP-2 network identifier; use eip155:8453 for Base mainnet or eip155:84532 for Base Sepolia.",
    address: kind === "erc20-balance" ? "EVM wallet address whose token balance should be read." : "EVM wallet address whose native balance should be read.",
    token: "ERC-20 contract address on the selected Base network.",
    tx_hash: "Transaction hash to inspect on the selected Base network.",
    block: "Optional block number or block tag such as latest.",
    idempotency_key: "Stable key used to make a paid retry idempotent.",
  };
  for (const [key, description] of Object.entries(descriptions)) {
    const schema = inputSchema[key];
    if (schema) inputSchema[key] = described(schema, description);
  }
  return inputSchema;
}

async function paidMcpCall<T>(paidTools: PaidToolService, definition: PaidToolDefinition, input: unknown, idempotencyKey: string, payment: unknown, handler: () => Promise<T>): Promise<CallToolResult> {
  const outcome = await paidTools.execute(definition, input, idempotencyKey, asPaymentPayload(payment), handler);
  if (outcome.kind === "payment_required") return paymentRequiredResult(outcome.paymentRequired);
  if (outcome.kind === "error") return serviceErrorResult(outcome.code, outcome.message, outcome.details);
  const meta: Record<string, unknown> = {};
  if (outcome.settlement) meta["x402/payment-response"] = outcome.settlement;
  if (outcome.resumed) meta["x402/resumed"] = true;
  return { content: [{ type: "text", text: JSON.stringify(outcome.value) }], structuredContent: outcome.value as Record<string, unknown>, ...(Object.keys(meta).length ? { _meta: meta } : {}) };
}

async function inspectDiscoveryMethod(request: Request): Promise<"initialize" | "tools/list" | null> {
  if (request.method !== "POST" || !request.body) return null;
  try {
    const length = request.headers.get("content-length");
    if (length && /^\d+$/.test(length) && Number(length) > MAX_REQUEST_BYTES) return null;
    const reader = request.clone().body!.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_REQUEST_BYTES) {
          // A cloned stream is a tee: awaiting cancellation can wait for the original consumer.
          void reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { method?: unknown };
    return value.method === "initialize" || value.method === "tools/list" ? value.method : null;
  } catch { return null; }
}

function isPaymentRequiredResult(result: CallToolResult): boolean {
  const value = result.structuredContent;
  return !!value && typeof value === "object" && !Array.isArray(value) && "x402Version" in value && "accepts" in value;
}

async function documentToolResult(operation: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const result = await operation();
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) { return documentToolError(error); }
}

function documentToolError(error: unknown): CallToolResult {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "document_operation_failed";
  const message = error instanceof Error ? error.message : "The PDF document operation failed.";
  return serviceErrorResult(code, message);
}

function asPaymentPayload(value: unknown): PaymentPayloadV2 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as PaymentPayloadV2;
}

function paymentRequiredResult(paymentRequired: Record<string, unknown>): CallToolResult {
  return {
    isError: true,
    structuredContent: paymentRequired,
    content: [{ type: "text", text: JSON.stringify(paymentRequired) }],
  };
}

function serviceErrorResult(code: string, message: string, details?: unknown): CallToolResult {
  const result = { error: { code, message }, ...(details !== undefined ? { details } : {}) };
  return { isError: true, structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
}
