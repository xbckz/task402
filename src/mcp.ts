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

  const server = new McpServer({ name: "x402-pdf", version: "0.3.0" });
  server.registerTool("generate_pdf", {
    title: "Generate PDF",
    description: "Create a professionally formatted, paginated PDF from Markdown. Returns a short-lived download capability.",
    annotations: { idempotentHint: true, destructiveHint: false },
    inputSchema: {
      title: z.string().min(1).max(160),
      markdown: z.string().min(1).max(240 * 1024),
      idempotency_key: z.string().min(8).max(128),
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
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      job_id: z.string().uuid(),
      capability: z.string().min(40).max(64),
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
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: { document_id: z.string().uuid(), capability: z.string().min(40).max(64) },
    }, async ({ document_id, capability }) => withToolStats(stats, "inspect_pdf", () => documentToolResult(() => documents.inspect(document_id, capability))));

    server.registerTool("get_document_map", {
      title: "Get PDF page map",
      description: "Return page labels, sizes, native-text previews, bookmarks, and sparse-text warnings. Set page to include up to 500 positioned text blocks for that page.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: { document_id: z.string().uuid(), capability: z.string().min(40).max(64), page: z.number().int().min(1).max(100).optional() },
    }, async ({ document_id, capability, page }) => withToolStats(stats, "get_document_map", () => documentToolResult(() => documents.getMap(document_id, capability, page))));

    server.registerTool("search_document", {
      title: "Search PDF text",
      description: "Find exact normalized text matches in native PDF text (no OCR). Results and excerpts are bounded.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        document_id: z.string().uuid(), capability: z.string().min(40).max(64), query: z.string().min(1).max(200),
        page: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(20).optional(),
      },
    }, async ({ document_id, capability, query, page, limit }) => withToolStats(stats, "search_document", () => documentToolResult(() => documents.search(document_id, capability, query, { ...(page !== undefined ? { page } : {}), ...(limit !== undefined ? { limit } : {}) }))));

    server.registerTool("batch_search_document", {
      title: "Batch search PDF text",
      description: "Search up to 20 exact normalized-text queries in one bounded call. Useful when an agent needs several clauses or fields from one PDF.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: { document_id: z.string().uuid(), capability: z.string().min(40).max(64), queries: z.array(z.string().min(1).max(200)).min(1).max(20), page: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(20).optional() },
    }, async ({ document_id, capability, queries, page, limit }) => withToolStats(stats, "batch_search_document", () => documentToolResult(() => documents.batchSearch(document_id, capability, queries, { ...(page !== undefined ? { page } : {}), ...(limit !== undefined ? { limit } : {}) }))));

    server.registerTool("prepare_document_context", {
      title: "Prepare cited PDF context",
      description: "Rank native-text pages for a question and return a bounded context pack with page, block, and excerpt evidence. No model call or OCR is used.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: { document_id: z.string().uuid(), capability: z.string().min(40).max(64), query: z.string().min(1).max(200), max_chars: z.number().int().min(1000).max(32000).optional(), pages: z.array(z.number().int().min(1).max(100)).max(100).optional() },
    }, async ({ document_id, capability, query, max_chars, pages }) => withToolStats(stats, "prepare_document_context", () => documentToolResult(() => documents.prepareContext(document_id, capability, query, max_chars, pages))));

    server.registerTool("extract_document_fields", {
      title: "Extract labeled PDF fields",
      description: "Extract caller-supplied literal labels and adjacent native-text values with page and block evidence. Missing labels return null; no semantic extraction or OCR is performed.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: { document_id: z.string().uuid(), capability: z.string().min(40).max(64), fields: z.array(z.object({ name: z.string().min(1).max(80), label: z.string().min(1).max(160), page: z.number().int().min(1).max(100).optional() })).min(1).max(20) },
    }, async ({ document_id, capability, fields }) => withToolStats(stats, "extract_document_fields", () => documentToolResult(() => documents.extractFields(document_id, capability, fields))));

    server.registerTool("read_document", {
      title: "Read PDF pages",
      description: "Read extractable native text from up to 10 selected pages. Output is limited to 32,000 characters; scanned pages need OCR, which is not provided.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: { document_id: z.string().uuid(), capability: z.string().min(40).max(64), pages: z.array(z.number().int().min(1)).min(1).max(10) },
    }, async ({ document_id, capability, pages }) => withToolStats(stats, "read_document", () => documentToolResult(() => documents.read(document_id, capability, pages))));

    server.registerTool("verify_document_citation", {
      title: "Verify PDF text citation",
      description: "Check that a quote of 5 to 500 characters appears on the stated page in extracted native text. This does not establish truth or visual reading order.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: { document_id: z.string().uuid(), capability: z.string().min(40).max(64), page: z.number().int().min(1), quote: z.string().min(5).max(500) },
    }, async ({ document_id, capability, page, quote }) => withToolStats(stats, "verify_document_citation", () => documentToolResult(() => documents.verifyCitation(document_id, capability, page, quote))));

    server.registerTool("compare_pdfs", {
      title: "Compare PDFs",
      description: "Compare page count and normalized native text between two separately authorized uploaded PDFs. Image-only and visual differences are not compared.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        left_document_id: z.string().uuid(), left_capability: z.string().min(40).max(64),
        right_document_id: z.string().uuid(), right_capability: z.string().min(40).max(64),
      },
    }, async ({ left_document_id, left_capability, right_document_id, right_capability }) => withToolStats(stats, "compare_pdfs", () => documentToolResult(() => documents.compare(left_document_id, left_capability, right_document_id, right_capability))));

    server.registerTool("validate_pdf_text", {
      title: "Validate PDF text expectations",
      description: "Check that the PDF parses, has an optional expected page count, and contains required text. This does not perform PDF/A, signature, visual, or OCR validation.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        document_id: z.string().uuid(), capability: z.string().min(40).max(64),
        page_count: z.number().int().min(1).max(100).optional(), required_text: z.array(z.string().min(1).max(500)).max(20).optional(),
      },
    }, async ({ document_id, capability, page_count, required_text }) => withToolStats(stats, "validate_pdf_text", () => documentToolResult(() => documents.validate(document_id, capability, { ...(page_count !== undefined ? { pageCount: page_count } : {}), ...(required_text !== undefined ? { requiredText: required_text } : {}) }))));

    server.registerTool("render_pdf_page_region", {
      title: "Render PDF page region",
      description: "Render one authorized PDF page crop as PNG. x/y/width/height are normalized 0-1 page fractions; output is bounded to four million pixels.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        document_id: z.string().uuid(), capability: z.string().min(40).max(64), page: z.number().int().min(1),
        x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.001).max(1), height: z.number().min(0.001).max(1), scale: z.number().min(0.5).max(3).optional(),
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
  server.registerTool("web_evidence", { title: "Web evidence", description: webDefinition.description, annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { url: z.string().url().max(2048), query: z.string().max(200).optional(), max_chars: z.number().int().min(2000).max(24000).optional(), idempotency_key: z.string().min(8).max(128) } }, async ({ url, query, max_chars, idempotency_key }, extra) => {
    const input = { url, ...(query !== undefined ? { query } : {}), ...(max_chars !== undefined ? { max_chars } : {}) };
    return withToolStats(stats, "web_evidence", () => paidMcpCall(paidTools, webDefinition, input, idempotency_key, extra._meta?.["x402/payment"], () => fetchWebEvidence(input, prices.webFetch ?? fetch, prices.webHostResolver)), usdToSixDecimals(webDefinition.priceUsd));
  });

  const inspectDefinition: PaidToolDefinition = { name: "inspect_openapi", resourcePath: "/mcp", priceUsd: prices.openApiPriceUsd ?? "0.001", description: "Inspect a caller-supplied OpenAPI JSON document without fetching remote references.", inputSchema: { type: "object", required: ["spec", "idempotency_key"], additionalProperties: false, properties: { spec: {}, idempotency_key: { type: "string", minLength: 8, maxLength: 128 } } }, example: { spec: { openapi: "3.1.0", info: { title: "Example", version: "1" }, paths: {} }, idempotency_key: "openapi-inspect-0001" }, outputExample: { operations: [] } };
  server.registerTool("inspect_openapi", { title: "Inspect OpenAPI", description: inspectDefinition.description, annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { spec: z.any(), idempotency_key: z.string().min(8).max(128) } }, async ({ spec, idempotency_key }, extra) => {
    return withToolStats(stats, "inspect_openapi", () => paidMcpCall(paidTools, inspectDefinition, { spec }, idempotency_key, extra._meta?.["x402/payment"], () => Promise.resolve(inspectOpenApi(spec))), usdToSixDecimals(inspectDefinition.priceUsd));
  });

  const planDefinition: PaidToolDefinition = { name: "plan_api_request", resourcePath: "/mcp", priceUsd: "0.002", description: "Select an OpenAPI operation and generate a safe request plan without executing it.", inputSchema: { type: "object", required: ["spec", "idempotency_key"], additionalProperties: false, properties: { spec: {}, operation_id: { type: "string" }, path: { type: "string" }, method: { type: "string" }, idempotency_key: { type: "string", minLength: 8, maxLength: 128 } } }, example: { spec: { openapi: "3.1.0", info: { title: "Example API", version: "1" }, servers: [{ url: "https://api.example.com" }], paths: { "/users/{id}": { get: { operationId: "getUser", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK" } } } } } }, operation_id: "getUser", idempotency_key: "openapi-plan-0001" }, outputExample: { request: { method: "GET", url: "https://api.example.com/users/{id}" } } };
  server.registerTool("plan_api_request", { title: "Plan API request", description: planDefinition.description, annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { spec: z.any(), operation_id: z.string().optional(), path: z.string().optional(), method: z.string().optional(), idempotency_key: z.string().min(8).max(128) } }, async ({ spec, operation_id, path, method, idempotency_key }, extra) => {
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
  server.registerTool("diff_openapi", { title: "Diff OpenAPI", description: diffDefinition.description, annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { before: z.any(), after: z.any(), idempotency_key: z.string().min(8).max(128) } }, async ({ before, after, idempotency_key }, extra) => {
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
  server.registerTool(name, { title: name, description, annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema }, async (args: Record<string, unknown>, extra) => withToolStats(stats, name, () => { const { idempotency_key, ...input } = args; return paidMcpCall(paidTools, definition, input, String(idempotency_key), extra._meta?.["x402/payment"], () => readChainBalance(input as never, kind)); }, usdToSixDecimals(priceUsd)));
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
