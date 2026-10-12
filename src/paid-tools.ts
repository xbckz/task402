import { randomUUID } from "node:crypto";
import { buildPaymentRequired, usdToSixDecimals } from "./payments.js";
import { InputError, payloadSemanticKey, paymentPayloadFingerprint, sha256, stableJson, validateIdempotencyKey } from "./security.js";
import { validatePaymentPayload } from "./service.js";
import type { PaidToolCallRow, PaidToolCallStore, PaymentGateway, PaymentPayloadV2, PaymentRequirements, SettlementRecord } from "./types.js";

export type PaidToolOutcome<T> =
  | { kind: "result"; value: T; settlement?: SettlementRecord; resumed?: boolean }
  | { kind: "payment_required"; paymentRequired: Record<string, unknown> }
  | { kind: "error"; status: number; code: string; message: string; details?: unknown };

export interface PaidToolDefinition {
  name: string;
  resourcePath?: string;
  priceUsd: string;
  description: string;
  inputSchema: Record<string, unknown>;
  example: Record<string, unknown>;
  outputExample: Record<string, unknown>;
}

const MAX_PAID_RESULT_BYTES = 256 * 1024;
const PROCESSING_LEASE_MS = 5 * 60 * 1000;

export class PaidToolService {
  constructor(private readonly store: PaidToolCallStore, private readonly payment: PaymentGateway, private readonly publicBaseUrl: string, private readonly ttlMs = 30 * 24 * 60 * 60 * 1000) {}

  requirements(priceUsd: string): PaymentRequirements | null {
    const base = this.payment.requirements;
    if (!base) return null;
    return { ...base, amount: usdToSixDecimals(priceUsd) };
  }

  cleanupExpired(now: number, limit: number): Promise<number> {
    return this.store.cleanupExpired(now, limit);
  }

  async execute<T>(definition: PaidToolDefinition, input: unknown, idempotencyValue: string | null, payload: PaymentPayloadV2 | null, handler: () => Promise<T>): Promise<PaidToolOutcome<T>> {
    const resourceUrl = this.publicBaseUrl.replace(/\/+$/, "") + (definition.resourcePath ?? "/v1/tools/" + definition.name);
    let idempotency: string;
    try { idempotency = validateIdempotencyKey(idempotencyValue); } catch (error) { return this.errorFrom(error); }
    const inputHash = sha256(stableJson(input));
    const requirements = this.requirements(definition.priceUsd);
    if (this.payment.mode === "unconfigured") return { kind: "error", status: 503, code: "payments_unconfigured", message: "Live x402 payment configuration is missing." };

    // Fingerprint the authorization before contacting the facilitator. A
    // completed idempotent retry must return its cached result even if the
    // facilitator rejects an already-used nonce.
    let payer = "local-development";
    let paymentKey: string | null = null;
    let paymentFingerprint = sha256("dev-bypass\0" + idempotency + "\0" + inputHash);
    if (this.payment.mode === "live") {
      if (!requirements) return { kind: "error", status: 503, code: "payments_unconfigured", message: "Live x402 payment requirements are unavailable." };
      if (!payload) return this.paymentChallenge(definition, resourceUrl, requirements, "Payment is required for this tool.");
      try {
        validatePaymentPayload(payload, requirements, resourceUrl);
        const semantic = payloadSemanticKey(payload);
        payer = semantic.payer;
        paymentKey = semantic.key;
        paymentFingerprint = paymentPayloadFingerprint(payload);
      } catch (error) {
        return this.paymentChallenge(definition, resourceUrl, requirements, error instanceof Error ? error.message : "Payment payload is invalid.");
      }
    } else if (payload) {
      return { kind: "error", status: 400, code: "payment_payload_not_supported_in_dev", message: "Remove PAYMENT-SIGNATURE while local development bypass is enabled." };
    }

    const requestKey = sha256(payer + "\0" + definition.name + "\0" + idempotency);
    let existing = await this.store.findByRequestKey(requestKey);
    if (existing) {
      if (existing.tool !== definition.name || existing.inputHash !== inputHash || existing.paymentFingerprint !== paymentFingerprint) {
        return { kind: "error", status: 409, code: "idempotency_conflict", message: "This Idempotency-Key is already bound to a different tool, input, or payment." };
      }
      if (existing.state === "expired" || (existing.expiresAt <= Date.now() && (existing.state === "complete" || existing.state === "failed"))) {
        return { kind: "error", status: 410, code: "paid_result_expired", message: "The retained result has expired. Use a new Idempotency-Key to run the tool again." };
      }
      if (existing.state === "complete" && existing.resultJson) return this.cachedResult(existing);
      if (existing.state === "settlement_unknown") return { kind: "error", status: 503, code: "payment_recovery_pending", message: "The payment outcome is uncertain. Do not send the same payment again.", details: { tool: definition.name, idempotencyKey: idempotency } };
      if (existing.state === "failed") return { kind: "error", status: 409, code: existing.errorCode ?? "paid_tool_failed", message: "This idempotent call has already failed. Use a new Idempotency-Key after correcting the request." };

      const stale = Date.now() - existing.createdAt > PROCESSING_LEASE_MS;
      if (existing.state === "processing") {
        if (!stale) return this.inProgress();
        await this.store.update(existing.id, "failed", { errorCode: "request_interrupted", expectedState: "processing" });
        return { kind: "error", status: 409, code: "request_interrupted", message: "The previous handler lease expired. Use a new Idempotency-Key to retry safely." };
      } else if (existing.state === "settling") {
        // A facilitator call may already have been broadcast when the
        // process stopped. Never automatically send that authorization again.
        if (stale) {
          await this.store.update(existing.id, "settlement_unknown", { errorCode: "settlement_outcome_unknown", expectedState: "settling" });
          return { kind: "error", status: 503, code: "payment_recovery_pending", message: "The previous settlement may have been broadcast. Do not send the same payment again." };
        }
        return this.inProgress();
      }
      if (existing.state === "ready_to_settle") {
        if (this.payment.mode !== "live") {
          const completed = await this.store.update(existing.id, "complete", { errorCode: null, expectedState: "ready_to_settle" });
          return completed ? this.cachedResult({ ...existing, state: "complete" }) : this.inProgress();
        }
        if (!payload || !requirements) return { kind: "error", status: 503, code: "payment_recovery_pending", message: "The tool result is ready but its payment authorization is unavailable. Do not send the same payment again." };
        if (!await this.store.update(existing.id, "settling", { expectedState: "ready_to_settle" })) return this.inProgress();
        return this.settleStoredResult(definition, resourceUrl, requirements, { ...existing, state: "settling" }, payload, false);
      }
    }

    if (paymentKey) {
      const duplicate = await this.store.findByPaymentKey(paymentKey);
      if (duplicate && duplicate.requestKey !== requestKey) return { kind: "error", status: 409, code: "payment_replay", message: "This exact payment authorization is already bound to another tool call." };
    }

    const row: PaidToolCallRow = { id: randomUUID(), requestKey, paymentKey, paymentFingerprint, tool: definition.name, inputHash, payer, state: "reserved", createdAt: Date.now(), expiresAt: Date.now() + this.ttlMs, resultJson: null, settlement: null, errorCode: null };
    if (!existing) {
      const inserted = await this.store.insert(row);
      if (!inserted) {
        const raced = await this.store.findByRequestKey(requestKey);
        if (raced?.state === "complete" && raced.resultJson) return this.cachedResult(raced);
        return this.inProgress();
      }
    }
    const active = existing ?? row;
    if (!await this.store.update(active.id, "processing", { expectedState: "reserved" })) {
      const current = await this.store.findByRequestKey(requestKey);
      if (current?.state === "complete" && current.resultJson) return this.cachedResult(current);
      return this.inProgress();
    }

    if (this.payment.mode === "live") {
      const verification = await this.verifyPayment(definition, resourceUrl, requirements!, payload!);
      if (verification.kind === "payment_required" || verification.kind === "error") {
        await this.store.update(active.id, "failed", { errorCode: verification.kind === "payment_required" ? "payment_invalid" : verification.code, expectedState: "processing" }).catch(() => false);
        return verification;
      }
    }

    let value: T;
    try { value = await handler(); } catch (error) {
      await this.store.update(active.id, "failed", { errorCode: "tool_upstream_failed", expectedState: "processing" }).catch(() => false);
      return this.errorFrom(error, 502, "tool_upstream_failed", "The tool could not complete before payment settlement.");
    }
    let resultJson: string;
    try {
      resultJson = JSON.stringify(value);
      if (new TextEncoder().encode(resultJson).byteLength > MAX_PAID_RESULT_BYTES) {
        await this.store.update(active.id, "failed", { errorCode: "result_too_large", expectedState: "processing" }).catch(() => false);
        return { kind: "error", status: 413, code: "result_too_large", message: "The paid tool result exceeds the durable response limit." };
      }
    } catch {
      await this.store.update(active.id, "failed", { errorCode: "result_not_serializable", expectedState: "processing" }).catch(() => false);
      return { kind: "error", status: 502, code: "result_not_serializable", message: "The paid tool result could not be serialized." };
    }
    if (!await this.store.update(active.id, "ready_to_settle", { resultJson, expectedState: "processing" })) {
      return { kind: "error", status: 503, code: "payment_recovery_pending", message: "The tool result could not be durably recorded before settlement." };
    }
    if (this.payment.mode !== "live") {
      const completed = await this.store.update(active.id, "complete", { errorCode: null, expectedState: "ready_to_settle" });
      return completed ? { kind: "result", value } : { kind: "error", status: 503, code: "request_in_progress", message: "The result was recorded but could not be finalized." };
    }
    if (!await this.store.update(active.id, "settling", { expectedState: "ready_to_settle" })) return { kind: "error", status: 503, code: "payment_recovery_pending", message: "The payment is being settled by another request. Do not send the same payment again." };
    return this.settleStoredResult(definition, resourceUrl, requirements!, { ...active, state: "settling", resultJson }, payload!, false);
  }

  private async verifyPayment(definition: PaidToolDefinition, resourceUrl: string, requirements: PaymentRequirements, payload: PaymentPayloadV2): Promise<{ kind: "ok" } | PaidToolOutcome<never>> {
    let verification: Awaited<ReturnType<PaymentGateway["verify"]>>;
    try { verification = await this.payment.verify(payload, requirements); } catch { return { kind: "error", status: 503, code: "payment_verification_unavailable", message: "The payment facilitator could not verify this request." }; }
    if (!verification.isValid) return this.paymentChallenge(definition, resourceUrl, requirements, verification.reason ?? "Payment authorization is invalid.");
    const semantic = payloadSemanticKey(payload);
    if (!verification.payer || verification.payer.toLowerCase() !== semantic.payer.toLowerCase()) return this.paymentChallenge(definition, resourceUrl, requirements, "Verified payer does not match the authorization payer.");
    return { kind: "ok" };
  }

  private async settleStoredResult<T>(definition: PaidToolDefinition, resourceUrl: string, requirements: PaymentRequirements, row: PaidToolCallRow, payload: PaymentPayloadV2, resumed = false): Promise<PaidToolOutcome<T>> {
    try {
      const settlement = await this.payment.settle(payload, requirements);
      const completed = await this.store.update(row.id, "complete", { settlement, errorCode: null, expectedState: "settling" });
      if (!completed) return { kind: "error", status: 503, code: "payment_recovery_pending", message: "Settlement succeeded but the result could not be durably recorded." };
      return { kind: "result", value: JSON.parse(row.resultJson!) as T, settlement, ...(resumed ? { resumed: true } : {}) };
    } catch (error) {
      const definitive = !!(error && typeof error === "object" && "definitiveSettlementFailure" in error && (error as { definitiveSettlementFailure?: boolean }).definitiveSettlementFailure);
      if (definitive) {
        await this.store.update(row.id, "failed", { errorCode: "settlement_failed", expectedState: "settling" }).catch(() => false);
        return this.paymentChallenge(definition, resourceUrl, requirements, "The facilitator rejected this payment.");
      }
      await this.store.update(row.id, "settlement_unknown", { errorCode: "settlement_outcome_unknown", expectedState: "settling" }).catch(() => false);
      return { kind: "error", status: 503, code: "payment_recovery_pending", message: "The facilitator did not return a definitive settlement result. Do not send the same payment again." };
    }
  }

  private cachedResult<T>(row: PaidToolCallRow): PaidToolOutcome<T> {
    return { kind: "result", value: JSON.parse(row.resultJson!) as T, ...(row.settlement ? { settlement: row.settlement } : {}), resumed: true };
  }

  private inProgress<T = never>(): PaidToolOutcome<T> {
    return { kind: "error", status: 202, code: "request_in_progress", message: "An identical call is already being processed." };
  }

  private paymentChallenge(definition: PaidToolDefinition, resourceUrl: string, requirements: PaymentRequirements, error: string): PaidToolOutcome<never> {
    const paymentRequired = buildPaymentRequired(this.payment, resourceUrl, error, requirements, { toolName: definition.name, description: definition.description, inputSchema: definition.inputSchema, example: definition.example, outputExample: definition.outputExample });
    return paymentRequired ? { kind: "payment_required", paymentRequired } : { kind: "error", status: 503, code: "payments_unconfigured", message: "Payment requirements are unavailable." };
  }

  private errorFrom(error: unknown, fallbackStatus = 400, fallbackCode = "invalid_request", fallbackMessage = "Request is invalid."): PaidToolOutcome<never> {
    if (error instanceof InputError) return { kind: "error", status: error.status, code: error.code, message: error.message };
    return { kind: "error", status: fallbackStatus, code: fallbackCode, message: error instanceof Error ? error.message : fallbackMessage };
  }
}
