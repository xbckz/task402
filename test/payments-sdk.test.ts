import assert from "node:assert/strict";
import test from "node:test";
import { X402SdkGateway } from "../src/payments.js";
import { FakeGateway, PAYER, paymentPayload } from "./helpers.js";
import { x402Client } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const ENDPOINT = "https://facilitator.example.test";
const config = {
  mode: "live" as const,
  facilitatorUrl: ENDPOINT,
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x1111111111111111111111111111111111111111",
  priceUsd: "0.01",
  publicBaseUrl: "https://pdf.example.test",
};

test("Base mainnet payment payload uses the canonical USD Coin EIP-712 domain", async () => {
  const gateway = new X402SdkGateway({
    ...config,
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  });
  const account = privateKeyToAccount(`0x${"11".repeat(32)}` as `0x${string}`);
  const requirements = gateway.requirements! as unknown as import("@x402/core/types").PaymentRequirements;
  const required: PaymentRequired = {
    x402Version: 2,
    accepts: [requirements],
    resource: { url: "mcp://tool/generate_pdf" },
  };
  const payload = await new x402Client().register("eip155:8453", new ExactEvmScheme(account)).createPaymentPayload(required);
  const authorization = payload.payload.authorization as {
    from: `0x${string}`;
    to: `0x${string}`;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
  };
  const canonicalSignature = await account.signTypedData({
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: requirements.asset as `0x${string}`,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  assert.equal(gateway.requirements!.extra.name, "USD Coin");
  assert.equal(payload.payload.signature, canonicalSignature);
});

test("live payment URLs require an exact HTTPS public origin and valid facilitator URL", () => {
  for (const publicBaseUrl of ["https://", "https://user:pass@example.test", "https://pdf.example.test/path", "https://pdf.example.test?q=1", "https://pdf.example.test#fragment", "http://pdf.example.test"]) {
    assert.throws(() => new X402SdkGateway({ ...config, publicBaseUrl }));
  }
  assert.throws(() => new X402SdkGateway({ ...config, facilitatorUrl: "https://" }));
  assert.doesNotThrow(() => new X402SdkGateway({ ...config, facilitatorUrl: `${ENDPOINT}/api` }));
});

test("malformed or mismatched facilitator successes remain uncertain", async () => {
  const originalFetch = globalThis.fetch;
  const gateway = new X402SdkGateway(config);
  const valid = { success: true, transaction: `0x${"55".repeat(32)}`, network: config.network };
  try {
    for (const overrides of [{ success: "yes" }, { transaction: "" }, { network: "eip155:1" }, { amount: "1" }, { payer: config.payTo }]) {
      globalThis.fetch = async () => Response.json({ ...valid, ...overrides });
      await assert.rejects(gateway.settle(paymentPayload(), gateway.requirements!), (error: unknown) => error instanceof Error && !("definitiveSettlementFailure" in error && error.definitiveSettlementFailure));
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("official SDK structured non-2xx verification failure becomes an invalid payment response", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), `${ENDPOINT}/verify`);
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ isValid: false, invalidReason: "invalid_exact_evm_payload_signature", invalidMessage: "bad signature" }, { status: 400 });
  };
  try {
    const gateway = new X402SdkGateway(config);
    const result = await gateway.verify(paymentPayload(), gateway.requirements!);
    assert.equal(result.isValid, false);
    assert.match(result.reason ?? "", /invalid_exact_evm_payload_signature/);
    assert.ok(requestBody?.paymentPayload);
  } finally { globalThis.fetch = originalFetch; }
});

test("official SDK marks terminal facilitator balance failures as definitive", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    success: false,
    errorReason: "invalid_exact_evm_insufficient_balance",
    errorMessage: "payer cannot cover the authorization",
  }, { status: 400 });
  try {
    const gateway = new X402SdkGateway(config);
    await assert.rejects(gateway.settle(paymentPayload(), gateway.requirements!), (error: unknown) =>
      !!error && typeof error === "object" && "definitiveSettlementFailure" in error &&
      (error as { definitiveSettlementFailure?: boolean }).definitiveSettlementFailure === true);
  } finally { globalThis.fetch = originalFetch; }
});

test("official SDK classifies legacy plain facilitator terminal errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: "address_not_registered" }, { status: 400 });
  try {
    const gateway = new X402SdkGateway(config);
    await assert.rejects(gateway.settle(paymentPayload(), gateway.requirements!), (error: unknown) =>
      !!error && typeof error === "object" && "definitiveSettlementFailure" in error &&
      (error as { definitiveSettlementFailure?: boolean }).definitiveSettlementFailure === true &&
      (error as { errorReason?: string }).errorReason === "address_not_registered");
  } finally { globalThis.fetch = originalFetch; }
});

test("official SDK retries a pending settlement once to reconcile the broadcast transaction", async () => {
  const originalFetch = globalThis.fetch;
  const gateway = new X402SdkGateway(config);
  const payload = paymentPayload();
  const requirements = gateway.requirements!;
  let settleCalls = 0;
  try {
    globalThis.fetch = async () => Response.json({
      success: false,
      errorReason: "invalid_exact_evm_payload_signature",
      errorMessage: "bad signature",
    }, { status: 400 });
    await assert.rejects(gateway.settle(payload, requirements), (error: unknown) =>
      !!error && typeof error === "object" && "definitiveSettlementFailure" in error &&
      (error as { definitiveSettlementFailure?: boolean }).definitiveSettlementFailure === true);

    globalThis.fetch = async () => {
      settleCalls++;
      return settleCalls === 1
        ? Response.json({
            success: false,
            errorReason: "settlement_pending",
            errorMessage: "transaction pending",
            transaction: `0x${"44".repeat(32)}`,
            network: "eip155:84532",
          }, { status: 409 })
        : Response.json({
            success: true,
            transaction: `0x${"44".repeat(32)}`,
            network: "eip155:84532",
            payer: PAYER,
            amount: "10000",
          });
    };
    const reconciled = await gateway.settle(payload, requirements);
    assert.equal(settleCalls, 2);
    assert.equal(reconciled.transaction, `0x${"44".repeat(32)}`);

    settleCalls = 0;
    globalThis.fetch = async () => {
      settleCalls++;
      return Response.json({
        success: false,
        errorReason: "settlement_pending",
        errorMessage: "transaction pending",
        transaction: `0x${"44".repeat(32)}`,
        network: "eip155:84532",
      }, { status: 409 });
    };
    await assert.rejects(gateway.settle(payload, requirements), (error: unknown) =>
      !!error && typeof error === "object" && "definitiveSettlementFailure" in error &&
      (error as { definitiveSettlementFailure?: boolean }).definitiveSettlementFailure === false);
    assert.equal(settleCalls, 2);

    settleCalls = 0;
    globalThis.fetch = async () => {
      settleCalls++;
      return Response.json({
        success: false,
        errorReason: "settlement_pending",
        errorMessage: "transaction pending",
        transaction: `0x${"44".repeat(32)}`,
        network: "eip155:84532",
      });
    };
    await assert.rejects(gateway.settle(payload, requirements), (error: unknown) =>
      !!error && typeof error === "object" && "definitiveSettlementFailure" in error &&
      (error as { definitiveSettlementFailure?: boolean }).definitiveSettlementFailure === false &&
      (error as { transaction?: string }).transaction === `0x${"44".repeat(32)}`);
    assert.equal(settleCalls, 2);

    globalThis.fetch = async () => new Response("not json", { status: 500 });
    await assert.rejects(gateway.settle(payload, requirements), (error: unknown) =>
      error instanceof Error && !("definitiveSettlementFailure" in error));
  } finally { globalThis.fetch = originalFetch; }
});

test("official SDK successful settlement response maps to the service settlement record", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    success: true,
    transaction: `0x${"55".repeat(32)}`,
    network: "eip155:84532",
    payer: "0x2222222222222222222222222222222222222222",
  });
  try {
    const gateway = new X402SdkGateway(config);
    const result = await gateway.settle(paymentPayload(), gateway.requirements!);
    assert.equal(result.success, true);
    assert.equal(result.amount, "10000");
  } finally { globalThis.fetch = originalFetch; }
});
