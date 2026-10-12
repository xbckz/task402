import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { resolve } from "node:path";
import { FileArtifactStore, SqliteJobStore, SqlitePaidToolCallStore, SqlitePdfDocumentStore } from "./local-store.js";
import { ChromiumPdfRenderer } from "./local-renderer.js";
import { handleRequest } from "./api.js";
import { X402SdkGateway, makeDevBypassGateway } from "./payments.js";
import { PdfService } from "./service.js";
import { MAX_MARKDOWN_BYTES, MAX_PDF_BYTES, JOB_TTL_SECONDS, OPERATION_TIMEOUT_MS, isAllowedLocalHost } from "./security.js";
import type { ApiRuntime } from "./api.js";
import { PdfDocumentService, DOCUMENT_TTL_SECONDS } from "./pdf-documents.js";
import { LocalPdfParser } from "./local-pdf-parser.js";
import { SqliteToolStatsStore } from "./local-stats.js";
import { PaidToolService } from "./paid-tools.js";
import { isPrivateIpAddress, type PublicHostResolver } from "./agent-tools.js";

const root = process.cwd();
loadVars(resolve(root, ".dev.vars"));

const port = positiveInteger(process.env.PORT, 8787, 65535);
const host = "127.0.0.1";
const mode = process.env.PAYMENTS_MODE ?? "unconfigured";
if (mode === "dev-bypass" && process.env.NODE_ENV === "production") {
  throw new Error("The local development payment bypass cannot run with NODE_ENV=production.");
}
if (mode !== "dev-bypass" && mode !== "live" && mode !== "unconfigured") {
  throw new Error("PAYMENTS_MODE must be dev-bypass, live, or unset.");
}

if (mode === "live" && (!process.env.PUBLIC_BASE_URL || !/^https:\/\//i.test(process.env.PUBLIC_BASE_URL))) {
  throw new Error("PAYMENTS_MODE=live on the local runner requires PUBLIC_BASE_URL to be an HTTPS URL routed to this loopback listener.");
}
if (mode === "live" && (!process.env.CAPABILITY_SECRET || process.env.CAPABILITY_SECRET.length < 32)) {
  throw new Error("CAPABILITY_SECRET must be explicitly set to at least 32 characters in live mode.");
}
const payment = mode === "dev-bypass"
  ? makeDevBypassGateway()
  : new X402SdkGateway({
      mode,
      facilitatorUrl: process.env.X402_FACILITATOR_URL,
      facilitatorBearerToken: process.env.X402_FACILITATOR_BEARER_TOKEN,
      network: process.env.X402_NETWORK,
      asset: process.env.X402_ASSET,
      payTo: process.env.X402_PAY_TO,
      priceUsd: process.env.PRICE_USD ?? "0.01",
      ...(mode === "live" ? { publicBaseUrl: process.env.PUBLIC_BASE_URL! } : {}),
    });

if (mode === "live" && payment.mode !== "live") {
  throw new Error("PAYMENTS_MODE=live requires the complete x402 facilitator, network, asset, recipient, and price configuration.");
}
const capabilitySecret = process.env.CAPABILITY_SECRET ?? "local-development-secret-change-me-at-least-32-characters";
if (capabilitySecret.length < 32) throw new Error("CAPABILITY_SECRET must contain at least 32 characters.");

const service = new PdfService(
  new SqliteJobStore(process.env.LOCAL_DB_PATH ?? ".data/jobs.sqlite"),
  new FileArtifactStore(process.env.LOCAL_ARTIFACT_DIR ?? ".data/objects"),
  new ChromiumPdfRenderer(),
  {
    publicBaseUrl: mode === "live" ? process.env.PUBLIC_BASE_URL!.replace(/\/+$/, "") : `http://${host}:${port}`,
    capabilitySecret,
    jobTtlSeconds: positiveInteger(process.env.JOB_TTL_SECONDS, JOB_TTL_SECONDS, 7 * 24 * 60 * 60),
    maxMarkdownBytes: MAX_MARKDOWN_BYTES,
    maxPdfBytes: MAX_PDF_BYTES,
    operationTimeoutMs: positiveInteger(process.env.OPERATION_TIMEOUT_MS, OPERATION_TIMEOUT_MS, 120_000),
    payment,
  },
);
const documentsEnabled = process.env.NODE_ENV !== "production" && mode !== "live";
const documentStore = documentsEnabled ? new SqlitePdfDocumentStore(process.env.LOCAL_DOCUMENT_DB_PATH ?? ".data/documents.sqlite") : null;
const documentArtifacts = documentsEnabled ? new FileArtifactStore(process.env.LOCAL_DOCUMENT_ARTIFACT_DIR ?? ".data/document-objects") : null;
const documentTtlSeconds = positiveInteger(process.env.DOCUMENT_TTL_SECONDS, DOCUMENT_TTL_SECONDS, 7 * 24 * 60 * 60);
const documents = documentStore && documentArtifacts ? new PdfDocumentService(documentStore, documentArtifacts, {
  capabilitySecret,
  publicBaseUrl: mode === "live" ? process.env.PUBLIC_BASE_URL!.replace(/\/+$/, "") : `http://${host}:${port}`,
  parser: new LocalPdfParser(),
  ttlSeconds: documentTtlSeconds,
}) : null;
const stats = new SqliteToolStatsStore(process.env.LOCAL_STATS_DB_PATH ?? ".data/stats.sqlite");
const paidToolStore = new SqlitePaidToolCallStore(process.env.LOCAL_PAID_TOOLS_DB_PATH ?? ".data/paid-tools.sqlite");
if (process.env.STATS_PASSWORD && (process.env.STATS_PASSWORD.length < 20 || process.env.STATS_PASSWORD.length > 256)) {
  throw new Error("STATS_PASSWORD must contain between 20 and 256 characters when configured.");
}
const resolvePublicHost: PublicHostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  const values = addresses.map((entry) => entry.address);
  if (values.some(isPrivateIpAddress)) throw new Error("Private DNS destination.");
  return values;
};
const runtime: ApiRuntime = {
  service,
  priceUsd: process.env.PRICE_USD ?? "0.01",
  documentPriceUsd: process.env.PRICE_DOCUMENT_USD ?? "0.01",
  paymentMode: payment.mode,
  allowedMcpOrigins: new Set<string>([`http://${host}:${port}`, ...(process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((origin: string) => origin.trim()).filter(Boolean)]),
  ...(documents ? { documents } : {}),
  documentRuntime: documents ? "node-local" : "unavailable",
  documentTtlSeconds,
  stats,
  ...(process.env.STATS_PASSWORD ? { statsPassword: process.env.STATS_PASSWORD } : {}),
  paidTools: new PaidToolService(paidToolStore, payment, mode === "live" ? process.env.PUBLIC_BASE_URL!.replace(/\/+$/, "") : `http://${host}:${port}`, documentTtlSeconds * 1000),
  webEvidencePriceUsd: process.env.PRICE_WEB_EVIDENCE_USD ?? "0.005",
  openApiPriceUsd: process.env.PRICE_OPENAPI_USD ?? "0.001",
  chainPriceUsd: process.env.PRICE_CHAIN_USD ?? "0.001",
  webHostResolver: resolvePublicHost,
};

const cleanup = async (): Promise<void> => {
  await service.cleanupExpired(100).catch(() => undefined);
  await documents?.cleanupExpired(100).catch(() => undefined);
  await paidToolStore.cleanupExpired(Date.now(), 100).catch(() => undefined);
};
void cleanup();
const retentionCleanup = setInterval(() => void cleanup(), 60 * 60 * 1000);

const server = createServer(async (incoming, outgoing) => {
  try {
    if (!isAllowedLocalHost(incoming.headers.host, port, mode === "live" ? process.env.PUBLIC_BASE_URL : undefined)) {
      outgoing.writeHead(403, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
      outgoing.end(JSON.stringify({ error: { code: "host_not_allowed", message: "Request Host is not allowed." } }));
      return;
    }
    const request = await toWebRequest(incoming, host, port);
    const response = await handleRequest(request, runtime);
    await writeWebResponse(response, outgoing);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error.";
    const status = message === "Request body is too large." ? 413 : 500;
    outgoing.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
    outgoing.end(JSON.stringify({ error: { code: status === 413 ? "request_too_large" : "internal_error", message: status === 413 ? message : "Request failed." } }));
  }
});

server.listen(port, host, () => {
  process.stdout.write(`x402 PDF local API listening at http://${host}:${port}\n`);
  process.stdout.write(`payments=${payment.mode}; renderer=Playwright Chromium; data=${resolve(".data")}\n`);
});

server.on("close", () => {
  clearInterval(retentionCleanup);
  if (service.jobs instanceof SqliteJobStore) service.jobs.close();
  documentStore?.close();
  stats.close();
  paidToolStore.close();
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));

async function toWebRequest(incoming: IncomingMessage, host: string, port: number): Promise<Request> {
  const method = incoming.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const url = `http://${host}:${port}${incoming.url ?? "/"}`;
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });

  const chunks: Buffer[] = [];
  let total = 0;
  const maxBodyBytes = (incoming.url ?? "").split("?")[0] === "/v1/documents" ? 20 * 1024 * 1024 : 300_000;
  // Preserve the socket long enough to write a 413, then close the connection.
  for await (const chunk of incoming.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBodyBytes) throw new Error("Request body is too large.");
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks);
  return new Request(url, { method, headers, body: body.byteLength ? body : undefined });
}

async function writeWebResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) outgoing.end(Buffer.from(await response.arrayBuffer()));
  else outgoing.end();
}

function loadVars(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    if (process.env[key] !== undefined) continue;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function positiveInteger(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Expected a positive integer at or below ${max}.`);
  return value;
}
