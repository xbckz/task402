import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ArtifactStore, JobRow, JobStore, PaymentGateway, PaymentPayloadV2, PdfInput, PdfJobResult, PdfRenderer,
  ServiceConfig, ServiceError, SettlementRecord,
} from "./types.js";
import { InputError, payloadSemanticKey, paymentPayloadFingerprint, sha256, stableJson, validateIdempotencyKey, validatePdfInput } from "./security.js";
import { buildPaymentRequired } from "./payments.js";

export type CreateOutcome =
  | { kind: "job"; job: PdfJobResult }
  | { kind: "payment_required"; paymentRequired: Record<string, unknown> }
  | { kind: "error"; error: ServiceError };

const PAYMENT_REPLAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class PdfService {
  constructor(
    readonly jobs: JobStore,
    readonly artifacts: ArtifactStore,
    readonly renderer: PdfRenderer,
    readonly config: ServiceConfig,
  ) {}

  async create(
    inputValue: unknown,
    idempotencyKeyValue: string | null,
    payload: PaymentPayloadV2 | null,
    resourceUrl: string,
  ): Promise<CreateOutcome> {
    let input: PdfInput;
    let idempotencyKey: string;
    try {
      input = validatePdfInput(inputValue, this.config.maxMarkdownBytes);
      idempotencyKey = validateIdempotencyKey(idempotencyKeyValue);
    } catch (error) {
      return inputErrorOutcome(error);
    }

    if (this.config.payment.mode === "unconfigured") {
      return errorOutcome(503, "payments_unconfigured", "Live x402 payment configuration is missing.");
    }
    if (this.config.payment.mode === "live" && !payload) {
      const paymentRequired = buildPaymentRequired(this.config.payment, resourceUrl);
      return paymentRequired
        ? { kind: "payment_required", paymentRequired }
        : errorOutcome(503, "payments_unconfigured", "Live x402 payment requirements are unavailable.");
    }
    if (this.config.payment.mode === "dev-bypass" && payload) {
      return errorOutcome(400, "payment_payload_not_supported_in_dev", "Remove PAYMENT-SIGNATURE while local development bypass is enabled.");
    }

    const inputHash = sha256(stableJson(input));
    const now = Date.now();
    const expiresAt = now + this.config.jobTtlSeconds * 1000;
    let paymentKey: string | null = null;
    let paymentFingerprint: string;
    let payerScope: string;
    let paymentRetainUntil = expiresAt + PAYMENT_REPLAY_RETENTION_MS;

    if (this.config.payment.mode === "dev-bypass") {
      payerScope = "local-development";
      paymentFingerprint = sha256(`dev-bypass\0${idempotencyKey}\0${inputHash}`);
    } else {
      const requirements = this.config.payment.requirements;
      if (!requirements || !payload) return errorOutcome(503, "payments_unconfigured", "Live x402 payment requirements are unavailable.");
      try {
        validatePaymentPayload(payload, requirements, resourceUrl);
        const semantic = payloadSemanticKey(payload);
        paymentKey = semantic.key;
        payerScope = semantic.payer;
        paymentRetainUntil = Math.max(expiresAt, semantic.authorizationExpiresAt) + PAYMENT_REPLAY_RETENTION_MS;
        paymentFingerprint = paymentPayloadFingerprint(payload);
      } catch (error) {
        return this.paymentRequired(resourceUrl, error instanceof Error ? error.message : "Invalid payment payload.");
      }
    }

    const requestKey = sha256(`${payerScope}\0${idempotencyKey}`);
    let row = await this.jobs.findByRequestKey(requestKey);
    if (row) {
      const conflict = compareExisting(row, inputHash, paymentFingerprint, paymentKey);
      if (conflict) return errorOutcome(409, conflict, "This Idempotency-Key is already bound to a different request or payment.");
      if (row.state === "expired" || row.expiresAt <= now) {
        return errorOutcome(410, "job_expired", "This job and its download capability have expired. Submit a new payment with a new Idempotency-Key.");
      }
      if (row.state === "complete") return this.jobOutcome(row, true);
      if (row.state === "settling" || row.state === "settlement_unknown") {
        return errorOutcome(503, "payment_recovery_pending", "Settlement has an uncertain outcome. This payment will not be sent again automatically.", this.jobReference(row, this.capabilityFor(row.id)));
      }
      if (row.state === "payment_failed") return this.paymentRequired(resourceUrl, "The facilitator reported that this payment did not settle.");
    }

    if (paymentKey) {
      const existingByPayment = await this.jobs.findByPaymentKey(paymentKey);
      if (existingByPayment && existingByPayment.id !== row?.id) {
        return errorOutcome(409, "payment_replay", "This exact-payment authorization is already bound to another job.");
      }
    }

    if (this.config.payment.mode === "live" && payload) {
      const requirements = this.config.payment.requirements!;
      let verification: Awaited<ReturnType<PaymentGateway["verify"]>>;
      try {
        verification = await this.config.payment.verify(payload, requirements);
      } catch {
        return errorOutcome(503, "payment_verification_unavailable", "The payment facilitator could not verify this request.");
      }
      if (!verification.isValid) {
        return this.paymentRequired(resourceUrl, verification.reason ?? "Payment authorization is invalid.");
      }
      if (!verification.payer || verification.payer.toLowerCase() !== payerScope) {
        return this.paymentRequired(resourceUrl, "Verified payer does not match the authorization payer.");
      }
    }

    if (!row) {
      const id = randomUUID();
      const capability = this.capabilityFor(id);
      const newJob = {
        id,
        requestKey,
        paymentKey,
        paymentFingerprint,
        inputHash,
        capabilityHash: sha256(capability),
        title: input.title,
        createdAt: now,
        expiresAt,
        paymentRetainUntil,
      };
      const inserted = await this.jobs.insertJob(newJob);
      if (!inserted) {
        row = await this.jobs.findByRequestKey(requestKey);
        if (row) {
          const conflict = compareExisting(row, inputHash, paymentFingerprint, paymentKey);
          if (conflict) return errorOutcome(409, conflict, "This Idempotency-Key is already bound to a different request or payment.");
          if (row.state === "expired" || row.expiresAt <= now) {
            return errorOutcome(410, "job_expired", "This job and its download capability have expired. Submit a new payment with a new Idempotency-Key.");
          }
          if (row.state === "complete") return this.jobOutcome(row, true);
          if (row.state === "settling" || row.state === "settlement_unknown") {
            return errorOutcome(503, "payment_recovery_pending", "Settlement has an uncertain outcome. This payment will not be sent again automatically.", this.jobReference(row, this.capabilityFor(row.id)));
          }
        }
        const collidedByPayment = paymentKey ? await this.jobs.findByPaymentKey(paymentKey) : null;
        if (collidedByPayment) return errorOutcome(409, "payment_replay", "This exact-payment authorization is already bound to another job.");
        return errorOutcome(202, "request_in_progress", "A request with this key is already being processed.");
      }
      row = await this.jobs.get(id);
      if (!row) return errorOutcome(500, "job_persistence_failed", "The job reservation could not be read back.");
    }

    return this.processReservedJob(row, input, this.capabilityFor(row.id), now, payload);
  }

  async getJob(id: string, capability: string | null): Promise<JobRow | null> {
    if (!isUuid(id) || !capability) return null;
    const row = await this.jobs.get(id);
    if (!row || row.state === "expired" || row.expiresAt <= Date.now()) return null;
    const supplied = Buffer.from(sha256(capability), "hex");
    const expected = Buffer.from(row.capabilityHash, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    return row;
  }

  async readPdf(id: string, capability: string | null): Promise<{ bytes: Uint8Array; row: JobRow } | null> {
    const row = await this.getJob(id, capability);
    if (!row || row.state !== "complete" || !row.artifactKey) return null;
    const bytes = await this.artifacts.get(row.artifactKey);
    return bytes ? { bytes, row } : null;
  }

  jobUrls(id: string): { statusUrl: string; downloadUrl: string } {
    const base = this.config.publicBaseUrl.replace(/\/+$/, "");
    return { statusUrl: `${base}/v1/jobs/${id}`, downloadUrl: `${base}/v1/jobs/${id}/download` };
  }

  async cleanupExpired(limit = 100): Promise<number> {
    const rows = await this.jobs.listExpired(Date.now(), limit);
    let expired = 0;
    for (const row of rows) {
      try {
        const fenceToken = randomUUID();
        const marked = await this.jobs.updateState(row.id, "expired", {
          errorCode: "artifact_expired",
          leaseUntil: 0,
          leaseToken: row.leaseToken,
          fenceToken,
          expectedState: row.state,
        });
        if (!marked) continue;
        if (row.artifactKey) {
          await this.artifacts.delete(row.artifactKey);
          const cleared = await this.jobs.updateState(row.id, "expired", {
            artifactKey: null,
            artifactBytes: null,
            leaseToken: fenceToken,
            fenceToken,
            expectedState: "expired",
          });
          if (!cleared) continue;
        }
        expired++;
      } catch {
        // Leave the row eligible so the next scheduled cleanup can retry.
      }
    }
    await this.jobs.purgeExpiredTombstones(Date.now(), limit);
    return expired;
  }

  private async processReservedJob(row: JobRow, input: PdfInput, capability: string, now: number, payload: PaymentPayloadV2 | null): Promise<CreateOutcome> {
    const acquiredAt = Date.now();
    const leaseUntil = acquiredAt + this.config.operationTimeoutMs + 15_000;
    const leaseToken = randomUUID();
    const acquired = await this.jobs.acquire(row.id, acquiredAt, leaseUntil, leaseToken);
    if (!acquired) {
      return errorOutcome(202, "job_in_progress", "The matching job is still being processed. Retry with the same request and payment.", this.jobReference(row, capability));
    }

    let current = await this.jobs.get(row.id);
    if (!current || current.leaseToken !== leaseToken) return errorOutcome(202, "job_in_progress", "The matching job has another active worker.", this.jobReference(current ?? row, capability));
    let artifactKey = current.artifactKey;
    let artifactBytes = current.artifactBytes;
    try {
      const existingArtifact = artifactKey ? await this.artifacts.get(artifactKey) : null;
      if (!existingArtifact) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("PDF rendering timed out")), this.config.operationTimeoutMs);
        let pdf: Uint8Array;
        try {
          pdf = await this.renderer.render(input, controller.signal);
        } finally {
          clearTimeout(timer);
        }
        if (controller.signal.aborted) throw new Error("renderer exceeded its time limit");
        if (!isPdf(pdf)) throw new Error("renderer returned an invalid PDF");
        if (pdf.byteLength > this.config.maxPdfBytes) throw new Error("renderer output exceeded the PDF size limit");
        artifactKey = `${row.id}.pdf`;
        artifactBytes = pdf.byteLength;
        await this.artifacts.put(artifactKey, pdf, "application/pdf");
      } else {
        artifactBytes = existingArtifact.byteLength;
      }
      const rendered = await this.jobs.updateState(row.id, "rendered", {
        artifactKey, artifactBytes, errorCode: null, leaseUntil, leaseToken,
      });
      if (!rendered) return errorOutcome(202, "job_in_progress", "The job lease expired while rendering. Retry with the same request and payment.", this.jobReference(row, capability));
    } catch {
      const failed = await this.jobs.updateState(row.id, "render_failed", {
        artifactKey: null, artifactBytes: null, errorCode: "pdf_render_failed", leaseUntil: 0, leaseToken,
      });
      if (!failed) return errorOutcome(202, "job_in_progress", "The job lease expired while rendering. Retry with the same request and payment.", this.jobReference(row, capability));
      return errorOutcome(502, "pdf_render_failed", "PDF generation failed before payment settlement. Retry with the same request and payment.", this.jobReference(row, capability));
    }

    if (this.config.payment.mode === "live") {
      if (!payload || !current.paymentKey) return errorOutcome(500, "payment_payload_lost", "The verified payment payload is unavailable.");
      const started = await this.jobs.updateState(row.id, "settling", { leaseUntil, leaseToken });
      if (!started) return errorOutcome(202, "job_in_progress", "The job lease expired before settlement. Retry with the same request and payment.", this.jobReference(row, capability));
      let settlement: SettlementRecord;
      try {
        settlement = await this.config.payment.settle(payload, this.config.payment.requirements!);
      } catch (error) {
        const definitive = !!(error && typeof error === "object" && "definitiveSettlementFailure" in error &&
          (error as { definitiveSettlementFailure?: boolean }).definitiveSettlementFailure);
        if (definitive) {
          await this.artifacts.delete(`${row.id}.pdf`).catch(() => undefined);
          const failed = await this.jobs.updateState(row.id, "payment_failed", {
            artifactKey: null, artifactBytes: null, errorCode: "settlement_failed", leaseUntil: 0, leaseToken,
          });
          const failureMessage = settlementFailureMessage(error);
          return failed
            ? this.paymentRequired(resourceUrlFor(payload, this.config.payment), failureMessage)
            : errorOutcome(503, "payment_recovery_pending", "Settlement was rejected, but the durable state could not be updated.", this.jobReference(row, capability));
        }
        await this.jobs.updateState(row.id, "settlement_unknown", { errorCode: "settlement_outcome_unknown", leaseUntil: 0, leaseToken });
        return errorOutcome(503, "payment_recovery_pending", "The facilitator did not return a definitive settlement result. This payment will not be sent again automatically.", this.settlementRecoveryDetails(row, capability, error));
      }
      const completed = await this.jobs.updateState(row.id, "complete", {
        settlement, errorCode: null, leaseUntil: 0, leaseToken,
      });
      if (!completed) {
        // `settling` is never reclaimed automatically; preserve the output for operator reconciliation.
        return errorOutcome(503, "payment_recovery_pending", "Payment settled, but job state could not be finalized. This payment will not be sent again automatically.", this.jobReference(row, capability));
      }
    } else {
      const completed = await this.jobs.updateState(row.id, "complete", { errorCode: null, leaseUntil: 0, leaseToken });
      if (!completed) return errorOutcome(202, "job_in_progress", "The job lease expired before completion. Retry with the same request.", this.jobReference(row, capability));
    }

    current = await this.jobs.get(row.id);
    if (!current) return errorOutcome(500, "job_persistence_failed", "The completed job could not be read back.");
    return this.jobOutcome(current, false, capability);
  }

  private capabilityFor(id: string): string {
    return createHmac("sha256", this.config.capabilitySecret).update(`pdf-job:${id}`).digest("base64url");
  }

  private jobOutcome(row: JobRow, resumed: boolean, capability = this.capabilityFor(row.id)): CreateOutcome {
    const job: PdfJobResult = {
      jobId: row.id,
      state: row.state,
      title: row.title,
      createdAt: new Date(row.createdAt).toISOString(),
      expiresAt: new Date(row.expiresAt).toISOString(),
      ...this.jobUrls(row.id),
      capability,
      ...(row.artifactBytes !== null ? { artifactBytes: row.artifactBytes } : {}),
      ...(row.settlement ? { settlement: row.settlement } : {}),
      ...(resumed ? { resumed: true } : {}),
    };
    return { kind: "job", job };
  }

  private jobReference(row: JobRow, capability: string): Record<string, unknown> {
    return {
      jobId: row.id,
      capability,
      state: row.state,
      ...this.jobUrls(row.id),
      expiresAt: new Date(row.expiresAt).toISOString(),
    };
  }

  private settlementRecoveryDetails(row: JobRow, capability: string, error: unknown): Record<string, unknown> {
    const details = this.jobReference(row, capability);
    if (!error || typeof error !== "object") return details;
    const value = error as {
      errorReason?: unknown;
      transaction?: unknown;
      network?: unknown;
    };
    if (typeof value.errorReason === "string" && value.errorReason.length <= 160) {
      details.facilitatorReason = value.errorReason;
    }
    if (typeof value.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.transaction)) {
      details.facilitatorTransaction = value.transaction;
    }
    if (typeof value.network === "string" && value.network.length <= 64) {
      details.facilitatorNetwork = value.network;
    }
    if (error instanceof Error && error.message.length <= 240) {
      details.facilitatorMessage = error.message;
    }
    return details;
  }

  private paymentRequired(resourceUrl: string, error: string): CreateOutcome {
    const paymentRequired = buildPaymentRequired(this.config.payment, resourceUrl, error);
    if (!paymentRequired) return errorOutcome(402, "payment_invalid", error);
    return { kind: "payment_required", paymentRequired };
  }
}

export function validatePaymentPayload(payload: PaymentPayloadV2, requirements: NonNullable<PaymentGateway["requirements"]>, resourceUrl: string): void {
  if (payload.x402Version !== 2 || !payload.accepted || !payload.payload || typeof payload.payload !== "object") {
    throw new InputError("invalid_payment", "Expected an x402 v2 payment payload.");
  }
  if (payload.resource?.url !== resourceUrl) {
    throw new InputError("payment_resource_mismatch", "Payment payload resource does not match this endpoint.");
  }
  const accepted = payload.accepted;
  if (accepted.scheme !== requirements.scheme || accepted.network !== requirements.network ||
      accepted.asset.toLowerCase() !== requirements.asset.toLowerCase() || accepted.amount !== requirements.amount ||
      accepted.payTo.toLowerCase() !== requirements.payTo.toLowerCase() ||
      accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds) {
    throw new InputError("payment_terms_mismatch", "Payment payload does not match the published price and recipient.");
  }
  const authorization = (payload.payload as Record<string, unknown>).authorization;
  if (!authorization || typeof authorization !== "object") throw new InputError("invalid_payment", "Expected an EIP-3009 authorization.");
  const auth = authorization as Record<string, unknown>;
  if (typeof auth.from !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(auth.from) ||
      typeof auth.to !== "string" || auth.to.toLowerCase() !== requirements.payTo.toLowerCase() ||
      typeof auth.value !== "string" || auth.value !== requirements.amount) {
    throw new InputError("payment_terms_mismatch", "Authorization payer, recipient, or amount does not match the payment terms.");
  }
  const extra = accepted.extra ?? {};
  if (extra.name !== requirements.extra.name || extra.version !== requirements.extra.version) {
    throw new InputError("payment_terms_mismatch", "Payment asset metadata does not match the configured USDC terms.");
  }
}

function compareExisting(row: JobRow, inputHash: string, paymentFingerprint: string, paymentKey: string | null): string | null {
  if (row.inputHash !== inputHash) return "idempotency_conflict";
  if (row.paymentFingerprint !== paymentFingerprint || row.paymentKey !== paymentKey) return "payment_mismatch";
  return null;
}

function inputErrorOutcome(error: unknown): CreateOutcome {
  if (error instanceof InputError) return errorOutcome(error.status, error.code, error.message);
  return errorOutcome(400, "invalid_request", "Request is invalid.");
}

function errorOutcome(status: number, code: string, message: string, details?: unknown): CreateOutcome {
  return { kind: "error", error: { status, code, message, ...(details !== undefined ? { details } : {}) } };
}

function isPdf(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const header = Buffer.from(bytes.subarray(0, 5)).toString("ascii");
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024))).toString("ascii").trimEnd();
  return header === "%PDF-" && tail.endsWith("%%EOF");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function resourceUrlFor(payload: PaymentPayloadV2, gateway: PaymentGateway): string {
  return payload.resource?.url ?? gateway.resourceUrl ?? "https://task402.xyz/mcp";
}

function settlementFailureMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "The facilitator reported that payment settlement failed.";
  const value = error as { errorReason?: unknown; message?: unknown };
  const reason = typeof value.errorReason === "string" && value.errorReason.length <= 160 ? value.errorReason : undefined;
  const message = typeof value.message === "string" && value.message.length <= 240 ? value.message : undefined;
  if (reason && message && message !== reason && !message.includes(reason)) return `The facilitator reported that payment settlement failed: ${reason} (${message}).`;
  if (reason) return `The facilitator reported that payment settlement failed: ${reason}.`;
  return "The facilitator reported that payment settlement failed.";
}
