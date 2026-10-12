import { buildPaymentRequired, usdToSixDecimals } from "./payments.js";
import { handleMcpRequest } from "./mcp.js";
import { MAX_REQUEST_BYTES, InputError, isValidCapability, payloadSemanticKey, paymentPayloadFingerprint } from "./security.js";
import { validatePaymentPayload, type PdfService } from "./service.js";
import type { PaymentPayloadV2, PaymentRequirements } from "./types.js";
import type { PdfDocumentService } from "./pdf-documents.js";
import { MAX_DOCUMENT_BYTES, DocumentError } from "./document-constants.js";
import type { ToolStatsStore } from "./types.js";
import { isStatsPasswordValid } from "./security.js";
import { agentDocsPage, aiPluginJson, demoPage, llmsText, overviewPage, pricingPage, robotsTxt, sitemapXml, useCasePage } from "./public-pages.js";
import { TASK402_BACKGROUND_SVG, TASK402_LOGO_SVG } from "./brand.js";
import { TASK402_BACKGROUND_WEBP_BASE64 } from "./task402-bg.js";
import { fetchWebEvidence, inspectOpenApi, planOpenApiRequest, diffOpenApi, readChainBalance, type PublicHostResolver } from "./agent-tools.js";
import type { PaidToolService } from "./paid-tools.js";

const EXAMPLE_ADDRESS = "0xAEA6fDF13ca10aD6B906884ffAcBb58a0e9E144A";
const EXAMPLE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const EXAMPLE_TX_HASH = "0x6a20a573804c89b1bf0104ac23ea9bbcd5bcfad53d8f0fd1ead2edbe40209c3f";

export interface ApiRuntime {
  service: PdfService;
  priceUsd: string;
  documentPriceUsd?: string;
  paymentMode: string;
  allowedMcpOrigins: Set<string>;
  documents?: PdfDocumentService;
  documentRuntime?: "node-local" | "cloudflare-container" | "unavailable";
  documentTtlSeconds?: number;
  stats?: ToolStatsStore;
  statsPassword?: string;
  paidTools?: PaidToolService;
  webEvidencePriceUsd?: string;
  openApiPriceUsd?: string;
  chainPriceUsd?: string;
  webHostResolver?: PublicHostResolver;
  webFetch?: typeof fetch;
}

export async function handleRequest(request: Request, runtime: ApiRuntime): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (path === "/v1/admin/stats" && request.method === "GET") return handleStatsRequest(request, url, runtime);
  const tool = classifyTool(path, request.method);
  const startedAt = Date.now();
  const response = await handleRequestInner(request, runtime, url, path);
  await recordTrafficStats(runtime.stats, path, request.method, response);
  if (tool) {
    const configuredAmount = tool === "ingest_document"
      ? (() => { try { return usdToSixDecimals(runtime.documentPriceUsd ?? "0.01"); } catch { return undefined; } })()
      : tool === "web_evidence"
        ? (() => { try { return usdToSixDecimals(runtime.webEvidencePriceUsd ?? "0.005"); } catch { return undefined; } })()
        : tool === "inspect_openapi"
          ? (() => { try { return usdToSixDecimals(runtime.openApiPriceUsd ?? "0.001"); } catch { return undefined; } })()
          : tool === "plan_api_request" || tool === "diff_openapi"
            ? (() => { try { return usdToSixDecimals(tool === "plan_api_request" ? "0.002" : "0.002"); } catch { return undefined; } })()
            : tool === "get_chain_balance" || tool === "get_chain_transaction" || tool === "get_erc20_balance"
              ? (() => { try { return usdToSixDecimals(runtime.chainPriceUsd ?? "0.001"); } catch { return undefined; } })()
      : runtime.service.config.payment.requirements?.amount;
    await recordResponseStats(runtime.stats, tool, startedAt, response, configuredAmount);
  }
  return response;
}

async function handleRequestInner(request: Request, runtime: ApiRuntime, url: URL, path: string): Promise<Response> {

  if (path === "/favicon.svg" && request.method === "GET") {
    return new Response(TASK402_LOGO_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
  }
  if (path === "/task402-bg.svg" && request.method === "GET") {
    return new Response(TASK402_BACKGROUND_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
  }
  if (path === "/task402-bg.webp" && request.method === "GET") {
    return new Response(base64Bytes(TASK402_BACKGROUND_WEBP_BASE64).buffer as ArrayBuffer, { headers: { "content-type": "image/webp", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
  }
  if (path === "/healthz" && request.method === "GET") {
    return json({ ok: true, service: "x402-pdf", payments: runtime.service.config.payment.mode });
  }
  if (path === "/admin" && request.method === "GET") return adminDashboard();
  if (path === "/" && request.method === "GET") return overviewPage({ baseUrl: runtime.service.config.publicBaseUrl, priceUsd: runtime.priceUsd, documentPriceUsd: runtime.documentPriceUsd ?? "0.01", paymentMode: runtime.paymentMode, documentRuntime: runtime.documentRuntime ?? "unavailable", documentTtlSeconds: runtime.documentTtlSeconds, network: runtime.service.config.payment.requirements?.network, asset: runtime.service.config.payment.requirements?.asset, webEvidencePriceUsd: runtime.webEvidencePriceUsd, openApiPriceUsd: runtime.openApiPriceUsd, chainPriceUsd: runtime.chainPriceUsd });
  if (path === "/docs" && request.method === "GET") return agentDocsPage({ baseUrl: runtime.service.config.publicBaseUrl, priceUsd: runtime.priceUsd, documentPriceUsd: runtime.documentPriceUsd ?? "0.01", paymentMode: runtime.paymentMode, documentRuntime: runtime.documentRuntime ?? "unavailable", webEvidencePriceUsd: runtime.webEvidencePriceUsd, openApiPriceUsd: runtime.openApiPriceUsd, chainPriceUsd: runtime.chainPriceUsd });
  if (path === "/pricing" && request.method === "GET") return pricingPage({ baseUrl: runtime.service.config.publicBaseUrl, priceUsd: runtime.priceUsd, documentPriceUsd: runtime.documentPriceUsd ?? "0.01", paymentMode: runtime.paymentMode, documentRuntime: runtime.documentRuntime ?? "unavailable", documentTtlSeconds: runtime.documentTtlSeconds, webEvidencePriceUsd: runtime.webEvidencePriceUsd, openApiPriceUsd: runtime.openApiPriceUsd, chainPriceUsd: runtime.chainPriceUsd });
  if (path === "/demo" && request.method === "GET") return demoPage({ baseUrl: runtime.service.config.publicBaseUrl, priceUsd: runtime.priceUsd, documentPriceUsd: runtime.documentPriceUsd ?? "0.01", paymentMode: runtime.paymentMode, documentRuntime: runtime.documentRuntime ?? "unavailable", webEvidencePriceUsd: runtime.webEvidencePriceUsd, openApiPriceUsd: runtime.openApiPriceUsd, chainPriceUsd: runtime.chainPriceUsd });
  const useCase = /^\/docs\/(citation-verification|compare-pdfs|reduce-pdf-context)$/.exec(path)?.[1];
  if (useCase && request.method === "GET") return useCasePage({ baseUrl: runtime.service.config.publicBaseUrl, priceUsd: runtime.priceUsd, documentPriceUsd: runtime.documentPriceUsd ?? "0.01", paymentMode: runtime.paymentMode, documentRuntime: runtime.documentRuntime ?? "unavailable", webEvidencePriceUsd: runtime.webEvidencePriceUsd, openApiPriceUsd: runtime.openApiPriceUsd, chainPriceUsd: runtime.chainPriceUsd }, useCase as Parameters<typeof useCasePage>[1]);
  if (path === "/llms.txt" && request.method === "GET") return llmsText({ baseUrl: runtime.service.config.publicBaseUrl, priceUsd: runtime.priceUsd, documentPriceUsd: runtime.documentPriceUsd ?? "0.01", paymentMode: runtime.paymentMode, documentRuntime: runtime.documentRuntime ?? "unavailable", documentTtlSeconds: runtime.documentTtlSeconds, network: runtime.service.config.payment.requirements?.network, asset: runtime.service.config.payment.requirements?.asset, webEvidencePriceUsd: runtime.webEvidencePriceUsd, openApiPriceUsd: runtime.openApiPriceUsd, chainPriceUsd: runtime.chainPriceUsd });
  if (path === "/server.json" && request.method === "GET") return json(serverManifest(runtime));
  if (path === "/.well-known/ai-plugin.json" && request.method === "GET") return aiPluginJson(runtime.service.config.publicBaseUrl);
  if (path === "/.well-known/mcp/server-card.json" && request.method === "GET") return json(mcpServerCard(runtime));
  if (path === "/robots.txt" && request.method === "GET") return robotsTxt(runtime.service.config.publicBaseUrl);
  if (path === "/sitemap.xml" && request.method === "GET") return sitemapXml(runtime.service.config.publicBaseUrl);
  if ((path === "/v1/pricing" || path === "/.well-known/x402" || path === "/.well-known/x402.json") && request.method === "GET") {
    return json(pricingDocument(runtime));
  }
  if (path === "/v1/tools" && request.method === "GET") return json(toolCatalog(runtime));
  if (path === "/openapi.json" && request.method === "GET") return json(openApiDocument(runtime));
  if (request.method === "POST" && path === "/v1/web/evidence") return webEvidence(request, runtime);
  if (request.method === "POST" && path === "/v1/openapi/inspect") return openApiInspect(request, runtime);
  if (request.method === "POST" && path === "/v1/openapi/request-plan") return openApiRequestPlan(request, runtime);
  if (request.method === "POST" && path === "/v1/openapi/diff") return openApiDiff(request, runtime);
  if (request.method === "POST" && path === "/v1/chain/balance") return chainTool(request, runtime, "balance");
  if (request.method === "POST" && path === "/v1/chain/transaction") return chainTool(request, runtime, "transaction");
  if (request.method === "POST" && path === "/v1/chain/erc20-balance") return chainTool(request, runtime, "erc20-balance");
  if (path === "/mcp") return handleMcpRequest(request, runtime.service, runtime.allowedMcpOrigins, runtime.documents, runtime.stats, runtime.paidTools, { ...(runtime.webEvidencePriceUsd ? { webEvidencePriceUsd: runtime.webEvidencePriceUsd } : {}), ...(runtime.openApiPriceUsd ? { openApiPriceUsd: runtime.openApiPriceUsd } : {}), ...(runtime.chainPriceUsd ? { chainPriceUsd: runtime.chainPriceUsd } : {}), ...(runtime.webHostResolver ? { webHostResolver: runtime.webHostResolver } : {}), ...(runtime.webFetch ? { webFetch: runtime.webFetch } : {}) });
  if (path === "/v1/documents" && request.method === "POST") {
    if (!runtime.documents) return documentRuntimeUnavailable();
    return ingestDocument(request, runtime);
  }
  if (path.startsWith("/v1/documents/")) {
    if (!runtime.documents) return documentRuntimeUnavailable();
    return handleDocumentOperation(request, path, url, runtime.documents);
  }
  if (path === "/v1/pdf" && request.method === "POST") return createPdf(request, runtime);

  const jobMatch = /^\/v1\/jobs\/([0-9a-f-]{36})(\/download)?$/i.exec(path);
  if (jobMatch && request.method === "GET") {
    const capability = readCapability(request.headers.get("authorization"), request.headers.get("x-job-capability"));
    if (!capability || !isValidCapability(capability)) return notFound();
    const id = jobMatch[1]!;
    if (jobMatch[2]) return downloadPdf(runtime.service, id, capability);
    const row = await runtime.service.getJob(id, capability);
    if (!row) return notFound();
    return json({
      jobId: row.id,
      state: row.state,
      title: row.title,
      createdAt: new Date(row.createdAt).toISOString(),
      expiresAt: new Date(row.expiresAt).toISOString(),
      ...runtime.service.jobUrls(row.id),
      ...(row.artifactBytes !== null ? { artifactBytes: row.artifactBytes } : {}),
      ...(row.errorCode ? { errorCode: row.errorCode } : {}),
      ...(row.settlement ? { settlement: row.settlement } : {}),
    });
  }

  return json({ error: { code: "not_found", message: "Endpoint not found." } }, 404);
}

async function handleStatsRequest(request: Request, url: URL, runtime: ApiRuntime): Promise<Response> {
  if (!runtime.stats || !runtime.statsPassword) return json({ error: { code: "stats_unconfigured", message: "Operator stats are not configured." } }, 503);
  const password = readStatsPassword(request);
  if (!password || !isStatsPasswordValid(password, runtime.statsPassword)) {
    return json({ error: { code: "stats_unauthorized", message: "A valid operator password is required." } }, 401, { "www-authenticate": "Bearer realm=stats" });
  }
  const hoursRaw = url.searchParams.get("hours");
  let since: number | undefined;
  if (hoursRaw !== null) {
    const hours = Number(hoursRaw);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 365) return json({ error: { code: "invalid_stats_window", message: "hours must be an integer from 1 to 8760." } }, 400);
    since = Date.now() - hours * 60 * 60 * 1000;
  }
  try { return json(await runtime.stats.summarize(since)); }
  catch { return json({ error: { code: "stats_unavailable", message: "Operator stats could not be read." } }, 503); }
}

function readStatsPassword(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const header = request.headers.get("x-stats-password");
  const value = authorization ?? header;
  return value && value.length <= 256 ? value : null;
}

function classifyTool(path: string, method: string): string | null {
  if (path === "/mcp") return null;
  if (method === "POST" && path === "/v1/web/evidence") return "web_evidence";
  if (method === "POST" && path === "/v1/openapi/inspect") return "inspect_openapi";
  if (method === "POST" && path === "/v1/openapi/request-plan") return "plan_api_request";
  if (method === "POST" && path === "/v1/openapi/diff") return "diff_openapi";
  if (method === "POST" && path === "/v1/chain/balance") return "get_chain_balance";
  if (method === "POST" && path === "/v1/chain/transaction") return "get_chain_transaction";
  if (method === "POST" && path === "/v1/chain/erc20-balance") return "get_erc20_balance";
  if (path === "/v1/pdf" && method === "POST") return "generate_pdf";
  if (path === "/v1/documents" && method === "POST") return "ingest_document";
  if (path === "/v1/documents/compare" && method === "POST") return "compare_pdfs";
  const documentMatch = /^\/v1\/documents\/[0-9a-f-]{36}(?:\/(map|search|batch-search|context|fields|read|citation|validate|pages\/\d+\/render))?$/i.exec(path);
  if (documentMatch) {
    const operation = documentMatch[1];
    if (!operation && method === "GET") return "inspect_pdf";
    if (operation === "map" && method === "GET") return "get_document_map";
    if (operation === "search" && method === "POST") return "search_document";
    if (operation === "batch-search" && method === "POST") return "batch_search_document";
    if (operation === "context" && method === "POST") return "prepare_document_context";
    if (operation === "fields" && method === "POST") return "extract_document_fields";
    if (operation === "read" && method === "POST") return "read_document";
    if (operation === "citation" && method === "POST") return "verify_document_citation";
    if (operation === "validate" && method === "POST") return "validate_pdf_text";
    if (operation?.startsWith("pages/") && method === "GET") return "render_pdf_page_region";
  }
  const jobMatch = /^\/v1\/jobs\/[0-9a-f-]{36}(\/download)?$/i.exec(path);
  if (jobMatch && method === "GET") return jobMatch[1] ? "download_pdf" : "get_pdf_job";
  return null;
}

async function recordTrafficStats(stats: ToolStatsStore | undefined, path: string, method: string, response: Response): Promise<void> {
  if (!stats?.recordTraffic || response.status >= 400) {
    if (stats?.recordTraffic && path === "/v1/pdf" && method === "POST" && response.status === 402) await stats.recordTraffic({ event: "generation_payment_challenge" }).catch(() => undefined);
    else if (stats?.recordTraffic && response.status === 402 && method === "POST" && /^\/v1\/(web\/evidence|openapi\/(inspect|request-plan|diff)|chain\/(balance|transaction|erc20-balance))$/.test(path)) await stats.recordTraffic({ event: "paid_tool_payment_challenge" }).catch(() => undefined);
    return;
  }
  let event: Parameters<NonNullable<ToolStatsStore["recordTraffic"]>>[0]["event"] | undefined;
  if (path === "/" && method === "GET") event = "overview_request";
  else if ((path === "/docs" || path.startsWith("/docs/")) && method === "GET") event = "docs_request";
  else if ((path === "/v1/pricing" || path === "/.well-known/x402" || path === "/.well-known/x402.json") && method === "GET") event = "pricing_request";
  else if (path === "/v1/pdf" && method === "POST" && response.status < 300) {
    // Resumed calls remain product calls; a recovered artifact is not a new completion.
    try { if (!(await response.clone().json() as { resumed?: boolean }).resumed) event = "generation_completed"; }
    catch { /* An unrecognized result is not a completion. */ }
  }
  else if (path === "/v1/documents" && method === "POST") event = response.status === 200 ? "document_ingest_resumed" : response.status === 201 ? "document_ingest_completed" : undefined;
  else if (/^\/v1\/jobs\/[0-9a-f-]{36}\/download$/i.test(path) && method === "GET") event = "download_completed";
  else if (method === "POST" && /^\/v1\/(web\/evidence|openapi\/(inspect|request-plan|diff)|chain\/(balance|transaction|erc20-balance))$/.test(path)) event = "paid_tool_completed";
  else if (/^\/v1\/documents\//.test(path) && response.status < 300) event = "document_tool_completed";
  if (event) await stats.recordTraffic({ event }).catch(() => undefined);
}

async function recordResponseStats(stats: ToolStatsStore | undefined, tool: string, startedAt: number, response: Response, configuredAmount?: string): Promise<void> {
  if (!stats) return;
  let settledAmountAtomic: string | undefined;
  if (response.status < 300) {
    try {
      const body = await response.clone().json() as { resumed?: boolean; settlement?: { amount?: string } };
      const amount = body.resumed ? undefined : body.settlement?.amount ?? configuredAmount;
      if (typeof amount === "string" && /^\d+$/.test(amount)) settledAmountAtomic = amount;
    } catch { /* response may not be JSON */ }
  }
  await stats.record({ tool, status: response.status, outcome: response.status === 402 ? "payment_required" : response.status >= 400 ? "error" : "success", durationMs: Date.now() - startedAt, ...(settledAmountAtomic ? { settledAmountAtomic } : {}) }).catch(() => undefined);
}

async function createPdf(request: Request, runtime: ApiRuntime): Promise<Response> {
  let input: unknown;
  try {
    input = await readJsonLimited(request);
  } catch (error) {
    if (error instanceof InputError) return json({ error: { code: error.code, message: error.message } }, error.status);
    return json({ error: { code: "invalid_json", message: "Request body must be valid JSON." } }, 400);
  }

  let payment: PaymentPayloadV2 | null = null;
  const paymentHeader = request.headers.get("payment-signature");
  if (paymentHeader) {
    try {
      payment = decodePaymentPayload(paymentHeader);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Payment payload is malformed.";
      const resourceUrl = runtime.service.config.payment.resourceUrl ?? `${runtime.service.config.publicBaseUrl}/v1/pdf`;
      return paymentRequiredResponse(runtime, resourceUrl, message);
    }
  }

  const resourceUrl = runtime.service.config.payment.resourceUrl ?? `${runtime.service.config.publicBaseUrl}/v1/pdf`;
  const outcome = await runtime.service.create(input, request.headers.get("idempotency-key"), payment, resourceUrl);
  if (outcome.kind === "payment_required") return paymentRequiredResponse(runtime, resourceUrl, String(outcome.paymentRequired.error ?? ""), outcome.paymentRequired);
  if (outcome.kind === "error") {
    const details = outcome.error.details;
    return json({ error: { code: outcome.error.code, message: outcome.error.message }, ...(details !== undefined ? { details } : {}) }, outcome.error.status);
  }

  const settlement = outcome.job.settlement;
  return json(outcome.job, outcome.job.resumed ? 200 : 201, settlement ? {
    "payment-response": base64Json(settlement),
  } : undefined);
}

async function webEvidence(request: Request, runtime: ApiRuntime): Promise<Response> {
  const input = await readToolJson(request);
  if (input instanceof Response) return input;
  return executePaidTool(request, runtime, {
    name: "web_evidence", resourcePath: "/v1/web/evidence", priceUsd: runtime.webEvidencePriceUsd ?? "0.005", description: "Fetch a public HTTPS page and return bounded citation-ready evidence.",
    inputSchema: { type: "object", required: ["url"], additionalProperties: false, properties: { url: { type: "string", format: "uri", maxLength: 2048 }, query: { type: "string", maxLength: 200 }, max_chars: { type: "integer", minimum: 2000, maximum: 24000 } } },
    example: { url: "https://example.com/", query: "Example Domain", max_chars: 4000 }, outputExample: { finalUrl: "https://example.com/", text: "...", sourceHash: "sha256" },
  }, input, () => fetchWebEvidence(input as { url: string; query?: string; max_chars?: number }, runtime.webFetch ?? fetch, runtime.webHostResolver));
}

async function openApiInspect(request: Request, runtime: ApiRuntime): Promise<Response> {
  const input = await readToolJson(request);
  if (input instanceof Response) return input;
  const record = asObject(input);
  if (!record || !("spec" in record)) return json({ error: { code: "spec_required", message: "Send a JSON object with a spec field." } }, 400);
  return executePaidTool(request, runtime, { name: "inspect_openapi", resourcePath: "/v1/openapi/inspect", priceUsd: runtime.openApiPriceUsd ?? "0.001", description: "Inspect a caller-supplied OpenAPI JSON document without fetching remote references.", inputSchema: { type: "object", required: ["spec"], properties: { spec: {} } }, example: { spec: { openapi: "3.1.0", info: { title: "Example", version: "1" }, paths: {} } }, outputExample: { operations: [] } }, input, () => Promise.resolve(inspectOpenApi(record.spec)));
}

async function openApiRequestPlan(request: Request, runtime: ApiRuntime): Promise<Response> {
  const input = await readToolJson(request);
  if (input instanceof Response) return input;
  const record = asObject(input);
  if (!record || !("spec" in record)) return json({ error: { code: "spec_required", message: "Send a JSON object with a spec field." } }, 400);
  return executePaidTool(request, runtime, { name: "plan_api_request", resourcePath: "/v1/openapi/request-plan", priceUsd: "0.002", description: "Select an OpenAPI operation and generate a safe request plan without executing it.", inputSchema: { type: "object", required: ["spec"], properties: { spec: {}, operation_id: { type: "string" }, path: { type: "string" }, method: { type: "string" } } }, example: { spec: { openapi: "3.1.0", info: { title: "Example API", version: "1" }, servers: [{ url: "https://api.example.com" }], paths: { "/users/{id}": { get: { operationId: "getUser", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK" } } } } } }, operation_id: "getUser" }, outputExample: { request: { method: "GET", url: "https://api.example.com/users/{id}" } } }, input, () => Promise.resolve(planOpenApiRequest(record.spec, { ...(typeof record.operation_id === "string" ? { operation_id: record.operation_id } : {}), ...(typeof record.path === "string" ? { path: record.path } : {}), ...(typeof record.method === "string" ? { method: record.method } : {}) })));
}

async function openApiDiff(request: Request, runtime: ApiRuntime): Promise<Response> {
  const input = await readToolJson(request);
  if (input instanceof Response) return input;
  const record = asObject(input);
  if (!record || !("before" in record) || !("after" in record)) return json({ error: { code: "specs_required", message: "Send before and after OpenAPI JSON documents." } }, 400);
  return executePaidTool(request, runtime, { name: "diff_openapi", resourcePath: "/v1/openapi/diff", priceUsd: "0.002", description: "Compare two caller-supplied OpenAPI JSON documents and flag compatibility changes.", inputSchema: { type: "object", required: ["before", "after"], properties: { before: {}, after: {} } }, example: { before: { openapi: "3.1.0", info: { title: "Example API", version: "1" }, paths: {} }, after: { openapi: "3.1.0", info: { title: "Example API", version: "2" }, paths: { "/health": { get: { operationId: "health", responses: { "200": { description: "OK" } } } } } } }, outputExample: { added: ["GET /health"], removed: [], changed: [] } }, input, () => Promise.resolve(diffOpenApi(record.before, record.after)));
}

async function chainTool(request: Request, runtime: ApiRuntime, kind: "balance" | "transaction" | "erc20-balance"): Promise<Response> {
  const input = await readToolJson(request);
  if (input instanceof Response) return input;
  const name = kind === "balance" ? "get_chain_balance" : kind === "transaction" ? "get_chain_transaction" : "get_erc20_balance";
  const description = kind === "balance" ? "Read a native Base balance through a fixed public RPC." : kind === "transaction" ? "Read the status of one Base transaction through a fixed public RPC." : "Read one ERC-20 balance on Base through a fixed public RPC.";
  const resourcePath = kind === "balance" ? "/v1/chain/balance" : kind === "transaction" ? "/v1/chain/transaction" : "/v1/chain/erc20-balance";
  return executePaidTool(request, runtime, { name, resourcePath, priceUsd: runtime.chainPriceUsd ?? "0.001", description, inputSchema: { type: "object", properties: { network: { type: "string", enum: ["eip155:8453", "eip155:84532"] }, address: { type: "string" }, token: { type: "string" }, tx_hash: { type: "string" }, block: {} } }, example: kind === "transaction" ? { network: "eip155:8453", tx_hash: EXAMPLE_TX_HASH } : kind === "erc20-balance" ? { network: "eip155:8453", token: EXAMPLE_USDC, address: EXAMPLE_ADDRESS } : { network: "eip155:8453", address: EXAMPLE_ADDRESS }, outputExample: { network: "eip155:8453", observedAt: "2026-01-01T00:00:00.000Z" } }, input, () => readChainBalance(input as never, kind));
}

async function executePaidTool(request: Request, runtime: ApiRuntime, definition: import("./paid-tools.js").PaidToolDefinition, input: unknown, handler: () => Promise<unknown>): Promise<Response> {
  if (!runtime.paidTools) return json({ error: { code: "tool_unavailable", message: "This tool is not configured on the current runtime." } }, 503);
  let payload: PaymentPayloadV2 | null = null;
  const paymentHeader = request.headers.get("payment-signature");
  if (paymentHeader) { try { payload = decodePaymentPayload(paymentHeader); } catch (error) { return json({ error: { code: "invalid_payment", message: error instanceof Error ? error.message : "Payment payload is invalid." } }, 400); } }
  const outcome = await runtime.paidTools.execute(definition, input, request.headers.get("idempotency-key"), payload, handler);
  if (outcome.kind === "payment_required") return paymentRequiredResponse(runtime, `${runtime.service.config.publicBaseUrl}/v1/tools/${definition.name}`, "Payment is required for this tool.", outcome.paymentRequired);
  if (outcome.kind === "error") return json({ error: { code: outcome.code, message: outcome.message }, ...(outcome.details !== undefined ? { details: outcome.details } : {}) }, outcome.status);
  return json({ ...(isObject(outcome.value) ? outcome.value : { value: outcome.value }), ...(outcome.settlement ? { settlement: outcome.settlement } : {}), ...(outcome.resumed ? { resumed: true } : {}) }, 200, outcome.settlement ? { "payment-response": base64Json(outcome.settlement) } : undefined);
}

async function readToolJson(request: Request): Promise<unknown | Response> {
  try { return await readJsonLimited(request); }
  catch (error) { if (error instanceof InputError) return json({ error: { code: error.code, message: error.message } }, error.status); throw error; }
}

function asObject(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

async function downloadPdf(service: PdfService, id: string, capability: string): Promise<Response> {
  const result = await service.readPdf(id, capability);
  if (!result) return notFound();
  const bytes = result.bytes;
  return new Response(Uint8Array.from(bytes).buffer, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-length": String(bytes.byteLength),
      "content-disposition": "attachment; filename=\"document.pdf\"",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

function pricingDocument(runtime: ApiRuntime): Record<string, unknown> {
  const gateway = runtime.service.config.payment;
  const amountAtomic = gateway.requirements?.amount ?? null;
  const documentPriceUsd = runtime.documentPriceUsd ?? "0.01";
  const documentAmountAtomic = gateway.requirements ? (() => { try { return usdToSixDecimals(documentPriceUsd); } catch { return null; } })() : null;
  return {
    name: "x402-pdf",
    version: "0.3.2",
    description: "Deterministic x402-paid evidence tools for PDFs, public webpages, OpenAPI contracts, and Base read-only chain data.",
    operation: "generate_pdf",
    formats: ["application/pdf"],
    input: {
      contentType: "application/json",
      schema: {
        type: "object",
        required: ["title", "markdown"],
        additionalProperties: false,
        properties: {
          title: { type: "string", maxLength: 160 },
          markdown: { type: "string", maxBytes: runtime.service.config.maxMarkdownBytes },
        },
      },
    },
    price: {
      amountUsd: runtime.priceUsd,
      currency: "USD",
      token: "USDC",
      atomicAmount: amountAtomic,
      per: "generated PDF",
      paymentProtocol: gateway.mode === "live" ? "x402-v2" : null,
      mode: runtime.paymentMode,
      ready: gateway.mode === "live",
      ...(gateway.requirements ? { accepts: [gateway.requirements] } : {}),
      ...(gateway.mode === "unconfigured" ? { configurationRequired: [
        "PAYMENTS_MODE=live", "PUBLIC_BASE_URL", "X402_NETWORK", "X402_ASSET", "X402_PAY_TO", "X402_FACILITATOR_URL",
      ] } : {}),
    },
    billing: {
      paid: ["generate_pdf", "ingest_document", "web_evidence", "inspect_openapi", "plan_api_request", "diff_openapi", "get_chain_balance", "get_chain_transaction", "get_erc20_balance"],
      free: ["inspect_pdf", "get_document_map", "search_document", "batch_search_document", "prepare_document_context", "extract_document_fields", "read_document", "verify_document_citation", "compare_pdfs", "validate_pdf_text", "render_pdf_page_region"],
      includedWithGeneration: ["get_pdf_job", "download_pdf"],
      modelCalls: 0,
      note: "Paid tools use x402 exact USDC with durable idempotency and replay protection. Document retrieval remains included after paid indexing.",
    },
    operations: [
      { name: "generate_pdf", billing: "paid", amountUsd: runtime.priceUsd, unit: "per generated PDF", rest: "POST /v1/pdf", mcp: true },
      { name: "ingest_document", billing: "paid", amountUsd: documentPriceUsd, atomicAmount: documentAmountAtomic, unit: "per indexed PDF", rest: "POST /v1/documents", mcp: false },
      { name: "inspect_pdf", billing: "free", amountUsd: "0", unit: "per call", rest: "GET /v1/documents/{id}", mcp: true },
      { name: "get_document_map", billing: "free", amountUsd: "0", unit: "per call", rest: "GET /v1/documents/{id}/map", mcp: true },
      { name: "search_document", billing: "free", amountUsd: "0", unit: "per call", rest: "POST /v1/documents/{id}/search", mcp: true },
      { name: "batch_search_document", billing: "free", amountUsd: "0", unit: "per call", rest: "POST /v1/documents/{id}/batch-search", mcp: true },
      { name: "prepare_document_context", billing: "free", amountUsd: "0", unit: "per call", rest: "POST /v1/documents/{id}/context", mcp: true },
      { name: "extract_document_fields", billing: "free", amountUsd: "0", unit: "per call", rest: "POST /v1/documents/{id}/fields", mcp: true },
      { name: "read_document", billing: "free", amountUsd: "0", unit: "per call", rest: "POST /v1/documents/{id}/read", mcp: true },
      { name: "verify_document_citation", billing: "free", amountUsd: "0", unit: "per call", rest: "POST /v1/documents/{id}/citation", mcp: true },
      { name: "compare_pdfs", billing: "free", amountUsd: "0", unit: "per call", rest: "POST /v1/documents/compare", mcp: true },
      { name: "validate_pdf_text", billing: "free", amountUsd: "0", unit: "per call", rest: "POST /v1/documents/{id}/validate", mcp: true },
      { name: "render_pdf_page_region", billing: "free", amountUsd: "0", unit: "per call", rest: "GET /v1/documents/{id}/pages/{page}/render", mcp: true },
      { name: "get_pdf_job", billing: "included", amountUsd: "0", unit: "per call", rest: "GET /v1/jobs/{id}", mcp: true },
      { name: "download_pdf", billing: "included", amountUsd: "0", unit: "per download", rest: "GET /v1/jobs/{id}/download", mcp: false },
      { name: "web_evidence", billing: "paid", amountUsd: runtime.webEvidencePriceUsd ?? "0.005", unit: "per public HTTPS page", rest: "POST /v1/web/evidence", mcp: true },
      { name: "inspect_openapi", billing: "paid", amountUsd: runtime.openApiPriceUsd ?? "0.001", unit: "per specification", rest: "POST /v1/openapi/inspect", mcp: true },
      { name: "plan_api_request", billing: "paid", amountUsd: "0.002", unit: "per request plan", rest: "POST /v1/openapi/request-plan", mcp: true },
      { name: "diff_openapi", billing: "paid", amountUsd: "0.002", unit: "per comparison", rest: "POST /v1/openapi/diff", mcp: true },
      { name: "get_chain_balance", billing: "paid", amountUsd: runtime.chainPriceUsd ?? "0.001", unit: "per read", rest: "POST /v1/chain/balance", mcp: true },
      { name: "get_chain_transaction", billing: "paid", amountUsd: runtime.chainPriceUsd ?? "0.001", unit: "per read", rest: "POST /v1/chain/transaction", mcp: true },
      { name: "get_erc20_balance", billing: "paid", amountUsd: runtime.chainPriceUsd ?? "0.001", unit: "per read", rest: "POST /v1/chain/erc20-balance", mcp: true },
    ],
    endpoints: {
      create: { method: "POST", path: "/v1/pdf", idempotencyHeader: "Idempotency-Key", paid: true },
      status: { method: "GET", path: "/v1/jobs/{jobId}", authorization: "Bearer capability" },
      download: { method: "GET", path: "/v1/jobs/{jobId}/download", authorization: "Bearer capability" },
      mcp: { transport: "Streamable HTTP", path: "/mcp", tool: "generate_pdf" },
    },
    documentOperations: runtime.documents ? {
      runtime: runtime.documentRuntime ?? "node-local",
      ingest: { method: "POST", path: "/v1/documents", recoveryHeader: "X-Document-Recovery-Key" },
      operations: ["inspect", "map", "search", "batch-search", "context", "fields", "read", "citation", "compare", "validate", "render"],
      authorization: "Bearer document capability",
      price: { amountUsd: documentPriceUsd, atomicAmount: documentAmountAtomic, currency: "USD", billing: "paid", unit: "per indexed PDF", ...(gateway.requirements && documentAmountAtomic ? { accepts: [{ ...gateway.requirements, amount: documentAmountAtomic }] } : {}) },
      retentionSeconds: runtime.documentTtlSeconds ?? 24 * 60 * 60,
      limits: { uploadBytes: MAX_DOCUMENT_BYTES, pages: 100, extractedTextBytes: 5 * 1024 * 1024, indexBytes: 8 * 1024 * 1024, readPages: 10, readOutputChars: 32_000, searchQueryChars: 200, searchHits: 20, renderPixels: 4_000_000 },
    } : { available: false, reason: "The Worker PDF service does not persist or process uploaded source documents." },
    limits: {
      requestBytes: MAX_REQUEST_BYTES,
      markdownBytes: runtime.service.config.maxMarkdownBytes,
      pdfBytes: runtime.service.config.maxPdfBytes,
      artifactTtlSeconds: runtime.service.config.jobTtlSeconds,
      documentTtlSeconds: runtime.documentTtlSeconds ?? 24 * 60 * 60,
      requestTimeoutSeconds: 120,
    },
  };
}

function mcpServerCard(runtime: ApiRuntime): Record<string, unknown> {
  const string = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "string", ...extra });
  const integer = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "integer", ...extra });
  const number = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "number", ...extra });
  const object = (required: string[], properties: Record<string, unknown>): Record<string, unknown> => ({ type: "object", required, properties, additionalProperties: false });
  const uuid = string({ format: "uuid" });
  const capability = string({ minLength: 40, maxLength: 64 });
  const idempotency = string({ minLength: 8, maxLength: 128 });
  const documentBase = { document_id: uuid, capability };
  const page = integer({ minimum: 1 });
  const boundedPage = integer({ minimum: 1, maximum: 100 });
  const documentTools = runtime.documents ? [
    { name: "inspect_pdf", billing: "included_after_paid_indexing", description: toolTask("inspect_pdf"), inputSchema: object(["document_id", "capability"], documentBase) },
    { name: "get_document_map", billing: "included_after_paid_indexing", description: toolTask("get_document_map"), inputSchema: object(["document_id", "capability"], { ...documentBase, page: boundedPage }) },
    { name: "search_document", billing: "included_after_paid_indexing", description: toolTask("search_document"), inputSchema: object(["document_id", "capability", "query"], { ...documentBase, query: string({ minLength: 1, maxLength: 200 }), page, limit: integer({ minimum: 1, maximum: 20 }) }) },
    { name: "batch_search_document", billing: "included_after_paid_indexing", description: toolTask("batch_search_document"), inputSchema: object(["document_id", "capability", "queries"], { ...documentBase, queries: { type: "array", minItems: 1, maxItems: 20, items: string({ minLength: 1, maxLength: 200 }) }, page, limit: integer({ minimum: 1, maximum: 20 }) }) },
    { name: "prepare_document_context", billing: "included_after_paid_indexing", description: toolTask("prepare_document_context"), inputSchema: object(["document_id", "capability", "query"], { ...documentBase, query: string({ minLength: 1, maxLength: 200 }), max_chars: integer({ minimum: 1000, maximum: 32000 }), pages: { type: "array", maxItems: 100, items: boundedPage } }) },
    { name: "extract_document_fields", billing: "included_after_paid_indexing", description: toolTask("extract_document_fields"), inputSchema: object(["document_id", "capability", "fields"], { ...documentBase, fields: { type: "array", minItems: 1, maxItems: 20, items: object(["name", "label"], { name: string({ minLength: 1, maxLength: 80 }), label: string({ minLength: 1, maxLength: 160 }), page: boundedPage }) } }) },
    { name: "read_document", billing: "included_after_paid_indexing", description: toolTask("read_document"), inputSchema: object(["document_id", "capability", "pages"], { ...documentBase, pages: { type: "array", minItems: 1, maxItems: 10, items: page } }) },
    { name: "verify_document_citation", billing: "included_after_paid_indexing", description: toolTask("verify_document_citation"), inputSchema: object(["document_id", "capability", "page", "quote"], { ...documentBase, page, quote: string({ minLength: 5, maxLength: 500 }) }) },
    { name: "compare_pdfs", billing: "included_after_paid_indexing", description: toolTask("compare_pdfs"), inputSchema: object(["left_document_id", "left_capability", "right_document_id", "right_capability"], { left_document_id: uuid, left_capability: capability, right_document_id: uuid, right_capability: capability }) },
    { name: "validate_pdf_text", billing: "included_after_paid_indexing", description: toolTask("validate_pdf_text"), inputSchema: object(["document_id", "capability"], { ...documentBase, page_count: boundedPage, required_text: { type: "array", maxItems: 20, items: string({ minLength: 1, maxLength: 500 }) } }) },
    { name: "render_pdf_page_region", billing: "included_after_paid_indexing", description: toolTask("render_pdf_page_region"), inputSchema: object(["document_id", "capability", "page", "x", "y", "width", "height"], { ...documentBase, page, x: number({ minimum: 0, maximum: 1 }), y: number({ minimum: 0, maximum: 1 }), width: number({ minimum: 0.001, maximum: 1 }), height: number({ minimum: 0.001, maximum: 1 }), scale: number({ minimum: 0.5, maximum: 3 }) }) },
  ] : [];
  return {
    schemaVersion: "2025-12-11",
    name: "xyz.task402/x402-docs",
    title: "Task402 Agent Evidence Tools",
    version: "0.3.2",
    description: "Paid evidence tools for PDFs, public webpages, OpenAPI contracts, and Base chain data for AI agents.",
    serverInfo: { name: "Task402 Agent Evidence Tools", version: "0.3.2", websiteUrl: runtime.service.config.publicBaseUrl },
    homepage: runtime.service.config.publicBaseUrl,
    remotes: [{ type: "streamable-http", url: `${runtime.service.config.publicBaseUrl}/mcp` }],
    capabilities: { tools: true },
    discovery: {
      docs: `${runtime.service.config.publicBaseUrl}/docs`,
      pricing: `${runtime.service.config.publicBaseUrl}/v1/pricing`,
      tools: `${runtime.service.config.publicBaseUrl}/v1/tools`,
      openapi: `${runtime.service.config.publicBaseUrl}/openapi.json`,
      llms: `${runtime.service.config.publicBaseUrl}/llms.txt`,
    },
    tools: [
      { name: "generate_pdf", billing: "x402", price: runtime.priceUsd, description: "Generate a paginated PDF from Markdown.", inputSchema: object(["title", "markdown", "idempotency_key"], { title: string({ minLength: 1, maxLength: 160 }), markdown: string({ minLength: 1, maxLength: 240 * 1024 }), idempotency_key: idempotency }) },
      { name: "get_pdf_job", billing: "included", description: "Read a generation job and download URL.", inputSchema: object(["job_id", "capability"], { job_id: uuid, capability }) },
      ...documentTools,
      { name: "web_evidence", billing: "x402", price: runtime.webEvidencePriceUsd ?? "0.005", description: "Fetch a public HTTPS page into bounded citation-ready evidence.", inputSchema: object(["url", "idempotency_key"], { url: string({ format: "uri", maxLength: 2048 }), query: string({ maxLength: 200 }), max_chars: integer({ minimum: 2000, maximum: 24000 }), idempotency_key: idempotency }) },
      { name: "inspect_openapi", billing: "x402", price: runtime.openApiPriceUsd ?? "0.001", description: "Inspect caller-supplied OpenAPI JSON.", inputSchema: object(["spec", "idempotency_key"], { spec: {}, idempotency_key: idempotency }) },
      { name: "plan_api_request", billing: "x402", price: "0.002", description: "Plan an API request without executing it.", inputSchema: object(["spec", "idempotency_key"], { spec: {}, operation_id: string(), path: string(), method: string(), idempotency_key: idempotency }) },
      { name: "diff_openapi", billing: "x402", price: "0.002", description: "Compare two OpenAPI specifications.", inputSchema: object(["before", "after", "idempotency_key"], { before: {}, after: {}, idempotency_key: idempotency }) },
      { name: "get_chain_balance", billing: "x402", price: runtime.chainPriceUsd ?? "0.001", description: "Read a native Base balance.", inputSchema: object(["address", "idempotency_key"], { address: string({ minLength: 1 }), network: string(), block: { anyOf: [string(), number()] }, idempotency_key: idempotency }) },
      { name: "get_chain_transaction", billing: "x402", price: runtime.chainPriceUsd ?? "0.001", description: "Read a Base transaction receipt.", inputSchema: object(["tx_hash", "idempotency_key"], { tx_hash: string({ minLength: 1 }), network: string(), idempotency_key: idempotency }) },
      { name: "get_erc20_balance", billing: "x402", price: runtime.chainPriceUsd ?? "0.001", description: "Read one ERC-20 balance on Base.", inputSchema: object(["token", "address", "idempotency_key"], { token: string({ minLength: 1 }), address: string({ minLength: 1 }), network: string(), block: { anyOf: [string(), number()] }, idempotency_key: idempotency }) },
    ],
    limitations: ["No OCR", "Native text only", "Web evidence is public HTTPS HTML/text only", "Chain tools never sign or submit transactions", "Capabilities and recovery keys are bearer secrets"],
  };
}

function serverManifest(runtime: ApiRuntime): Record<string, unknown> {
  const card = mcpServerCard(runtime);
  const pricing = pricingDocument(runtime);
  const operations = Array.isArray(pricing.operations) ? pricing.operations as Array<Record<string, unknown>> : [];
  const paidTools = operations.filter((operation) => operation.billing === "paid").reduce<Record<string, string>>((result, operation) => {
    result[String(operation.name)] = `$${String(operation.amountUsd)}/${String(operation.unit).replace(/^per /, "")}`;
    return result;
  }, {});
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: "xyz.task402/x402-docs",
    title: "Task402 Agent Evidence Tools",
    description: String(card.description),
    version: String(card.version),
    websiteUrl: runtime.service.config.publicBaseUrl,
    repository: { url: "https://github.com/xbckz/task402", source: "github" },
    _meta: {
      "io.modelcontextprotocol.registry/publisher-provided": {
        documentationUrl: `${runtime.service.config.publicBaseUrl}/docs`,
        pricingUrl: `${runtime.service.config.publicBaseUrl}/v1/pricing`,
        useCases: ["Verify page quotes in research PDFs", "Find changed pages between PDF revisions", "Build bounded cited context for an agent", "Fetch public-page evidence", "Inspect and diff OpenAPI contracts", "Read Base balances and receipts", "Generate paginated reports"],
        toolCount: Array.isArray(card.tools) ? card.tools.length : 0,
        paidTools,
        limitations: card.limitations,
      },
    },
    remotes: [{ type: "streamable-http", url: `${runtime.service.config.publicBaseUrl}/mcp` }],
  };
}

function toolCatalog(runtime: ApiRuntime): Record<string, unknown> {
  const contract = pricingDocument(runtime);
  const operations = Array.isArray(contract.operations) ? contract.operations : [];
  return { name: "Task402 Agent Evidence Tools", version: contract.version, generatedAt: new Date().toISOString(), source: "/v1/pricing", tools: operations.map((operation) => ({ ...(operation as Record<string, unknown>), task: toolTask(String((operation as Record<string, unknown>).name)) })) };
}

function toolTask(name: string): string {
  const tasks: Record<string, string> = {
    generate_pdf: "Create a paginated PDF from Markdown",
    ingest_document: "Index a PDF once for bounded evidence retrieval",
    inspect_pdf: "Understand PDF metadata, forms, attachments, and warnings",
    get_document_map: "Inspect page geometry and positioned native text",
    search_document: "Find exact text and page evidence",
    batch_search_document: "Find several clauses or fields in one call",
    prepare_document_context: "Build a compact cited context pack for a question",
    extract_document_fields: "Extract caller-specified labeled values with page evidence",
    read_document: "Read selected pages without sending the whole file",
    verify_document_citation: "Check that a quote occurs on its stated page",
    compare_pdfs: "Compare normalized text between two PDFs",
    validate_pdf_text: "Check parseability, page count, and required text",
    render_pdf_page_region: "Visually inspect a bounded page crop",
    get_pdf_job: "Poll a generated PDF job",
    download_pdf: "Download a generated PDF artifact",
    web_evidence: "Fetch a public page and return bounded citation-ready evidence",
    inspect_openapi: "Inspect OpenAPI operations, parameters, security, and references",
    plan_api_request: "Plan an API request from an OpenAPI operation without executing it",
    diff_openapi: "Compare two OpenAPI specifications for documented changes",
    get_chain_balance: "Read a native Base balance",
    get_chain_transaction: "Read the status of a Base transaction",
    get_erc20_balance: "Read a single ERC-20 balance on Base",
  };
  return tasks[name] ?? "Use the operation described by its schema.";
}

function openApiDocument(runtime: ApiRuntime): Record<string, unknown> {
  const base = runtime.service.config.publicBaseUrl.replace(/\/$/, "");
  return {
    openapi: "3.1.0",
    info: { title: "Task402 Agent Evidence Tools", version: "0.3.2", description: "Deterministic PDF, web evidence, OpenAPI, and Base read-only chain tools for agents." },
    servers: [{ url: base }],
    paths: {
      "/v1/pricing": { get: { operationId: "pricing", responses: { "200": { description: "Machine-readable pricing and limits." } } } },
      "/v1/tools": { get: { operationId: "tools", responses: { "200": { description: "Task-oriented tool catalog." } } } },
      "/v1/web/evidence": { post: { operationId: "web_evidence", description: "Paid bounded extraction from a public HTTPS page; no cookies, authentication, or JavaScript execution.", security: [{ x402Payment: [] }], parameters: [{ "$ref": "#/components/parameters/IdempotencyKey" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/WebEvidenceRequest" } } } }, responses: { "200": { description: "Cited evidence result." }, "402": { description: "Payment required." } } } },
      "/v1/openapi/inspect": { post: { operationId: "inspect_openapi", description: "Inspect a caller-supplied OpenAPI JSON document without fetching remote references.", security: [{ x402Payment: [] }], parameters: [{ "$ref": "#/components/parameters/IdempotencyKey" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/OpenApiSpecRequest" } } } }, responses: { "200": { description: "OpenAPI operation inventory." }, "402": { description: "Payment required." } } } },
      "/v1/openapi/request-plan": { post: { operationId: "plan_api_request", description: "Generate a safe request plan without executing the request.", security: [{ x402Payment: [] }], parameters: [{ "$ref": "#/components/parameters/IdempotencyKey" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/OpenApiPlanRequest" } } } }, responses: { "200": { description: "Request plan." }, "402": { description: "Payment required." } } } },
      "/v1/openapi/diff": { post: { operationId: "diff_openapi", description: "Compare two caller-supplied OpenAPI JSON documents.", security: [{ x402Payment: [] }], parameters: [{ "$ref": "#/components/parameters/IdempotencyKey" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/OpenApiDiffRequest" } } } }, responses: { "200": { description: "Deterministic API diff." }, "402": { description: "Payment required." } } } },
      "/v1/chain/balance": { post: { operationId: "get_chain_balance", description: "Read a native Base balance through a fixed public RPC.", security: [{ x402Payment: [] }], parameters: [{ "$ref": "#/components/parameters/IdempotencyKey" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/ChainBalanceRequest" } } } }, responses: { "200": { description: "Native balance." }, "402": { description: "Payment required." } } } },
      "/v1/chain/transaction": { post: { operationId: "get_chain_transaction", description: "Read one Base transaction and receipt.", security: [{ x402Payment: [] }], parameters: [{ "$ref": "#/components/parameters/IdempotencyKey" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/ChainTransactionRequest" } } } }, responses: { "200": { description: "Transaction status." }, "402": { description: "Payment required." } } } },
      "/v1/chain/erc20-balance": { post: { operationId: "get_erc20_balance", description: "Read one ERC-20 balance on Base.", security: [{ x402Payment: [] }], parameters: [{ "$ref": "#/components/parameters/IdempotencyKey" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/Erc20BalanceRequest" } } } }, responses: { "200": { description: "Token balance." }, "402": { description: "Payment required." } } } },
      "/v1/pdf": { post: { operationId: "generate_pdf", description: "Paid x402 PDF generation.", security: [{ x402Payment: [] }], parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8 } }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/GeneratePdfRequest" }, example: { title: "Quarterly report", markdown: "# Summary" } } } }, responses: { "201": { description: "Generated job." }, "402": { description: "Payment required." } } } },
      "/v1/documents": { post: { operationId: "ingest_document", description: "Paid x402 PDF indexing.", security: [{ x402Payment: [] }], parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8 } }, { name: "X-Document-Recovery-Key", in: "header", required: true, schema: { type: "string", minLength: 32 } }, { name: "X-File-Name", in: "header", required: false, schema: { type: "string", maxLength: 180 } }], requestBody: { required: true, content: { "application/pdf": { schema: { type: "string", format: "binary" } } } }, responses: { "201": { description: "Indexed document." }, "402": { description: "Payment required." }, "503": { description: "Uncertain settlement; do not resubmit automatically." } } } },
      "/v1/documents/{id}": { get: { operationId: "inspect_document", security: [{ documentCapability: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Document metadata and page coverage." } } } },
      "/v1/documents/{id}/map": { get: { operationId: "get_document_map", security: [{ documentCapability: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }, { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1 } }], responses: { "200": { description: "Page map and positioned text blocks." } } } },
      "/v1/documents/{id}/search": { post: { operationId: "search_document", security: [{ documentCapability: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/SearchRequest" } } } }, responses: { "200": { description: "Bounded text matches." } } } },
      "/v1/documents/{id}/batch-search": { post: { operationId: "batch_search_document", security: [{ documentCapability: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/BatchSearchRequest" } } } }, responses: { "200": { description: "Bounded results for multiple queries." } } } },
      "/v1/documents/{id}/context": { post: { operationId: "prepare_document_context", security: [{ documentCapability: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/ContextRequest" } } } }, responses: { "200": { description: "Bounded cited context pack." } } } },
      "/v1/documents/{id}/fields": { post: { operationId: "extract_document_fields", security: [{ documentCapability: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/FieldsRequest" } } } }, responses: { "200": { description: "Literal labeled values with page evidence." } } } },
      "/v1/documents/{id}/read": { post: { operationId: "read_document", security: [{ documentCapability: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["pages"], properties: { pages: { type: "array", minItems: 1, maxItems: 10, items: { type: "integer", minimum: 1 } } } } } } }, responses: { "200": { description: "Native text from selected pages." } } } },
      "/v1/documents/{id}/citation": { post: { operationId: "verify_document_citation", security: [{ documentCapability: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["page", "quote"], properties: { page: { type: "integer", minimum: 1 }, quote: { type: "string", minLength: 5, maxLength: 500 } } } } } }, responses: { "200": { description: "Citation presence result with evidence." } } } },
      "/v1/documents/compare": { post: { operationId: "compare_pdfs", security: [{ documentCapability: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["leftId", "leftCapability", "rightId", "rightCapability"], properties: { leftId: { type: "string", format: "uuid" }, leftCapability: { type: "string" }, rightId: { type: "string", format: "uuid" }, rightCapability: { type: "string" } } } } } }, responses: { "200": { description: "Page-aligned native-text comparison." } } } },
      "/v1/documents/{id}/validate": { post: { operationId: "validate_pdf_text", security: [{ documentCapability: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Text and page-count validation result." } } } },
      "/v1/documents/{id}/pages/{page}/render": { get: { operationId: "render_pdf_page_region", security: [{ documentCapability: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }, { name: "page", in: "path", required: true, schema: { type: "integer", minimum: 1 } }, { name: "x", in: "query", required: false, schema: { type: "number", minimum: 0, maximum: 1 } }, { name: "y", in: "query", required: false, schema: { type: "number", minimum: 0, maximum: 1 } }, { name: "width", in: "query", required: false, schema: { type: "number", minimum: 0.001, maximum: 1 } }, { name: "height", in: "query", required: false, schema: { type: "number", minimum: 0.001, maximum: 1 } }, { name: "scale", in: "query", required: false, schema: { type: "number", minimum: 0.5, maximum: 3 } }], responses: { "200": { description: "Bounded PNG page region.", content: { "image/png": {} } } } } },
      "/v1/jobs/{id}": { get: { operationId: "get_pdf_job", security: [{ documentCapability: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Generation status and capability URLs." } } } },
      "/v1/jobs/{id}/download": { get: { operationId: "download_pdf", security: [{ documentCapability: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Generated application/pdf artifact." } } } },
    },
    components: { parameters: { IdempotencyKey: { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 128 } } }, securitySchemes: { documentCapability: { type: "http", scheme: "bearer", description: "Short-lived document capability returned after paid indexing." }, x402Payment: { type: "apiKey", in: "header", name: "PAYMENT-SIGNATURE", description: "Base64 encoded x402 v2 payment payload returned by the agent wallet." } }, schemas: {
      GeneratePdfRequest: { type: "object", required: ["title", "markdown"], additionalProperties: false, properties: { title: { type: "string", minLength: 1, maxLength: 160 }, markdown: { type: "string", minLength: 1, maxLength: 245760 } } },
      SearchRequest: { type: "object", required: ["query"], additionalProperties: false, properties: { query: { type: "string", minLength: 1, maxLength: 200 }, page: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 20 } } },
      BatchSearchRequest: { type: "object", required: ["queries"], additionalProperties: false, properties: { queries: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 200 } }, page: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 20 } } },
      ContextRequest: { type: "object", required: ["query"], additionalProperties: false, properties: { query: { type: "string", minLength: 1, maxLength: 200 }, maxChars: { type: "integer", minimum: 1000, maximum: 32000 }, pages: { type: "array", maxItems: 100, items: { type: "integer", minimum: 1 } } } },
      FieldsRequest: { type: "object", required: ["fields"], additionalProperties: false, properties: { fields: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", required: ["name", "label"], additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 80 }, label: { type: "string", minLength: 1, maxLength: 160 }, page: { type: "integer", minimum: 1 } } } } } },
      WebEvidenceRequest: { type: "object", required: ["url"], additionalProperties: false, properties: { url: { type: "string", format: "uri", maxLength: 2048 }, query: { type: "string", maxLength: 200 }, max_chars: { type: "integer", minimum: 2000, maximum: 24000 } } },
      OpenApiSpecRequest: { type: "object", required: ["spec"], properties: { spec: { type: ["object", "string"] } } },
      OpenApiPlanRequest: { type: "object", required: ["spec"], properties: { spec: { type: ["object", "string"] }, operation_id: { type: "string" }, path: { type: "string" }, method: { type: "string" } } },
      OpenApiDiffRequest: { type: "object", required: ["before", "after"], properties: { before: { type: ["object", "string"] }, after: { type: ["object", "string"] } } },
      ChainBalanceRequest: { type: "object", required: ["address"], additionalProperties: false, properties: { network: { type: "string", enum: ["eip155:8453", "eip155:84532"] }, address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, block: {} } },
      ChainTransactionRequest: { type: "object", required: ["tx_hash"], additionalProperties: false, properties: { network: { type: "string", enum: ["eip155:8453", "eip155:84532"] }, tx_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } } },
      Erc20BalanceRequest: { type: "object", required: ["token", "address"], additionalProperties: false, properties: { network: { type: "string", enum: ["eip155:8453", "eip155:84532"] }, token: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, block: {} } },
    } },
  };
}

async function ingestDocument(request: Request, runtime: ApiRuntime): Promise<Response> {
  const documents = runtime.documents;
  if (!documents) return documentRuntimeUnavailable();
  const resourceUrl = `${runtime.service.config.publicBaseUrl}/v1/documents`;
  const requirements = documentPaymentRequirements(runtime);
  let payment: PaymentPayloadV2 | null = null;
  let paymentContext: { key: string; fingerprint: string; payer: string } | undefined;
  let upload: Uint8Array | null = null;
  if (request.headers.has("payment-signature")) {
    const read = await readPdfUpload(request);
    if (read instanceof Response) return read;
    upload = read;
    let previous;
    try { previous = await documents.resume(upload, request.headers.get("x-file-name") ?? "document.pdf", request.headers.get("idempotency-key"), request.headers.get("x-document-recovery-key")); }
    catch (error) { return documentError(error); }
    if (previous) {
      if (previous.paymentState === "complete") return json({ ...previous, ...documents.documentUrls(previous.documentId) }, 200);
      if (previous.paymentState === "settlement_unknown" || previous.paymentState === "settling") return json({ error: { code: "payment_recovery_pending", message: "This document payment is awaiting reconciliation. Do not send the same payment again." }, details: { documentId: previous.documentId, ...documents.documentUrls(previous.documentId) } }, 503);
    }
  }
  if (runtime.service.config.payment.mode === "live") {
    if (!requirements) return json({ error: { code: "payments_unconfigured", message: "Live x402 document payment requirements are unavailable." } }, 503);
    const paymentHeader = request.headers.get("payment-signature");
    if (!paymentHeader) return paymentRequiredResponse(runtime, resourceUrl, "Payment is required to index a PDF.", buildPaymentRequired(runtime.service.config.payment, resourceUrl, "Payment is required to index a PDF.", requirements) ?? undefined);
    try { payment = decodePaymentPayload(paymentHeader); }
    catch (error) {
      const message = error instanceof Error ? error.message : "Payment payload is malformed.";
      return paymentRequiredResponse(runtime, resourceUrl, message, buildPaymentRequired(runtime.service.config.payment, resourceUrl, message, requirements) ?? undefined);
    }
    try { validatePaymentPayload(payment, requirements, resourceUrl); }
    catch (error) {
      const message = error instanceof Error ? error.message : "Payment payload is invalid.";
      return paymentRequiredResponse(runtime, resourceUrl, message, buildPaymentRequired(runtime.service.config.payment, resourceUrl, message, requirements) ?? undefined);
    }
    let verification: Awaited<ReturnType<typeof runtime.service.config.payment.verify>>;
    try { verification = await runtime.service.config.payment.verify(payment, requirements); }
    catch { return json({ error: { code: "payment_verification_unavailable", message: "The payment facilitator could not verify this request." } }, 503); }
    const expectedPayer = (payment.payload.authorization as { from?: unknown } | undefined)?.from;
    if (!verification.isValid || !verification.payer || typeof expectedPayer !== "string" || verification.payer.toLowerCase() !== expectedPayer.toLowerCase()) {
      const message = verification.reason ?? "Payment authorization is invalid.";
      return paymentRequiredResponse(runtime, resourceUrl, message, buildPaymentRequired(runtime.service.config.payment, resourceUrl, message, requirements) ?? undefined);
    }
    try {
      const semantic = payloadSemanticKey(payment);
      paymentContext = { key: semantic.key, fingerprint: paymentPayloadFingerprint(payment), payer: semantic.payer };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Payment authorization is invalid.";
      return paymentRequiredResponse(runtime, resourceUrl, message, buildPaymentRequired(runtime.service.config.payment, resourceUrl, message, requirements) ?? undefined);
    }
  }
  if (!upload) {
    const read = await readPdfUpload(request);
    if (read instanceof Response) return read;
    upload = read;
  }
  const bytes = upload;
  try {
    const result = await documents.ingest(bytes, request.headers.get("x-file-name") ?? "document.pdf", request.headers.get("idempotency-key"), request.headers.get("x-document-recovery-key"), paymentContext);
    if (!payment) return json({ ...result, ...documents.documentUrls(result.documentId) }, result.resumed ? 200 : 201);
    if (result.resumed && result.paymentState === "complete") return json({ ...result, ...documents.documentUrls(result.documentId) }, 200);
    if (result.resumed && result.paymentState !== "reserved") {
      return json({ error: { code: "payment_recovery_pending", message: "This document payment is awaiting reconciliation. Do not send the same payment again." }, details: { documentId: result.documentId, ...documents.documentUrls(result.documentId) } }, 503);
    }
    if (!await documents.claimPaymentSettlement(result.documentId)) {
      return json({ error: { code: "payment_recovery_pending", message: "Another request is settling this document payment. Do not send the same payment again." }, details: { documentId: result.documentId, ...documents.documentUrls(result.documentId) } }, 503);
    }
    let settlement;
    try { settlement = await runtime.service.config.payment.settle(payment, requirements!); }
    catch (error) {
      const definitive = !!(error && typeof error === "object" && "definitiveSettlementFailure" in error && (error as { definitiveSettlementFailure?: boolean }).definitiveSettlementFailure);
      if (definitive) {
        await documents.markPaymentFailed(result.documentId);
        return paymentRequiredResponse(runtime, resourceUrl, "The facilitator reported that this payment did not settle.", buildPaymentRequired(runtime.service.config.payment, resourceUrl, "The facilitator reported that this payment did not settle.", requirements) ?? undefined);
      }
      await documents.markPaymentUnknown(result.documentId);
      return json({ error: { code: "payment_recovery_pending", message: "The facilitator did not return a definitive settlement result. This payment will not be sent again automatically." }, details: { documentId: result.documentId, ...documents.documentUrls(result.documentId) } }, 503);
    }
    if (!await documents.activatePayment(result.documentId, settlement)) {
      await documents.markPaymentUnknown(result.documentId, "payment_state_finalize_failed");
      return json({ error: { code: "payment_recovery_pending", message: "Payment settled, but document access could not be finalized. This payment will not be sent again automatically." }, details: { documentId: result.documentId, ...documents.documentUrls(result.documentId) } }, 503);
    }
    return json({ ...result, ...documents.documentUrls(result.documentId), settlement }, 201, { "payment-response": base64Json(settlement) });
  } catch (error) { return documentError(error); }
}

function documentPaymentRequirements(runtime: ApiRuntime): PaymentRequirements | undefined {
  const base = runtime.service.config.payment.requirements;
  if (!base) return undefined;
  try { return { ...base, amount: usdToSixDecimals(runtime.documentPriceUsd ?? "0.01") }; }
  catch { return undefined; }
}

async function handleDocumentOperation(request: Request, path: string, url: URL, documents: PdfDocumentService): Promise<Response> {
  const compare = path === "/v1/documents/compare" && request.method === "POST";
  if (compare) {
    try {
      const body = await readJsonLimited(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("invalid_document_comparison", "Request body must be an object.");
      const value = body as Record<string, unknown>;
      if (Object.keys(value).some((key) => !["leftId", "leftCapability", "rightId", "rightCapability"].includes(key)) ||
          typeof value.leftId !== "string" || typeof value.leftCapability !== "string" || typeof value.rightId !== "string" || typeof value.rightCapability !== "string") {
        throw new InputError("invalid_document_comparison", "Provide leftId, leftCapability, rightId, and rightCapability.");
      }
      return json(await documents.compare(value.leftId, value.leftCapability, value.rightId, value.rightCapability));
    } catch (error) { return documentError(error); }
  }
  const match = /^\/v1\/documents\/([0-9a-f-]{36})(?:\/(map|search|batch-search|context|fields|read|citation|validate|pages\/(\d+)\/render))?$/i.exec(path);
  if (!match) return json({ error: { code: "not_found", message: "Document endpoint not found." } }, 404);
  const [, id, operation, renderPage] = match;
  const capability = readDocumentCapability(request.headers.get("authorization"), request.headers.get("x-document-capability"));
  try {
    if (!operation && request.method === "GET") return json(await documents.inspect(id!, capability));
    if (operation === "map" && request.method === "GET") {
      const pageText = url.searchParams.get("page");
      if (pageText !== null && !/^\d+$/.test(pageText)) throw new DocumentError("invalid_page", "page must be a positive integer.");
      return json(await documents.getMap(id!, capability, pageText === null ? undefined : Number(pageText)));
    }
    if (operation?.startsWith("pages/") && renderPage && request.method === "GET") {
      const numeric = (name: string, fallback?: number): number => {
        const raw = url.searchParams.get(name);
        if (raw === null && fallback !== undefined) return fallback;
        if (raw === null || raw.trim() === "") throw new DocumentError("invalid_crop", `Query parameter ${name} is required.`);
        const number = Number(raw);
        if (!Number.isFinite(number)) throw new DocumentError("invalid_crop", `Query parameter ${name} must be numeric.`);
        return number;
      };
      const png = await documents.renderPage(id!, capability, Number(renderPage), {
        x: numeric("x", 0), y: numeric("y", 0), width: numeric("width", 1), height: numeric("height", 1), scale: numeric("scale", 1.5),
      });
      return new Response(Uint8Array.from(png).buffer, { headers: { "content-type": "image/png", "content-length": String(png.byteLength), "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
    }
    if (operation === "search" && request.method === "POST") {
      const value = await readJsonLimited(request);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("invalid_search", "Request body must be an object.");
      const body = value as Record<string, unknown>;
      if (Object.keys(body).some((key) => !["query", "page", "limit"].includes(key)) || typeof body.query !== "string" ||
          (body.page !== undefined && typeof body.page !== "number") || (body.limit !== undefined && typeof body.limit !== "number")) throw new InputError("invalid_search", "Provide query and optional numeric page/limit fields.");
      return json(await documents.search(id!, capability, body.query, { ...(body.page !== undefined ? { page: body.page as number } : {}), ...(body.limit !== undefined ? { limit: body.limit as number } : {}) }));
    }
    if (operation === "batch-search" && request.method === "POST") {
      const value = await readJsonLimited(request);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("invalid_queries", "Request body must be an object.");
      const body = value as Record<string, unknown>;
      if (Object.keys(body).some((key) => !["queries", "page", "limit"].includes(key)) || !Array.isArray(body.queries) || (body.page !== undefined && typeof body.page !== "number") || (body.limit !== undefined && typeof body.limit !== "number")) throw new InputError("invalid_queries", "Provide queries and optional numeric page/limit fields.");
      return json(await documents.batchSearch(id!, capability, body.queries as string[], { ...(body.page !== undefined ? { page: body.page as number } : {}), ...(body.limit !== undefined ? { limit: body.limit as number } : {}) }));
    }
    if (operation === "context" && request.method === "POST") {
      const value = await readJsonLimited(request);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("invalid_context", "Request body must be an object.");
      const body = value as Record<string, unknown>;
      if (Object.keys(body).some((key) => !["query", "maxChars", "pages"].includes(key)) || typeof body.query !== "string" || (body.maxChars !== undefined && typeof body.maxChars !== "number") || (body.pages !== undefined && (!Array.isArray(body.pages) || body.pages.some((page) => typeof page !== "number")))) throw new InputError("invalid_context", "Provide query and optional maxChars/pages fields.");
      return json(await documents.prepareContext(id!, capability, body.query, body.maxChars as number | undefined, body.pages as number[] | undefined));
    }
    if (operation === "fields" && request.method === "POST") {
      const value = await readJsonLimited(request);
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value as object).some((key) => key !== "fields") || !Array.isArray((value as Record<string, unknown>).fields)) throw new InputError("invalid_fields", "Provide a JSON object with a fields array.");
      return json(await documents.extractFields(id!, capability, (value as { fields: Array<{ name: string; label: string; page?: number }> }).fields));
    }
    if (operation === "read" && request.method === "POST") {
      const value = await readJsonLimited(request);
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "pages") || !Array.isArray((value as Record<string, unknown>).pages) || ((value as Record<string, unknown>).pages as unknown[]).some((page) => typeof page !== "number")) throw new InputError("invalid_page_selection", "Provide a JSON object with a pages array.");
      return json(await documents.read(id!, capability, (value as { pages: number[] }).pages));
    }
    if (operation === "citation" && request.method === "POST") {
      const value = await readJsonLimited(request);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("invalid_citation", "Request body must be an object.");
      const body = value as Record<string, unknown>;
      if (Object.keys(body).some((key) => !["page", "quote"].includes(key)) || typeof body.page !== "number" || typeof body.quote !== "string") throw new InputError("invalid_citation", "Provide numeric page and string quote.");
      return json(await documents.verifyCitation(id!, capability, body.page, body.quote));
    }
    if (operation === "validate" && request.method === "POST") {
      const value = await readJsonLimited(request);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("invalid_validation", "Request body must be an object.");
      const body = value as Record<string, unknown>;
      if (Object.keys(body).some((key) => !["pageCount", "requiredText"].includes(key)) ||
          (body.pageCount !== undefined && typeof body.pageCount !== "number") ||
          (body.requiredText !== undefined && (!Array.isArray(body.requiredText) || body.requiredText.some((item) => typeof item !== "string")))) throw new InputError("invalid_validation", "Provide optional numeric pageCount and string[] requiredText.");
      return json(await documents.validate(id!, capability, { ...(body.pageCount !== undefined ? { pageCount: body.pageCount as number } : {}), ...(body.requiredText !== undefined ? { requiredText: body.requiredText as string[] } : {}) }));
    }
  } catch (error) { return documentError(error); }
  return json({ error: { code: "method_not_allowed", message: "The method is not supported for this document endpoint." } }, 405);
}

function documentRuntimeUnavailable(): Response {
  return json({ error: { code: "document_runtime_unavailable", message: "Native PDF document operations are available in the local Node.js runtime only." } }, 501);
}

function documentError(error: unknown): Response {
  if (error instanceof DocumentError) return json({ error: { code: error.code, message: error.message } }, error.status);
  if (error instanceof InputError) return json({ error: { code: error.code, message: error.message } }, error.status);
  return json({ error: { code: "document_operation_failed", message: "The PDF document operation could not be completed." } }, 500);
}

function readDocumentCapability(authorization: string | null, alternate: string | null): string | null {
  const match = authorization?.match(/^Bearer\s+([A-Za-z0-9_-]{40,64})$/i);
  return match?.[1] ?? alternate;
}

async function readPdfUpload(request: Request): Promise<Uint8Array | Response> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/pdf") return json({ error: { code: "content_type_required", message: "Upload a raw application/pdf body." } }, 415);
  const encoding = request.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") return json({ error: { code: "content_encoding_unsupported", message: "Compressed PDF uploads are not supported." } }, 415);
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_DOCUMENT_BYTES) return json({ error: { code: "document_too_large", message: `PDF upload exceeds ${MAX_DOCUMENT_BYTES} bytes.` } }, 413);
  if (!request.body) return json({ error: { code: "empty_body", message: "PDF request body is required." } }, 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      await reader.cancel().catch(() => undefined);
      return json({ error: { code: "document_too_large", message: `PDF upload exceeds ${MAX_DOCUMENT_BYTES} bytes.` } }, 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function readJsonLimited(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new InputError("content_type_required", "Send the document as application/json.", 415);
  }
  const encoding = request.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    throw new InputError("content_encoding_unsupported", "Compressed request bodies are not supported.", 415);
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_REQUEST_BYTES) {
    throw new InputError("request_too_large", `Request exceeds ${MAX_REQUEST_BYTES} bytes.`, 413);
  }
  if (!request.body) throw new InputError("empty_body", "Request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new InputError("request_too_large", `Request exceeds ${MAX_REQUEST_BYTES} bytes.`, 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new InputError("invalid_json", "Request body must be valid UTF-8 JSON.", 400);
  }
}

function decodePaymentPayload(header: string): PaymentPayloadV2 {
  if (header.length > 48_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(header) || header.length % 4 !== 0) {
    throw new Error("PAYMENT-SIGNATURE must be a bounded base64-encoded x402 payload.");
  }
  let decoded: string;
  try {
    const binary = atob(header);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("PAYMENT-SIGNATURE is not valid base64 UTF-8.");
  }
  const value: unknown = JSON.parse(decoded);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PAYMENT-SIGNATURE must contain a JSON object.");
  return value as PaymentPayloadV2;
}

function paymentRequiredResponse(runtime: ApiRuntime, resourceUrl: string, error: string, provided?: Record<string, unknown>): Response {
  const required = provided ?? buildPaymentRequired(runtime.service.config.payment, resourceUrl, error);
  if (!required) return json({ error: { code: "payments_unconfigured", message: "Live x402 payment requirements are unavailable." } }, 503);
  return json({ error: { code: "payment_required", message: error || "Payment is required." }, paymentRequired: required }, 402, {
    "payment-required": base64Json(required),
    "cache-control": "no-store",
  });
}

function readCapability(authorization: string | null, alternate: string | null): string | null {
  const match = authorization?.match(/^Bearer\s+([A-Za-z0-9_-]{40,64})$/i);
  return match?.[1] ?? alternate;
}

function base64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function adminDashboardLegacy(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <link rel="icon" href="/favicon.svg?v=focus-1" type="image/svg+xml">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>Task402 stats</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #10131a; color: #eef2f7; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #1b2841, #10131a 52%); }
    main { box-sizing: border-box; width: min(100% - 32px, 760px); margin: 0 auto; padding: 32px 0 48px; }
    p { color: #aab5c6; line-height: 1.5; }
    form, .card, #details { border: 1px solid #2c3a51; border-radius: 16px; background: rgba(20, 27, 39, .88); box-shadow: 0 16px 50px rgba(0,0,0,.22); }
    form { display: grid; gap: 12px; padding: 18px; margin: 24px 0; }
    label { font-weight: 650; }
    input, button { box-sizing: border-box; width: 100%; min-height: 48px; border-radius: 11px; font: inherit; }
    input { border: 1px solid #4a5e7d; background: #0d121b; color: #fff; padding: 0 14px; }
    button { border: 0; background: #5d8dff; color: #08111f; font-weight: 750; cursor: pointer; }
    button:disabled { cursor: wait; opacity: .65; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    #status { min-height: 1.5em; margin: 12px 0; }
    .error { color: #ff9c9c; }
    .success { color: #8ee7bd; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 10px; margin: 16px 0; }
    .card { padding: 15px; }
    .value { display: block; font-size: 1.45rem; font-weight: 750; margin-top: 5px; overflow-wrap: anywhere; }
    .label { color: #aab5c6; font-size: .83rem; }
    #details { display: none; padding: 18px; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 520px; }
    th, td { padding: 10px 8px; text-align: left; border-bottom: 1px solid #2c3a51; white-space: nowrap; }
    th { color: #aab5c6; font-size: .82rem; }
    #dashboard { display: none; }
  </style>
</head>
<body>
  <main>
    <form id="stats-form" autocomplete="off">
      <label class="sr-only" for="password">Password</label>
      <input id="password" name="password" type="password" minlength="1" autocomplete="current-password" placeholder="Password" aria-label="Password" required autofocus>
      <button class="sr-only" id="submit" type="submit" aria-label="Load stats">Load</button>
    </form>
    <p id="status" role="status" aria-live="polite"></p>
    <div id="dashboard">
      <section id="summary" class="grid" aria-label="Summary"></section>
      <section id="details" aria-label="Tool details">
      <h2>By tool</h2>
      <table>
        <thead><tr><th>Tool</th><th>Calls</th><th>Successes</th><th>Errors</th><th>Paid calls</th><th>Avg ms</th><th>Max ms</th></tr></thead>
        <tbody id="tool-rows"></tbody>
      </table>
      </section>
      <section id="traffic" aria-label="Discovery and traffic details">
        <h2>Traffic funnel</h2>
        <table><thead><tr><th>Event</th><th>Calls</th></tr></thead><tbody id="traffic-rows"></tbody></table>
      </section>
    </div>
  </main>
  <script>
    (() => {
      const form = document.getElementById("stats-form");
      const passwordInput = document.getElementById("password");
      const button = document.getElementById("submit");
      const status = document.getElementById("status");
      const summary = document.getElementById("summary");
      const details = document.getElementById("details");
      const rows = document.getElementById("tool-rows");
      const trafficRows = document.getElementById("traffic-rows");
      const dashboard = document.getElementById("dashboard");
      const number = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString() : "—";
      const card = (label, value) => {
        const element = document.createElement("div");
        element.className = "card";
        const name = document.createElement("span"); name.className = "label"; name.textContent = label;
        const amount = document.createElement("span"); amount.className = "value"; amount.textContent = value;
        element.append(name, amount); return element;
      };
      const cell = (value) => { const element = document.createElement("td"); element.textContent = value; return element; };
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const password = passwordInput.value;
        passwordInput.value = "";
        button.disabled = true;
        status.className = "";
        status.textContent = "Loading…";
        summary.replaceChildren(); rows.replaceChildren(); trafficRows.replaceChildren(); dashboard.style.display = "none"; details.style.display = "block";
        try {
          const response = await fetch("/v1/admin/stats?hours=24", { headers: { "X-Stats-Password": password }, cache: "no-store" });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload?.error?.message || "Stats could not be loaded.");
          summary.append(
            card("Calls", number(payload.totalCalls)),
            card("Successes", number(payload.totalSuccesses)),
            card("Errors", number(payload.totalErrors)),
            card("Payment required", number(payload.totalPaymentRequired)),
            card("Paid calls", number(payload.totalSettledCalls)),
            card("USDC atomic units", String(payload.totalSettledAmountAtomic ?? "0")),
            card("Average ms", number(payload.averageDurationMs)),
            card("Maximum ms", number((payload.byTool || []).reduce((max, tool) => Math.max(max, Number(tool.maxDurationMs) || 0), 0)))
          );
          for (const tool of Array.isArray(payload.byTool) ? payload.byTool : []) {
            const row = document.createElement("tr");
            row.append(cell(String(tool.tool ?? "")), cell(number(tool.calls)), cell(number(tool.successes)), cell(number(tool.errors)), cell(number(tool.settledCalls)), cell(number((Number(tool.totalDurationMs) || 0) / (Number(tool.calls) || 1))), cell(number(tool.maxDurationMs)));
            rows.append(row);
          }
          for (const event of Array.isArray(payload.traffic) ? payload.traffic : []) {
            const row = document.createElement("tr");
            row.append(cell(String(event.event ?? "")), cell(number(event.calls)));
            trafficRows.append(row);
          }
          dashboard.style.display = "block";
          details.style.display = "block";
          status.className = "success";
          status.textContent = "Updated just now.";
        } catch (error) {
          status.className = "error";
          status.textContent = error instanceof Error ? error.message : "Stats could not be loaded.";
        } finally { button.disabled = false; }
      });
    })();
  </script>
</body>
</html>`;
  return new Response(html, { status: 200, headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  } });
}

const ADMIN_STYLE = `<style>
:root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; background: #0b0b0b; color: #f4f4ef; --bg: #0b0b0b; --surface: #101010; --surface-2: #151515; --line: #292929; --muted: #92928a; --text: #f4f4ef; --accent: #b7ffbf; --success: #7aff8b; --warning: #ffcf70; --error: #ff7f8a; }
* { box-sizing: border-box; }
body { background: var(--bg) url('/task402-bg.svg') center top/1600px auto no-repeat; color: var(--text); }
body::before { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: -1; opacity: .7; background: radial-gradient(circle at 75% 4%, rgba(71,217,179,.11), transparent 28rem), linear-gradient(180deg, transparent 0 70%, rgba(0,0,0,.52) 100%); }
main { width: min(100% - 48px, 1160px); padding: 22px 0 76px; }
h1 { font-size: 1.5rem; font-weight: 500; letter-spacing: -.05em; }
h2 { font-weight: 500; letter-spacing: -.035em; }
p { color: var(--muted); }
.topbar { min-height: 46px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
.brand { font-weight: 500; letter-spacing: -.04em; }
.mark { display: inline-block; flex: 0 0 22px; width: 22px; height: 22px; border: 0; border-radius: 8px; background: transparent url('/favicon.svg?v=focus-1') center/contain no-repeat; box-shadow: none; }
.live { color: var(--success); font-size: .68rem; letter-spacing: .12em; }
.ghost-action { border-color: rgba(255,255,255,.3); border-radius: 999px; color: var(--text); }
.ghost-action:hover { background: rgba(71,217,179,.08); border-color: var(--accent); }
.auth-shell { min-height: calc(100vh - 150px); }
form { padding: 14px; border: 1px solid rgba(255,255,255,.12); border-radius: 18px; background: rgba(12,15,13,.9); }
input { min-height: 52px; border-color: rgba(255,255,255,.24); border-radius: 999px; background: #0b0b0b; color: var(--text); }
input::placeholder { color: #77776f; }
input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(183,255,191,.12); }
.login-action { min-height: 48px; margin-top: 12px; border-radius: 999px; background: #f3f1e8; color: #0b0b0b; font-weight: 850; }
.dashboard-header { padding: 58px 0 22px; border-bottom-color: var(--line); }
.dashboard-header p { font-size: .8rem; }
.window { color: var(--accent); font-size: .68rem; }
.metric-grid { grid-template-columns: repeat(4, 1fr); gap: 10px; padding: 18px 0; }
.metric, .panel { border-color: rgba(255,255,255,.12); border-radius: 18px; background: rgba(12,15,13,.9); box-shadow: 0 20px 70px rgba(0,0,0,.18); }
.metric { min-height: 122px; padding: 16px; }
.metric.primary { border-color: rgba(71,217,179,.5); background: linear-gradient(145deg, rgba(37,98,82,.45), rgba(12,15,13,.92)); }
.metric-label { color: var(--muted); font-size: .68rem; font-weight: 500; letter-spacing: .12em; }
.metric-value { color: var(--text); font-weight: 500; }
.metric.primary .metric-value { color: var(--accent); }
.metric-detail { color: var(--muted); }
.panel-head { padding: 18px 18px 13px; }
.panel-head p { font-size: .76rem; }
.chart-panel { padding-bottom: 17px; }
.legend { font-size: .7rem; }
.chart-row { grid-template-columns: 170px 1fr 70px; }
.chart-name { font-weight: 500; }
.chart-track { height: 14px; border-radius: 999px; background: #1b2925; }
.chart-segment.success { background: var(--success); }
.chart-segment.warning { background: var(--warning); }
.chart-segment.error { background: var(--error); }
.lower-grid { gap: 10px; }
th, td { border-bottom-color: var(--line); font-family: inherit; }
th { font-weight: 500; }
.tool-name { font-weight: 500; }
.money { color: var(--accent); }
.traffic-bar { background: #1b2925; }
.traffic-fill { background: var(--accent); }
@media (max-width: 560px) { main { width: min(100% - 28px, 1160px); padding-top: 16px; } .dashboard-header { padding-top: 38px; } .metric-grid { gap: 8px; } .metric { min-height: 112px; padding: 13px; } .chart-row { grid-template-columns: minmax(78px, .65fr) minmax(0, 1fr) 42px; } }
</style>`;

function adminDashboard(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <link rel="icon" href="/favicon.svg?v=focus-1" type="image/svg+xml">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>Task402 stats · Operator</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #08111f; color: #eef5ff; --bg: #08111f; --surface: #101c2e; --surface-2: #14243a; --line: #263b58; --muted: #91a5bf; --text: #eef5ff; --accent: #79e7ff; --success: #71e2aa; --warning: #ffd166; --error: #ff8296; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); }
    body::before { content: ""; position: fixed; inset: 0; pointer-events: none; opacity: .35; background: linear-gradient(135deg, rgba(121,231,255,.06), transparent 38%); }
    main { width: min(100% - 32px, 1080px); margin: 0 auto; padding: 22px 0 56px; position: relative; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 1.45rem; letter-spacing: -.025em; }
    h2 { font-size: 1rem; letter-spacing: -.01em; }
    p { color: var(--muted); line-height: 1.5; }
    [hidden] { display: none !important; }
    .topbar, .dashboard-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .topbar { min-height: 42px; color: var(--muted); font-size: .82rem; letter-spacing: .02em; }
    .topbar-actions { display: inline-flex; align-items: center; gap: 12px; }
    .ghost-action { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--accent); font: inherit; font-size: .76rem; cursor: pointer; }
    .ghost-action:hover { background: rgba(121,231,255,.08); }
    .ghost-action:focus-visible { outline: 3px solid rgba(121,231,255,.28); outline-offset: 2px; }
    .brand { display: inline-flex; align-items: center; gap: 9px; color: var(--text); font-weight: 750; }
    .mark { display: inline-block; flex: 0 0 22px; width: 22px; height: 22px; border: 0; border-radius: 8px; background: transparent url('/favicon.svg?v=focus-1') center/contain no-repeat; box-shadow: none; }
    .live { color: var(--success); font-size: .72rem; font-weight: 750; letter-spacing: .12em; }
    .auth-shell { min-height: calc(100vh - 120px); display: grid; place-items: center; }
    form { width: min(100%, 360px); }
    label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    input { width: 100%; min-height: 50px; padding: 0 15px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); color: var(--text); font: inherit; font-size: 1rem; outline: none; }
    input::placeholder { color: #7890ad; }
    input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(121,231,255,.16); }
    .login-action { width: 100%; min-height: 46px; margin-top: 10px; border: 0; border-radius: 11px; background: var(--accent); color: #06121f; font: inherit; font-weight: 800; cursor: pointer; }
    .login-action:hover { filter: brightness(1.05); }
    .login-action:focus-visible { outline: 3px solid rgba(121,231,255,.3); outline-offset: 2px; }
    .login-action:disabled { cursor: wait; opacity: .65; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    #status { min-height: 1.5em; margin: 12px 0 0; font-size: .9rem; }
    .error { color: var(--error); }
    .success { color: var(--success); }
    .dashboard-header { align-items: end; padding: 34px 0 24px; border-bottom: 1px solid var(--line); }
    .dashboard-header p { margin-top: 5px; font-size: .88rem; }
    .window-controls { display: inline-flex; align-items: center; gap: 10px; }
    .window-select { min-height: 34px; padding: 0 30px 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; font-size: .76rem; cursor: pointer; }
    .window-select:focus-visible { outline: 3px solid rgba(121,231,255,.28); outline-offset: 2px; border-color: var(--accent); }
    .window { color: var(--accent); font-size: .78rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; }
    .metric-grid { display: grid; grid-template-columns: 1.45fr repeat(3, 1fr); gap: 10px; padding: 18px 0; }
    .metric { min-height: 122px; padding: 16px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
    .metric.primary { background: var(--surface-2); border-color: #365779; }
    .metric-label { display: block; color: var(--muted); font-size: .78rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .metric-value { display: block; margin-top: 10px; color: var(--text); font-size: 1.7rem; font-weight: 800; letter-spacing: -.035em; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .metric.primary .metric-value { color: var(--accent); font-size: 2.2rem; }
    .metric-detail { display: block; margin-top: 6px; color: var(--muted); font-size: .8rem; font-variant-numeric: tabular-nums; }
    .panel { border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
    .panel-head { display: flex; align-items: start; justify-content: space-between; gap: 14px; padding: 17px 18px 13px; }
    .panel-head p { margin-top: 4px; font-size: .82rem; }
    .chart-panel { padding-bottom: 17px; }
    .legend { display: flex; flex-wrap: wrap; gap: 12px; padding: 0 18px 17px; color: var(--muted); font-size: .76rem; }
    .legend span { display: inline-flex; align-items: center; gap: 6px; }
    .swatch { width: 8px; height: 8px; border-radius: 50%; }
    .swatch.success { background: var(--success); }
    .swatch.warning { background: var(--warning); }
    .swatch.error { background: var(--error); }
    #chart { display: grid; gap: 12px; padding: 0 18px; }
    .chart-row { display: grid; grid-template-columns: 150px 1fr 76px; align-items: center; gap: 12px; min-width: 0; }
    .chart-name, .chart-total { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .8rem; font-variant-numeric: tabular-nums; }
    .chart-name { color: var(--text); font-weight: 650; }
    .chart-total { color: var(--muted); text-align: right; }
    .chart-track { display: flex; height: 15px; min-width: 0; overflow: hidden; border-radius: 5px; background: #1b2c43; }
    .chart-segment { height: 100%; }
    .chart-segment.success { background: var(--success); }
    .chart-segment.warning { background: var(--warning); }
    .chart-segment.error { background: var(--error); }
    .timeline-panel { margin-top: 10px; }
    .timeline-grid { display: flex; align-items: end; gap: 10px; min-height: 214px; overflow-x: auto; padding: 0 18px 18px; }
    .timeline-column { display: flex; flex: 0 0 42px; min-width: 0; height: 194px; flex-direction: column; align-items: center; justify-content: end; gap: 5px; }
    .timeline-value, .timeline-label { color: var(--muted); font-size: .68rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .timeline-label { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
    .timeline-track { display: flex; width: 30px; height: 155px; align-items: end; justify-content: center; border-radius: 5px 5px 2px 2px; background: #1b2c43; }
    .timeline-bar { display: flex; width: 100%; min-height: 3px; flex-direction: column-reverse; overflow: hidden; border-radius: 5px 5px 2px 2px; }
    .timeline-segment { display: block; width: 100%; min-height: 1px; }
    .timeline-segment.success { background: var(--success); }
    .timeline-segment.warning { background: var(--warning); }
    .timeline-segment.error { background: var(--error); }
    .timeline-note { padding: 0 18px 16px; color: var(--muted); font-size: .76rem; }
    .empty { padding: 14px 18px; color: var(--muted); font-size: .85rem; }
    .lower-grid { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(260px, .85fr); gap: 10px; padding-top: 10px; }
    .table-wrap { overflow-x: auto; padding: 0 18px 10px; }
    table { width: 100%; border-collapse: collapse; min-width: 610px; }
    th, td { padding: 11px 8px; border-bottom: 1px solid #21344e; text-align: left; white-space: nowrap; font-size: .8rem; font-variant-numeric: tabular-nums; }
    th { color: var(--muted); font-size: .7rem; font-weight: 750; letter-spacing: .07em; text-transform: uppercase; }
    td { color: var(--text); }
    tr:last-child td { border-bottom: 0; }
    .tool-name { font-weight: 700; }
    .money { color: var(--accent); }
    .traffic-list { display: grid; gap: 13px; padding: 3px 18px 20px; }
    .traffic-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
    .traffic-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: .8rem; }
    .traffic-count { color: var(--text); font-size: .8rem; font-weight: 750; font-variant-numeric: tabular-nums; }
    .traffic-bar { grid-column: 1 / -1; height: 5px; overflow: hidden; border-radius: 4px; background: #1b2c43; }
    .traffic-fill { height: 100%; border-radius: inherit; background: var(--accent); }
    @media (max-width: 820px) { .metric-grid { grid-template-columns: repeat(2, 1fr); } .metric.primary { grid-column: span 2; } .lower-grid { grid-template-columns: 1fr; } }
    @media (max-width: 560px) { main { width: min(100% - 22px, 1080px); padding-top: 13px; } .topbar { align-items: flex-start; } .topbar-actions { flex-wrap: wrap; justify-content: flex-end; } .dashboard-header { flex-direction: column; align-items: flex-start; padding-top: 25px; } .window { align-self: flex-start; } .metric-grid { gap: 8px; } .metric { min-height: 112px; padding: 13px; } .metric-value { font-size: 1.35rem; } .metric.primary .metric-value { font-size: 1.9rem; } .chart-row { grid-template-columns: minmax(78px, .65fr) minmax(0, 1fr) 42px; gap: 7px; } .panel-head { padding-left: 14px; padding-right: 14px; } .legend, #chart, .timeline-grid { padding-left: 14px; padding-right: 14px; } .timeline-grid { grid-template-columns: repeat(auto-fit, minmax(24px, 1fr)); gap: 4px; } .timeline-column { height: 180px; } .timeline-track { height: 142px; } .timeline-note { padding-left: 14px; padding-right: 14px; } .table-wrap { padding-left: 10px; padding-right: 10px; overflow-x: auto; } table { min-width: 610px; table-layout: auto; } th, td { overflow: visible; text-overflow: clip; } }
  </style>${ADMIN_STYLE}
</head>
<body>
  <main>
    <header class="topbar"><div class="brand"><span class="mark" aria-hidden="true"></span><span>Task402 / Operator</span></div><div class="topbar-actions"><span class="live">SECURE VIEW</span></div></header>
    <div id="login-view" class="auth-shell">
      <form id="stats-form" autocomplete="off">
        <label for="password">Operator password</label>
        <input id="password" name="password" type="password" minlength="1" autocomplete="current-password" placeholder="Password" aria-label="Password" required autofocus>
        <button class="login-action" id="submit" type="submit">Log in</button>
      </form>
    </div>
    <p id="status" role="status" aria-live="polite"></p>
    <div id="dashboard" hidden>
      <header class="dashboard-header"><div><h1>Operations overview</h1><p id="window-description">Payment and tool activity from the selected period.</p></div><div class="window-controls"><label class="sr-only" for="window-select">Stats time range</label><select id="window-select" class="window-select"><option value="24">Last 24 hours</option><option value="72" selected>Last 3 days</option><option value="168">Last 7 days</option><option value="720">Last 30 days</option></select><span id="window-label" class="window">Last 3 days</span></div></header>
      <section id="summary" class="metric-grid" aria-label="Summary"></section>
      <section class="panel chart-panel" aria-labelledby="chart-title">
        <div class="panel-head"><div><h2 id="chart-title">Call mix by tool</h2><p>Successful, payment-required, and failed requests.</p></div></div>
        <div class="legend" aria-hidden="true"><span><i class="swatch success"></i>Success</span><span><i class="swatch warning"></i>Payment required</span><span><i class="swatch error"></i>Error</span></div>
        <div id="chart" role="list" aria-describedby="chart-description"></div>
        <p id="chart-description" class="sr-only">Each bar shows the relative call volume for a tool. Colors separate successful, payment-required, and failed requests.</p>
        <p id="chart-empty" class="empty" hidden>No product calls in this window.</p>
      </section>
      <section class="panel timeline-panel" aria-labelledby="timeline-title">
        <div class="panel-head"><div><h2 id="timeline-title">Requests over time</h2><p>Daily history plus hourly UTC volume across all product tools.</p></div></div>
        <div id="timeline-chart" class="timeline-grid" role="list" aria-label="Requests grouped by UTC day and hour" aria-describedby="timeline-description"></div>
        <p id="timeline-description" class="timeline-note">Older totals are grouped by UTC day; newer requests are grouped by UTC hour. Colors separate successes, payment challenges, and errors.</p>
        <p id="timeline-empty" class="empty" hidden>No hourly request data in this window yet.</p>
      </section>
      <div class="lower-grid">
        <section class="panel" aria-labelledby="tools-title"><div class="panel-head"><div><h2 id="tools-title">Tool performance</h2><p>Volume, latency, and settled amount.</p></div></div><div class="table-wrap"><table><thead><tr><th>Tool</th><th>Calls</th><th>Success</th><th>Errors</th><th>Challenges</th><th>Paid</th><th>USDC</th><th>Avg ms</th><th>Max ms</th></tr></thead><tbody id="tool-rows"></tbody></table><p id="tool-empty" class="empty" hidden>No tool activity in this window.</p></div></section>
        <section class="panel" aria-labelledby="traffic-title"><div class="panel-head"><div><h2 id="traffic-title">Discovery funnel</h2><p>How agents reach the service.</p></div></div><div id="traffic-rows" class="traffic-list"></div><p id="traffic-empty" class="empty" hidden>No discovery events in this window.</p></section>
      </div>
    </div>
  </main>
  <script>
    (() => {
      const form = document.getElementById("stats-form");
      form.noValidate = true;
      const loginView = document.getElementById("login-view");
      const passwordInput = document.getElementById("password");
      const button = document.getElementById("submit");
      const status = document.getElementById("status");
      const summary = document.getElementById("summary");
      const chart = document.getElementById("chart");
      const chartEmpty = document.getElementById("chart-empty");
      const timelineChart = document.getElementById("timeline-chart");
      const timelineEmpty = document.getElementById("timeline-empty");
      const rows = document.getElementById("tool-rows");
      const toolEmpty = document.getElementById("tool-empty");
      const trafficRows = document.getElementById("traffic-rows");
      const trafficEmpty = document.getElementById("traffic-empty");
      const dashboard = document.getElementById("dashboard");
      const windowDescription = document.getElementById("window-description");
      const windowLabel = document.getElementById("window-label");
      const windowSelect = document.getElementById("window-select");
      let sessionPassword = "";
      try { sessionPassword = sessionStorage.getItem("task402.stats.password") || ""; } catch { sessionPassword = ""; }
      const number = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-US", { maximumFractionDigits: 1 }) : "—";
      const percent = (value) => Number.isFinite(Number(value)) ? Number(value).toFixed(1) + "%" : "—";
      const money = (atomic) => {
        const text = String(atomic ?? "0");
        if (!/^\\d+$/.test(text)) return "—";
        try {
          const amount = BigInt(text);
          const whole = amount / 1000000n;
          const fraction = (amount % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
          return "$" + whole.toLocaleString("en-US") + (fraction ? "." + fraction : ".00");
        } catch { return "—"; }
      };
      const displayTool = (value) => String(value ?? "").replace(/[_-]+/g, " ");
      const card = (label, value, detail, primary) => {
        const element = document.createElement("div"); element.className = primary ? "metric primary" : "metric";
        const name = document.createElement("span"); name.className = "metric-label"; name.textContent = label;
        const amount = document.createElement("strong"); amount.className = "metric-value"; amount.textContent = value;
        const note = document.createElement("small"); note.className = "metric-detail"; note.textContent = detail;
        element.append(name, amount, note); return element;
      };
      const cell = (value, className) => { const element = document.createElement("td"); element.textContent = value; if (className) element.className = className; return element; };
      const segment = (kind, amount, total, label) => {
        if (!amount) return null;
        const element = document.createElement("span"); element.className = "chart-segment " + kind;
        element.style.width = String((amount / total) * 100) + "%"; element.title = label + ": " + number(amount); return element;
      };
      const renderChart = (tools) => {
        chart.replaceChildren();
        const list = Array.isArray(tools) ? tools.filter((tool) => Number(tool.calls) > 0) : [];
        chartEmpty.hidden = list.length > 0;
        if (!list.length) return;
        const maxCalls = Math.max(...list.map((tool) => Number(tool.calls) || 0), 1);
        for (const tool of list) {
          const calls = Number(tool.calls) || 0; const successes = Number(tool.successes) || 0; const paid = Number(tool.paymentRequired) || 0; const errors = Number(tool.errors) || 0;
          const row = document.createElement("div"); row.className = "chart-row"; row.setAttribute("role", "listitem"); row.setAttribute("aria-label", displayTool(tool.tool) + ": " + number(calls) + " calls, " + number(successes) + " successful, " + number(paid) + " payment required, " + number(errors) + " errors");
          const name = document.createElement("span"); name.className = "chart-name"; name.textContent = displayTool(tool.tool);
          const track = document.createElement("div"); track.className = "chart-track"; track.setAttribute("aria-hidden", "true"); track.style.width = String((calls / maxCalls) * 100) + "%";
          const total = Math.max(calls, 1);
          for (const item of [["success", successes, "Success"], ["warning", paid, "Payment required"], ["error", errors, "Error"]]) { const part = segment(item[0], item[1], total, item[2]); if (part) track.append(part); }
          const totalLabel = document.createElement("span"); totalLabel.className = "chart-total"; totalLabel.textContent = number(calls); row.append(name, track, totalLabel); chart.append(row);
        }
      };
      const renderTraffic = (traffic) => {
        trafficRows.replaceChildren();
        const list = Array.isArray(traffic) ? traffic.filter((event) => Number(event.calls) > 0) : [];
        trafficEmpty.hidden = list.length > 0;
        if (!list.length) return;
        const maxCalls = Math.max(...list.map((event) => Number(event.calls) || 0), 1);
        for (const event of list) {
          const count = Number(event.calls) || 0; const row = document.createElement("div"); row.className = "traffic-row";
          const label = document.createElement("span"); label.className = "traffic-label"; label.textContent = displayTool(event.event);
          const value = document.createElement("span"); value.className = "traffic-count"; value.textContent = number(count);
          const bar = document.createElement("div"); bar.className = "traffic-bar"; const fill = document.createElement("div"); fill.className = "traffic-fill"; fill.style.width = String((count / maxCalls) * 100) + "%"; bar.append(fill);
          row.append(label, value, bar); trafficRows.append(row);
        }
      };
      const renderTimeline = (timeline) => {
        timelineChart.replaceChildren();
        const list = Array.isArray(timeline) ? timeline.filter((bucket) => Number(bucket.calls) > 0) : [];
        timelineEmpty.hidden = list.length > 0;
        if (!list.length) return;
        const maxCalls = Math.max(...list.map((bucket) => Number(bucket.calls) || 0), 1);
        const timeFormatter = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
        const dayFormatter = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
        for (const bucket of list) {
          const calls = Number(bucket.calls) || 0; const successes = Number(bucket.successes) || 0; const paid = Number(bucket.paymentRequired) || 0; const errors = Number(bucket.errors) || 0;
          const isDay = bucket.granularity === "day"; const bucketLabel = isDay ? dayFormatter.format(new Date(bucket.bucketStart)) : timeFormatter.format(new Date(bucket.bucketStart));
          const column = document.createElement("div"); column.className = "timeline-column"; column.setAttribute("role", "listitem"); column.setAttribute("aria-label", bucketLabel + " UTC " + (isDay ? "daily total" : "hour") + ": " + number(calls) + " calls; " + number(successes) + " successful, " + number(paid) + " payment required, " + number(errors) + " errors");
          const value = document.createElement("span"); value.className = "timeline-value"; value.textContent = number(calls);
          const track = document.createElement("div"); track.className = "timeline-track"; track.setAttribute("aria-hidden", "true");
          const bar = document.createElement("div"); bar.className = "timeline-bar"; bar.style.height = String(Math.max(3, (calls / maxCalls) * 155)) + "px";
          for (const item of [["success", successes], ["warning", paid], ["error", errors]]) { if (item[1]) { const segment = document.createElement("span"); segment.className = "timeline-segment " + item[0]; segment.style.height = String((Number(item[1]) / calls) * 100) + "%"; bar.append(segment); } }
          track.append(bar);
          const label = document.createElement("time"); label.className = "timeline-label"; label.dateTime = bucket.bucketStart; label.textContent = bucketLabel;
          column.append(value, track, label); timelineChart.append(column);
        }
      };
      form.addEventListener("submit", async (event) => {
        event.preventDefault(); const password = passwordInput.value || sessionPassword; passwordInput.value = ""; button.disabled = true; status.className = ""; status.textContent = "Loading…";
        if (!password) { status.className = "error"; status.textContent = "Enter the operator password."; button.disabled = false; return; }
        summary.replaceChildren(); rows.replaceChildren(); chart.replaceChildren(); timelineChart.replaceChildren(); trafficRows.replaceChildren(); dashboard.hidden = true;
        try {
          const selectedWindow = windowSelect.options[windowSelect.selectedIndex]; const selectedHours = Number(windowSelect.value) || 72; const response = await fetch("/v1/admin/stats?hours=" + encodeURIComponent(String(selectedHours)), { headers: { "X-Stats-Password": password }, cache: "no-store" }); const payload = await response.json();
          if (!response.ok) throw new Error(payload?.error?.message || "Stats could not be loaded.");
          const since = payload.since ? new Date(payload.since) : null; const generatedAt = payload.generatedAt ? new Date(payload.generatedAt) : null;
          const dateFormatter = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }); const timeFormatter = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
          if (since && !Number.isNaN(since.getTime())) { windowDescription.textContent = "Payment and tool activity since " + dateFormatter.format(since) + " UTC."; windowLabel.textContent = selectedWindow?.textContent || ("Last " + selectedHours + " hours"); }
          if (generatedAt && !Number.isNaN(generatedAt.getTime())) status.dataset.updatedAt = generatedAt.toISOString();
          const calls = Number(payload.totalCalls) || 0; const challenges = Number(payload.totalPaymentRequired) || 0; const finalCalls = Math.max(0, calls - challenges); const successRate = finalCalls ? (Number(payload.totalSuccesses || 0) / finalCalls) * 100 : 0; const paidCalls = Number(payload.totalSettledCalls) || 0;
          const paidConversion = challenges ? (paidCalls / challenges) * 100 : 0; summary.append(card("Total paid", money(payload.totalSettledAmountAtomic), number(paidCalls) + " settled calls", true), card("Calls", number(calls), percent(successRate) + " final success rate"), card("Paid conversion", percent(paidConversion), number(paidCalls) + " settled / " + number(challenges) + " challenges"), card("Payment required", number(challenges), "challenge responses excluded from rate"), card("Average latency", number(payload.averageDurationMs) + " ms", "across all calls"));
          const tools = Array.isArray(payload.byTool) ? payload.byTool : [];
          for (const tool of tools) { const row = document.createElement("tr"); row.append(cell(displayTool(tool.tool), "tool-name"), cell(number(tool.calls)), cell(number(tool.successes)), cell(number(tool.errors)), cell(number(tool.paymentRequired)), cell(number(tool.settledCalls)), cell(money(tool.settledAmountAtomic), "money"), cell(number((Number(tool.totalDurationMs) || 0) / (Number(tool.calls) || 1))), cell(number(tool.maxDurationMs))); rows.append(row); }
          toolEmpty.hidden = tools.length > 0; renderChart(tools); renderTimeline(payload.timeline); renderTraffic(payload.traffic); loginView.hidden = true; dashboard.hidden = false; status.className = "success"; status.textContent = "Updated just now. Password cleared from the field; session retained in this tab.";
          if (generatedAt && !Number.isNaN(generatedAt.getTime())) status.textContent = "Updated " + timeFormatter.format(generatedAt) + " UTC. Password cleared from the field; session retained in this tab.";
          sessionPassword = password; try { sessionStorage.setItem("task402.stats.password", password); } catch {}
        } catch (error) { sessionPassword = ""; try { sessionStorage.removeItem("task402.stats.password"); } catch {} loginView.hidden = false; status.className = "error"; status.textContent = error instanceof Error ? error.message : "Stats could not be loaded."; }
        finally { button.disabled = false; }
      });
      if (sessionPassword) form.requestSubmit();
      windowSelect.addEventListener("change", () => { if (sessionPassword) form.requestSubmit(); });
    })();
  </script>
</body>
</html>`;
  return new Response(html, { status: 200, headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  } });
}

function notFound(): Response {
  return json({ error: { code: "job_not_found", message: "The job does not exist, has expired, or the capability is invalid." } }, 404);
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function json(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
}
