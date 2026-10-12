import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
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

const body = {
  title: "Task402 live terminal test",
  markdown: "# Paid smoke test\n\nOne controlled x402 payment from the terminal.",
};
const bodyText = JSON.stringify(body);
const idempotencyKey = `terminal-test-${randomUUID()}`;

const client = new x402Client().register(NETWORK, new ExactEvmScheme(account));
const httpClient = new x402HTTPClient(client);

const unpaid = await fetch(`${BASE_URL}/v1/pdf`, {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
  body: bodyText,
});
const unpaidBody = await unpaid.json() as Record<string, unknown>;
if (unpaid.status !== 402) throw new Error(`Expected HTTP 402 challenge, received ${unpaid.status}.`);

const required = httpClient.getPaymentRequiredResponse(
  (name) => unpaid.headers.get(name),
  unpaidBody,
);
const accept = required.accepts.find((item) => item.network === NETWORK && item.scheme === "exact");
if (!accept) throw new Error("The challenge did not offer exact Base Mainnet payment.");
if (accept.asset.toLowerCase() !== ASSET.toLowerCase()) throw new Error("Challenge asset did not match Base USDC.");
if (accept.amount !== AMOUNT) throw new Error(`Challenge amount was ${accept.amount}, expected ${AMOUNT}.`);
if (accept.payTo.toLowerCase() !== PAY_TO.toLowerCase()) throw new Error("Challenge recipient did not match the configured recipient.");
if (required.resource?.url !== `${BASE_URL}/v1/pdf`) throw new Error("Challenge resource URL did not match /v1/pdf.");

console.log(JSON.stringify({
  stage: "challenge_verified",
  payer: account.address,
  network: NETWORK,
  asset: ASSET,
  amountAtomic: AMOUNT,
  amountUsd: "0.01",
  payTo: PAY_TO,
  idempotencyKey,
}));

const payment = await httpClient.createPaymentPayload(required);
const paid = await fetch(`${BASE_URL}/v1/pdf`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    ...httpClient.encodePaymentSignatureHeader(payment),
  },
  body: bodyText,
});
const paidBody = await paid.json() as Record<string, unknown>;
if (paid.status !== 201 && paid.status !== 200) {
  const errorMessage = typeof (paidBody.error as Record<string, unknown> | undefined)?.message === "string"
    ? String((paidBody.error as Record<string, unknown>).message)
    : "paid request failed";
  throw new Error(`Paid request returned HTTP ${paid.status}: ${errorMessage}`);
}

const job = paidBody as {
  jobId?: string;
  state?: string;
  capability?: string;
  downloadUrl?: string;
  settlement?: { transaction?: string; network?: string; amount?: string };
};
if (!job.jobId || !job.capability || !job.downloadUrl) throw new Error("Paid response did not include a complete job capability.");
const settlement = job.settlement ?? (() => {
  try { return httpClient.getPaymentSettleResponse((name) => paid.headers.get(name)); }
  catch { return undefined; }
})();
if (!settlement?.transaction) throw new Error("Paid response did not include a settlement transaction.");

const download = await fetch(job.downloadUrl, {
  headers: { authorization: `Bearer ${job.capability}` },
  redirect: "error",
});
if (!download.ok) throw new Error(`PDF download returned HTTP ${download.status}.`);
const pdf = new Uint8Array(await download.arrayBuffer());
if (pdf.length < 5 || String.fromCharCode(...pdf.slice(0, 5)) !== "%PDF-") throw new Error("Downloaded artifact was not a PDF.");
const outDir = join(process.cwd(), "out");
await mkdir(outDir, { recursive: true });
const outputPath = join(outDir, "task402-live-test.pdf");
await writeFile(outputPath, pdf);

console.log(JSON.stringify({
  stage: "settled",
  status: paid.status,
  jobId: job.jobId,
  state: job.state,
  transaction: settlement.transaction,
  settlementNetwork: settlement.network,
  settlementAmountAtomic: settlement.amount,
  pdfBytes: pdf.length,
  pdfPath: outputPath,
  note: "The capability and payment payload were not printed.",
}));
