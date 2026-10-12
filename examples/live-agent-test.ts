import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { x402Client } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const BASE_URL = process.env.TASK402_BASE_URL ?? "https://task402.xyz";
const NETWORK = "eip155:8453";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0xAEA6fDF13ca10aD6B906884ffAcBb58a0e9E144A";
const AMOUNT = "10000";
const privateKey = process.env.EVM_PRIVATE_KEY?.trim().replace(/^(?:"|'|`)|(?:"|'|`)$/g, "");

if (!privateKey) throw new Error("EVM_PRIVATE_KEY is empty. Enter the wallet's private key at the prompt; never paste it into chat.");
const keyHex = privateKey.replace(/^0x/i, "");
const normalizedPrivateKey = `0x${keyHex}`;
if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error("EVM_PRIVATE_KEY must contain exactly 64 hexadecimal digits, optionally prefixed with 0x. Do not enter a wallet address, password, or recovery phrase.");
if (process.env.TASK402_CONFIRM !== "YES") {
  throw new Error("Set TASK402_CONFIRM=YES after reviewing the $0.01 Base payment terms.");
}

const account = privateKeyToAccount(normalizedPrivateKey as `0x${string}`);

const input = {
  title: "Task402 live agent test",
  markdown: "# Paid agent smoke test\n\nThis request used MCP discovery and x402 payment handling.",
};
const idempotencyKey = `agent-test-${crypto.randomUUID()}`;
const args = { ...input, idempotency_key: idempotencyKey };

interface McpResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}

interface Job {
  jobId: string;
  state: string;
  capability: string;
  statusUrl: string;
  downloadUrl: string;
}

function readRequired(result: McpResult): PaymentRequired {
  let value = result.structuredContent;
  if ((!value || typeof value !== "object") && result.content?.[0]?.type === "text") {
    try { value = JSON.parse(result.content[0].text ?? "{}"); } catch { /* reported below */ }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP response did not include payment requirements.");
  const required = value as Partial<PaymentRequired>;
  if (required.x402Version !== 2 || !Array.isArray(required.accepts) || required.accepts.length === 0) {
    throw new Error("MCP response did not include x402 v2 payment requirements.");
  }
  return required as PaymentRequired;
}

function readJob(result: McpResult): Job {
  if (result.isError || !result.structuredContent || typeof result.structuredContent !== "object") {
    const message = result.content?.find((item) => item.type === "text")?.text ?? "MCP paid tool call failed.";
    try {
      const value = JSON.parse(message) as { error?: unknown };
      if (value.error === "address_not_registered") throw new Error("The facilitator rejected the configured payTo recipient as unregistered. No settlement occurred; register the recipient or choose a facilitator that does not require whitelisting.");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The facilitator rejected")) throw error;
    }
    throw new Error(message);
  }
  const job = result.structuredContent as Partial<Job>;
  if (!job.jobId || !job.capability || !job.statusUrl || !job.downloadUrl) throw new Error("MCP response did not include a complete PDF job.");
  return job as Job;
}

const mcp = new Client({ name: "task402-live-agent-test", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL("/mcp", BASE_URL));

try {
  await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);
  const listed = await mcp.listTools();
  if (!listed.tools.some((tool) => tool.name === "generate_pdf")) throw new Error("MCP server did not advertise generate_pdf.");

  const challenge = await mcp.callTool({ name: "generate_pdf", arguments: args }) as unknown as McpResult;
  const required = readRequired(challenge);
  const accept = required.accepts.find((item) => item.network === NETWORK && item.scheme === "exact");
  if (!accept) throw new Error("The MCP challenge did not offer exact Base Mainnet payment.");
  if (accept.asset.toLowerCase() !== ASSET.toLowerCase()) throw new Error("MCP challenge asset did not match Base USDC.");
  if (accept.amount !== AMOUNT) throw new Error(`MCP challenge amount was ${accept.amount}, expected ${AMOUNT}.`);
  if (accept.payTo.toLowerCase() !== PAY_TO.toLowerCase()) throw new Error("MCP challenge recipient did not match the configured recipient.");
  if (required.resource?.url !== `${BASE_URL}/mcp`) throw new Error("MCP challenge resource did not match the canonical MCP endpoint.");

  console.log(JSON.stringify({
    stage: "agent_discovery_and_challenge_verified",
    payer: account.address,
    tools: listed.tools.map((tool) => tool.name),
    network: NETWORK,
    asset: ASSET,
    amountAtomic: AMOUNT,
    amountUsd: "0.01",
    payTo: PAY_TO,
    idempotencyKey,
  }));

  const paymentClient = new x402Client().register(NETWORK, new ExactEvmScheme(account));
  const payment = await paymentClient.createPaymentPayload(required);
  const paid = await mcp.callTool({
    name: "generate_pdf",
    arguments: args,
    _meta: { "x402/payment": payment },
  }) as unknown as McpResult;
  const job = readJob(paid);

  const statusResult = await mcp.callTool({
    name: "get_pdf_job",
    arguments: { job_id: job.jobId, capability: job.capability },
  }) as unknown as McpResult;
  const status = statusResult.structuredContent as { state?: string; settlement?: { transaction?: string; network?: string; amount?: string } } | undefined;
  if (!status || status.state !== "complete" || !status.settlement?.transaction) throw new Error("MCP job status did not confirm settlement.");

  const download = await fetch(job.downloadUrl, { headers: { authorization: `Bearer ${job.capability}` }, redirect: "error" });
  if (!download.ok) throw new Error(`PDF download returned HTTP ${download.status}.`);
  const pdf = new Uint8Array(await download.arrayBuffer());
  if (pdf.length < 5 || String.fromCharCode(...pdf.slice(0, 5)) !== "%PDF-") throw new Error("Downloaded artifact was not a PDF.");
  const outputDir = join(process.cwd(), "out");
  const outputPath = join(outputDir, "task402-live-agent-test.pdf");
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, pdf);

  console.log(JSON.stringify({
    stage: "agent_paid_call_settled",
    jobId: job.jobId,
    state: status.state,
    transaction: status.settlement.transaction,
    settlementNetwork: status.settlement.network,
    settlementAmountAtomic: status.settlement.amount,
    pdfBytes: pdf.length,
    pdfPath: outputPath,
    note: "The payment payload and capability were not printed.",
  }));
} finally {
  await mcp.close();
}
