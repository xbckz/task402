import { HTTPFacilitatorClient } from "@x402/core/server";
import { SettleError, VerifyError, type PaymentPayload, type PaymentRequirements } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { PaymentGateway, PaymentPayloadV2, PaymentRequirements as LocalRequirements, SettlementRecord } from "./types.js";

export interface LivePaymentConfig {
  mode: "live" | "unconfigured";
  facilitatorUrl?: string;
  facilitatorBearerToken?: string;
  network?: string;
  asset?: string;
  payTo?: string;
  priceUsd?: string;
  publicBaseUrl?: string;
}

export class X402SdkGateway implements PaymentGateway {
  readonly mode: "live" | "unconfigured";
  readonly requirements: LocalRequirements | null;
  readonly resourceUrl: string | null;
  private readonly facilitator: HTTPFacilitatorClient | null;

  constructor(config: LivePaymentConfig) {
    const anyLiveConfig = !!(config.facilitatorUrl || config.network || config.asset || config.payTo || config.facilitatorBearerToken);
    const complete = config.mode === "live" && config.facilitatorUrl && config.network && config.asset &&
      config.payTo && config.priceUsd && config.publicBaseUrl;
    if (config.mode === "unconfigured" && anyLiveConfig) {
      throw new Error("Payment settings are present but PAYMENTS_MODE is not set to live.");
    }
    if (config.mode === "live" && !complete) {
      throw new Error("PAYMENTS_MODE=live requires X402_FACILITATOR_URL, X402_NETWORK, X402_ASSET, X402_PAY_TO, PRICE_USD, and PUBLIC_BASE_URL.");
    }
    if (!complete) {
      this.mode = "unconfigured";
      this.requirements = null;
      this.resourceUrl = null;
      this.facilitator = null;
      return;
    }

    const network = config.network!;
    const asset = config.asset!;
    const payTo = config.payTo!;
    const baseUrl = config.publicBaseUrl!.replace(/\/+$/, "");
    const publicUrl = new URL(baseUrl);
    if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== "/") {
      throw new Error("PUBLIC_BASE_URL must be an HTTPS origin without credentials, a path, query, or fragment.");
    }
    const facilitatorUrl = new URL(config.facilitatorUrl!);
    if (facilitatorUrl.protocol !== "https:" || facilitatorUrl.username || facilitatorUrl.password || facilitatorUrl.search || facilitatorUrl.hash) {
      throw new Error("X402_FACILITATOR_URL must be an HTTPS URL without credentials, query, or fragment.");
    }
    if (!/^eip155:[0-9]+$/.test(network)) throw new Error("X402_NETWORK must be an EVM CAIP-2 network such as eip155:84532.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(payTo) || !/^0x[0-9a-fA-F]{40}$/.test(asset)) {
      throw new Error("X402_ASSET and X402_PAY_TO must be 20-byte EVM addresses.");
    }
    const amount = usdToSixDecimals(config.priceUsd!);

    this.mode = "live";
    this.resourceUrl = `${baseUrl}/v1/pdf`;
    this.requirements = {
      scheme: "exact",
      network,
      asset,
      amount,
      payTo,
      maxTimeoutSeconds: 60,
      // Base mainnet's canonical USDC contract uses the EIP-712 domain
      // `name = "USD Coin"`, while its display symbol is `USDC`.
      // x402 clients sign this value verbatim for TransferWithAuthorization.
      extra: { name: "USD Coin", version: "2" },
    };
    this.facilitator = new HTTPFacilitatorClient({
      url: config.facilitatorUrl!,
      timeoutMs: 45_000,
      ...(config.facilitatorBearerToken ? {
        createAuthHeaders: async () => ({
          verify: { Authorization: `Bearer ${config.facilitatorBearerToken}` },
          settle: { Authorization: `Bearer ${config.facilitatorBearerToken}` },
          supported: { Authorization: `Bearer ${config.facilitatorBearerToken}` },
        }),
      } : {}),
    });
  }

  async verify(payload: PaymentPayloadV2, requirements: LocalRequirements): Promise<{ isValid: boolean; payer?: string; reason?: string }> {
    if (!this.facilitator) throw new Error("x402 facilitator is not configured.");
    let result;
    try {
      result = await this.facilitator.verify(payload as PaymentPayload, requirements as PaymentRequirements);
    } catch (error) {
      if (error instanceof VerifyError) {
        return {
          isValid: false,
          ...(error.payer ? { payer: error.payer } : {}),
          reason: error.invalidReason ?? error.message,
        };
      }
      throw error;
    }
    return {
      isValid: result.isValid,
      ...(result.payer ? { payer: result.payer } : {}),
      ...(result.invalidReason || result.invalidMessage ? { reason: result.invalidReason ?? result.invalidMessage } : {}),
    };
  }

  async settle(payload: PaymentPayloadV2, requirements: LocalRequirements): Promise<SettlementRecord> {
    if (!this.facilitator) throw new Error("x402 facilitator is not configured.");
    let result: Awaited<ReturnType<X402SdkGateway["settleOnce"]>> | undefined;
    // OpenX402 may broadcast the transaction but time out waiting for its
    // receipt. Its settlement_pending response includes the canonical hash;
    // retrying the identical payload once asks the facilitator to reconcile
    // that transaction instead of broadcasting a second payment. Keep the
    // total number of facilitator calls bounded at two, regardless of whether
    // the pending response arrives as an HTTP error or a 2xx JSON result.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const candidate = await this.settleOnce(payload, requirements);
        if (attempt === 0 && isRetryableSettlementPending(candidate)) continue;
        result = candidate;
        break;
      } catch (error) {
        if (attempt === 0 && isRetryableSettlementPending(error)) continue;
        throw error;
      }
    }
    if (!result) throw new Error("Facilitator settlement did not return a result.");
    if (result.success !== true) {
      const definitiveSettlementFailure = !!result.errorReason && isDefinitiveSettlementFailure(result.errorReason);
      throw Object.assign(new Error(result.errorMessage ?? result.errorReason ?? "facilitator returned an unsuccessful settlement"), {
        definitiveSettlementFailure,
        errorReason: result.errorReason,
        transaction: result.transaction,
        network: result.network,
      });
    }
    // The SDK parses facilitator JSON but does not establish that a success
    // belongs to this payment. Treat malformed or mismatched results as unknown.
    const expectedPayer = (payload.payload.authorization as { from?: unknown } | undefined)?.from;
    if (typeof result.transaction !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result.transaction) ||
        result.network !== requirements.network ||
        (result.amount !== undefined && result.amount !== requirements.amount) ||
        (result.payer !== undefined && (typeof result.payer !== "string" || typeof expectedPayer !== "string" || result.payer.toLowerCase() !== expectedPayer.toLowerCase()))) {
      throw new Error("Facilitator success response does not match the requested EVM settlement.");
    }
    return {
      success: true,
      transaction: result.transaction,
      network: result.network,
      ...(result.payer ? { payer: result.payer } : {}),
      // The facilitator may omit amount on a successful response. The
      // verified requirements are authoritative for the settled charge.
      amount: result.amount ?? requirements.amount,
    };
  }

  private async settleOnce(payload: PaymentPayloadV2, requirements: LocalRequirements) {
    try {
      return await this.facilitator!.settle(payload as PaymentPayload, requirements as PaymentRequirements);
    } catch (error) {
      if (error instanceof SettleError) {
        const definitiveSettlementFailure = !!error.errorReason && isDefinitiveSettlementFailure(error.errorReason);
        throw Object.assign(new Error(error.errorMessage ?? error.errorReason ?? "facilitator returned an unsuccessful settlement"), {
          definitiveSettlementFailure,
          errorReason: error.errorReason,
          transaction: error.transaction,
          network: error.network,
        });
      }
      // Older or non-conforming facilitators sometimes return a plain JSON
      // error without the x402 `success` field, so the official SDK exposes it
      // as a generic Error. Recover only well-known terminal reasons from that
      // bounded message; transport and RPC failures remain uncertain.
      if (error instanceof Error) {
        const inferredReason = inferDefinitiveSettlementReason(error.message);
        if (inferredReason) {
          throw Object.assign(error, {
            definitiveSettlementFailure: true,
            errorReason: inferredReason,
          });
        }
      }
      throw error;
    }
  }
}

function isRetryableSettlementPending(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { errorReason?: unknown; transaction?: unknown };
  return value.errorReason === "settlement_pending" && typeof value.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.transaction);
}

function isDefinitiveSettlementFailure(reason: string): boolean {
  // The exact EVM facilitator uses a stable `invalid_exact_evm_*` family for
  // payload, authorization, simulation, and failed-transaction results. These
  // are terminal for this authorization; retrying the same payment cannot make
  // an invalid signature, nonce, recipient, or failed transfer valid. Keep the
  // pending result out of this rule because it may include a broadcast hash and
  // is reconciled by settle() above.
  if (reason.startsWith("invalid_exact_evm_") && reason !== "invalid_exact_evm_settlement_pending") return true;
  return new Set([
    "insufficient_funds",
    "insufficient_balance",
    "invalid_scheme",
    "invalid_network",
    "invalid_x402_version",
    "invalid_payment_requirements",
    "invalid_payload",
    "address_not_registered",
    "invalid_permit2_spender",
    "permit2_insufficient_balance",
    "permit2_allowance_required",
    "permit2_invalid_signature",
    "permit2_invalid_nonce",
  ]).has(reason);
}

function inferDefinitiveSettlementReason(message: string): string | undefined {
  const match = message.match(/\b(?:invalid_exact_evm_[a-z0-9_]+|address_not_registered|insufficient_balance|insufficient_funds)\b/);
  const reason = match?.[0];
  return reason && isDefinitiveSettlementFailure(reason) ? reason : undefined;
}

export function usdToSixDecimals(price: string): string {
  if (!/^\d+(?:\.\d{1,6})?$/.test(price)) throw new Error("PRICE_USD must be a positive decimal with up to 6 places.");
  const [whole = "0", fraction = ""] = price.split(".");
  const atomic = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (atomic <= 0n || atomic > 1_000_000_000_000n) throw new Error("PRICE_USD is outside the supported range.");
  return atomic.toString();
}

export function makeDevBypassGateway(): PaymentGateway {
  return {
    mode: "dev-bypass",
    requirements: null,
    resourceUrl: null,
    async verify() { throw new Error("Development bypass does not verify payment payloads."); },
    async settle() { throw new Error("Development bypass never settles payment."); },
  };
}

export interface BazaarDiscoveryOptions {
  toolName?: string;
  description?: string;
  transport?: "http" | "streamable-http";
  inputSchema?: Record<string, unknown>;
  example?: Record<string, unknown>;
  outputExample?: Record<string, unknown>;
}

export function buildPaymentRequired(gateway: PaymentGateway, resourceUrl: string, error?: string, requirementsOverride?: LocalRequirements, discovery: BazaarDiscoveryOptions = {}): Record<string, unknown> | null {
  const requirements = requirementsOverride ?? gateway.requirements;
  if (!requirements) return null;
  const isMcp = /\/mcp(?:[/?#]|$)/.test(resourceUrl);
  const isDocumentIngest = /\/v1\/documents$/.test(resourceUrl);
  const toolName = discovery.toolName ?? (isDocumentIngest ? "ingest_document" : "generate_pdf");
  const description = discovery.description ?? (isDocumentIngest ? "Index a PDF for bounded native-text document tools." : "Generate a professionally formatted, paginated PDF from Markdown content.");
  const defaultMcpSchema = {
    type: "object",
    required: ["title", "markdown", "idempotency_key"],
    additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1, maxLength: 160 },
      markdown: { type: "string", minLength: 1, maxLength: 240 * 1024 },
      idempotency_key: { type: "string", minLength: 8, maxLength: 128 },
    },
  };
  const bazaar = isMcp
    ? declareDiscoveryExtension({
        toolName,
        description,
        transport: discovery.transport ?? "streamable-http",
        inputSchema: discovery.inputSchema ?? (isDocumentIngest ? { type: "string", contentMediaType: "application/pdf" } : defaultMcpSchema),
        example: discovery.example ?? {},
        output: { example: discovery.outputExample ?? { ok: true } },
      })
    : addHttpMethod(declareDiscoveryExtension(isDocumentIngest ? {
        bodyType: "text",
        input: { contentType: "application/pdf", description: "Raw application/pdf bytes to index for bounded native-text PDF tools." },
        inputSchema: { type: "string", contentMediaType: "application/pdf" },
        output: { example: { documentId: "uuid", state: "indexed" } },
      } : {
        bodyType: "json",
        input: discovery.example ?? { title: "Quarterly report", markdown: "# Summary" },
        inputSchema: discovery.inputSchema ?? {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 160 },
            markdown: { type: "string", minLength: 1, maxLength: 240 * 1024 },
          },
          required: ["title", "markdown"],
          additionalProperties: false,
        },
        output: { example: discovery.outputExample ?? { jobId: "uuid", state: "complete" } },
      }));
  return {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: {
      url: resourceUrl,
      description,
      mimeType: isDocumentIngest || toolName === "generate_pdf" ? "application/pdf" : "application/json",
      serviceName: "Task402 Agent Evidence Tools",
      tags: isDocumentIngest ? ["pdf", "documents", "mcp"] : ["agents", "x402"],
    },
    accepts: [requirements],
    extensions: { bazaar: bazaar.bazaar },
  };
}

function addHttpMethod(extension: unknown): { bazaar: Record<string, unknown> } {
  const value = extension as { bazaar?: unknown };
  if (!value.bazaar || typeof value.bazaar !== "object") throw new Error("Bazaar extension generation failed.");
  const bazaar = value.bazaar as Record<string, unknown>;
  const info = bazaar.info as Record<string, unknown>;
  const input = info.input as Record<string, unknown>;
  return {
    bazaar: {
      ...bazaar,
      info: { ...info, input: { ...input, method: "POST" } },
    },
  };
}
