import { D1JobStore, D1PaidToolCallStore, D1PdfDocumentStore, R2ArtifactStore } from "./cloudflare-store.js";
import { CloudflareBrowserRunRenderer, type BrowserRunBinding } from "./cloudflare-renderer.js";
import { handleRequest, type ApiRuntime } from "./api.js";
import { X402SdkGateway } from "./payments.js";
import { PdfService } from "./service.js";
import { MAX_MARKDOWN_BYTES, MAX_PDF_BYTES, JOB_TTL_SECONDS, OPERATION_TIMEOUT_MS } from "./security.js";
import { D1ToolStatsStore } from "./cloudflare-stats.js";
import { PdfDocumentService, DOCUMENT_TTL_SECONDS } from "./pdf-documents.js";
import { CloudflarePdfParser } from "./cloudflare-parser.js";
import { DocumentParserContainer } from "./container.js";
import { PaidToolService } from "./paid-tools.js";

export { DocumentParserContainer } from "./container.js";

interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  BROWSER: BrowserRunBinding;
  PAYMENTS_MODE?: string;
  PRICE_USD?: string;
  PRICE_DOCUMENT_USD?: string;
  PUBLIC_BASE_URL?: string;
  CAPABILITY_SECRET?: string;
  X402_NETWORK?: string;
  X402_ASSET?: string;
  X402_PAY_TO?: string;
  X402_FACILITATOR_URL?: string;
  X402_FACILITATOR_BEARER_TOKEN?: string;
  MCP_ALLOWED_ORIGINS?: string;
  MCP_REGISTRY_AUTH_PUBLIC_KEY?: string;
  JOB_TTL_SECONDS?: string;
  OPERATION_TIMEOUT_MS?: string;
  DOCUMENT_TTL_SECONDS?: string;
  STATS_PASSWORD?: string;
  DOCUMENT_CONTAINER_TOKEN?: string;
  DOCUMENT_PARSER: DurableObjectNamespace<DocumentParserContainer>;
  PRICE_WEB_EVIDENCE_USD?: string;
  PRICE_OPENAPI_USD?: string;
  PRICE_CHAIN_USD?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/mcp-registry-auth" && request.method === "GET" && env.MCP_REGISTRY_AUTH_PUBLIC_KEY) {
      return new Response(env.MCP_REGISTRY_AUTH_PUBLIC_KEY, {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" },
      });
    }
    const runtime = createRuntime(env);
    return handleRequest(request, runtime);
  },

  async scheduled(_event: ScheduledController, env: Env, _context: ExecutionContext): Promise<void> {
    const runtime = createRuntime(env);
    await runtime.service.cleanupExpired(500);
    await runtime.documents?.cleanupExpired(100);
    if (runtime.paidTools) await runtime.paidTools.cleanupExpired(Date.now(), 500);
  },
};

function createRuntime(env: Env): ApiRuntime {
  if (env.PAYMENTS_MODE === "dev-bypass") throw new Error("Worker deployments never permit the local development payment bypass.");
  if (env.PAYMENTS_MODE !== "live") throw new Error("PAYMENTS_MODE=live and complete x402 configuration are required in Worker deployments.");
  if (!env.CAPABILITY_SECRET || env.CAPABILITY_SECRET.length < 32) throw new Error("CAPABILITY_SECRET must be set to at least 32 characters.");
  if (!env.STATS_PASSWORD || env.STATS_PASSWORD.length < 20 || env.STATS_PASSWORD.length > 256) throw new Error("STATS_PASSWORD must be set to between 20 and 256 characters.");
  if (!env.DOCUMENT_CONTAINER_TOKEN || env.DOCUMENT_CONTAINER_TOKEN.length < 32) throw new Error("DOCUMENT_CONTAINER_TOKEN must be set to at least 32 characters.");
  if (!env.PUBLIC_BASE_URL || !/^https:\/\//i.test(env.PUBLIC_BASE_URL)) throw new Error("PUBLIC_BASE_URL must be a trusted HTTPS origin in Worker deployments.");
  if (!env.X402_FACILITATOR_URL || !env.X402_NETWORK || !env.X402_ASSET || !env.X402_PAY_TO) {
    throw new Error("X402_FACILITATOR_URL, X402_NETWORK, X402_ASSET, and X402_PAY_TO must be configured.");
  }

  const payment = new X402SdkGateway({
    mode: "live",
    facilitatorUrl: env.X402_FACILITATOR_URL,
    ...(env.X402_FACILITATOR_BEARER_TOKEN ? { facilitatorBearerToken: env.X402_FACILITATOR_BEARER_TOKEN } : {}),
    network: env.X402_NETWORK,
    asset: env.X402_ASSET,
    payTo: env.X402_PAY_TO,
    priceUsd: env.PRICE_USD ?? "0.01",
    publicBaseUrl: env.PUBLIC_BASE_URL,
  });
  if (payment.mode !== "live") throw new Error("Live x402 configuration is incomplete.");
  const service = new PdfService(
    new D1JobStore(env.DB),
    new R2ArtifactStore(env.ARTIFACTS),
    new CloudflareBrowserRunRenderer(env.BROWSER),
    {
      publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, ""),
      capabilitySecret: env.CAPABILITY_SECRET,
      jobTtlSeconds: readPositiveInt(env.JOB_TTL_SECONDS, JOB_TTL_SECONDS, 7 * 24 * 60 * 60),
      maxMarkdownBytes: MAX_MARKDOWN_BYTES,
      maxPdfBytes: MAX_PDF_BYTES,
      operationTimeoutMs: readPositiveInt(env.OPERATION_TIMEOUT_MS, OPERATION_TIMEOUT_MS, 120_000),
      payment,
    },
  );
  const documentTtlSeconds = readPositiveInt(env.DOCUMENT_TTL_SECONDS, DOCUMENT_TTL_SECONDS, 7 * 24 * 60 * 60);
  const documents = new PdfDocumentService(new D1PdfDocumentStore(env.DB), new R2ArtifactStore(env.ARTIFACTS), {
    capabilitySecret: env.CAPABILITY_SECRET,
    publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, ""),
    parser: new CloudflarePdfParser((request) => env.DOCUMENT_PARSER.getByName("default").fetch(request), env.DOCUMENT_CONTAINER_TOKEN),
    ttlSeconds: documentTtlSeconds,
  });
  return {
    service,
    priceUsd: env.PRICE_USD ?? "0.01",
    documentPriceUsd: env.PRICE_DOCUMENT_USD ?? "0.01",
    paymentMode: payment.mode,
    allowedMcpOrigins: new Set((env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean)),
    documents,
    documentRuntime: "cloudflare-container",
    documentTtlSeconds,
    stats: new D1ToolStatsStore(env.DB),
    paidTools: new PaidToolService(new D1PaidToolCallStore(env.DB), payment, env.PUBLIC_BASE_URL.replace(/\/+$/, ""), documentTtlSeconds * 1000),
    webEvidencePriceUsd: env.PRICE_WEB_EVIDENCE_USD ?? "0.005",
    openApiPriceUsd: env.PRICE_OPENAPI_USD ?? "0.001",
    chainPriceUsd: env.PRICE_CHAIN_USD ?? "0.001",
    ...(env.STATS_PASSWORD ? { statsPassword: env.STATS_PASSWORD } : {}),
  };
}

function readPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Expected a positive integer at or below ${max}.`);
  return value;
}
