import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { x402Client } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const BASE_URL = (process.env.TASK402_BASE_URL ?? "https://task402.xyz").replace(/\/+$/, "");
const NETWORK = "eip155:8453";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0xAEA6fDF13ca10aD6B906884ffAcBb58a0e9E144A";
const AMOUNT = "5000";

const privateKey = process.env.EVM_PRIVATE_KEY?.trim().replace(/^(?:"|'|`)|(?:"|'|`)$/g, "");
if (!privateKey) throw new Error("EVM_PRIVATE_KEY is empty. Enter the wallet's private key at the prompt; never paste it into chat.");
const keyHex = privateKey.replace(/^0x/i, "");
if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error("EVM_PRIVATE_KEY must contain exactly 64 hexadecimal digits, optionally prefixed with 0x. Do not enter a wallet address, password, or recovery phrase.");
if (process.env.TASK402_CONFIRM !== "YES") throw new Error("Set TASK402_CONFIRM=YES after reviewing the $0.005 Base payment terms.");

const account = privateKeyToAccount(`0x${keyHex}` as `0x${string}`);
const idempotencyKey = `web-evidence-test-${crypto.randomUUID()}`;
const args = {
  url: BASE_URL,
  query: "x402",
  max_chars: 4000,
  idempotency_key: idempotencyKey,
};

interface McpResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
  _meta?: Record<string, unknown>;
}

function responseValue(result: McpResult): Record<string, unknown> {
  let value = result.structuredContent;
  if ((!value || typeof value !== "object") && result.content?.[0]?.type === "text") {
    try { value = JSON.parse(result.content[0].text ?? "{}"); } catch { /* reported below */ }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const message = result.content?.find((item) => item.type === "text")?.text ?? "MCP response did not include an object.";
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function paymentRequirements(result: McpResult): PaymentRequired {
  const value = responseValue(result) as Partial<PaymentRequired>;
  if (value.x402Version !== 2 || !Array.isArray(value.accepts) || value.accepts.length === 0) {
    throw new Error("MCP response did not include x402 v2 payment requirements.");
  }
  return value as PaymentRequired;
}

function assertChallenge(required: PaymentRequired): void {
  const accept = required.accepts.find((item) => item.network === NETWORK && item.scheme === "exact");
  if (!accept) throw new Error("The MCP challenge did not offer exact Base Mainnet payment.");
  if (accept.asset.toLowerCase() !== ASSET.toLowerCase()) throw new Error("MCP challenge asset did not match Base USDC.");
  if (accept.amount !== AMOUNT) throw new Error(`MCP challenge amount was ${accept.amount}, expected ${AMOUNT}.`);
  if (accept.payTo.toLowerCase() !== PAY_TO.toLowerCase()) throw new Error("MCP challenge recipient did not match the configured recipient.");
  if (required.resource?.url !== `${BASE_URL}/mcp`) throw new Error("MCP challenge resource did not match the canonical MCP endpoint.");
}

function requireSettlement(result: McpResult): { transaction?: string; network?: string; amount?: string } {
  if (result.isError) {
    const message = result.content?.find((item) => item.type === "text")?.text ?? "Paid web_evidence call failed.";
    throw new Error(message);
  }
  const settlement = result._meta?.["x402/payment-response"];
  if (!settlement || typeof settlement !== "object" || Array.isArray(settlement)) throw new Error("Paid response did not include a settlement receipt.");
  const receipt = settlement as { transaction?: unknown; network?: unknown; amount?: unknown };
  if (typeof receipt.transaction !== "string" || receipt.transaction.length === 0) throw new Error("Settlement receipt did not include a transaction hash.");
  return {
    transaction: receipt.transaction,
    ...(typeof receipt.network === "string" ? { network: receipt.network } : {}),
    ...(typeof receipt.amount === "string" ? { amount: receipt.amount } : {}),
  };
}

const mcp = new Client({ name: "task402-live-web-evidence-test", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL("/mcp", BASE_URL));

try {
  await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);
  const listed = await mcp.listTools();
  if (!listed.tools.some((tool) => tool.name === "web_evidence")) throw new Error("MCP server did not advertise web_evidence.");

  const challenge = await mcp.callTool({ name: "web_evidence", arguments: args }) as unknown as McpResult;
  const required = paymentRequirements(challenge);
  assertChallenge(required);

  console.log(JSON.stringify({
    stage: "agent_discovery_and_challenge_verified",
    payer: account.address,
    tool: "web_evidence",
    network: NETWORK,
    asset: ASSET,
    amountAtomic: AMOUNT,
    amountUsd: "0.005",
    payTo: PAY_TO,
    idempotencyKey,
  }));

  const paymentClient = new x402Client().register(NETWORK, new ExactEvmScheme(account));
  const payment = await paymentClient.createPaymentPayload(required);
  const paid = await mcp.callTool({ name: "web_evidence", arguments: args, _meta: { "x402/payment": payment } }) as unknown as McpResult;
  const value = responseValue(paid);
  const settlement = requireSettlement(paid);
  const text = typeof value.text === "string" ? value.text : "";

  console.log(JSON.stringify({
    stage: "agent_paid_tool_settled",
    tool: "web_evidence",
    sourceHash: typeof value.sourceHash === "string" ? value.sourceHash : undefined,
    evidenceChars: text.length,
    transaction: settlement.transaction,
    settlementNetwork: settlement.network,
    settlementAmountAtomic: settlement.amount,
    note: "The payment payload and web evidence content were not printed.",
  }));
} finally {
  await mcp.close();
}
