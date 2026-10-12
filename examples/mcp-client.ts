import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PaymentPayloadV2 } from "../src/types.js";

export interface PaymentRequired {
  x402Version: 2;
  resource?: { url?: string; [key: string]: unknown };
  accepts: Array<Record<string, unknown>>;
}

/** Implement this with a hardware wallet, HSM, KMS, or separately sandboxed signer. */
export interface ApprovedWallet {
  createPayment(challenge: PaymentRequired, idempotencyKey: string): Promise<PaymentPayloadV2>;
}

interface McpResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
  _meta?: Record<string, unknown>;
}

interface PdfJob {
  jobId: string;
  capability: string;
  state: string;
  statusUrl: string;
  downloadUrl: string;
  expiresAt: string;
}

/**
 * Example x402/MCP client. `wallet` is deliberately injected: this file never
 * reads a private key or stores signing material in the MCP process.
 */
export async function generatePaidPdf(
  serverUrl: string,
  document: { title: string; markdown: string },
  wallet: ApprovedWallet,
  idempotencyKey: string,
): Promise<PdfJob> {
  const client = new Client({ name: "x402-pdf-example", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", serverUrl));
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);

  try {
    const args = { ...document, idempotency_key: idempotencyKey };
    const challengeResult = await client.callTool({ name: "generate_pdf", arguments: args }) as unknown as McpResult;
    if (!challengeResult.isError) throw new Error("Expected the live service to request payment.");

    const challenge = readPaymentRequired(challengeResult);
    const payment = await wallet.createPayment(challenge, idempotencyKey);
    const paidResult = await client.callTool({
      name: "generate_pdf",
      arguments: args,
      _meta: { "x402/payment": payment },
    }) as unknown as McpResult;
    if (paidResult.isError) throw new Error(`PDF job failed: ${readText(paidResult)}`);
    if (!paidResult.structuredContent || typeof paidResult.structuredContent !== "object") {
      throw new Error("MCP server returned no structured PDF job result.");
    }
    const job = paidResult.structuredContent as PdfJob;
    if (!job.capability || !job.downloadUrl || !job.jobId) throw new Error("MCP server returned an incomplete PDF job result.");
    return job;
  } finally {
    await client.close();
  }
}

/** Keep the capability in memory and send it only to the returned trusted URL. */
export async function downloadPdf(job: PdfJob, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  const response = await fetcher(job.downloadUrl, {
    headers: { authorization: `Bearer ${job.capability}` },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`PDF download failed with HTTP ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

function readPaymentRequired(result: McpResult): PaymentRequired {
  let value = result.structuredContent;
  if ((!value || typeof value !== "object") && result.content?.[0]?.type === "text") {
    try { value = JSON.parse(result.content[0].text ?? "{}"); } catch { /* reported below */ }
  }
  if (!value || typeof value !== "object") throw new Error("MCP response did not include x402 payment terms.");
  const required = value as Partial<PaymentRequired>;
  if (required.x402Version !== 2 || !Array.isArray(required.accepts) || required.accepts.length === 0) {
    throw new Error("MCP response did not include supported x402 v2 payment terms.");
  }
  return required as PaymentRequired;
}

function readText(result: McpResult): string {
  return result.content?.find((item) => item.type === "text")?.text ?? "Unknown MCP error.";
}
