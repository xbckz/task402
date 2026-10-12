import { randomUUID } from "node:crypto";
import type { ArtifactStore, JobRow, JobStore, JobState, NewJobRow, PaymentGateway, PaymentPayloadV2, PdfInput, PdfRenderer, ServiceConfig, SettlementRecord } from "../src/types.js";
import { PdfService } from "../src/service.js";
import { SqliteJobStore } from "../src/local-store.js";

export const PAY_TO = "0x1111111111111111111111111111111111111111";
export const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const BASE_URL = "https://pdf.example.test";
export const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type /Catalog>>endobj\n%%EOF\n");

export class MemoryArtifacts implements ArtifactStore {
  readonly data = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array): Promise<void> { this.data.set(key, Uint8Array.from(bytes)); }
  async get(key: string): Promise<Uint8Array | null> { const bytes = this.data.get(key); return bytes ? Uint8Array.from(bytes) : null; }
  async delete(key: string): Promise<void> { this.data.delete(key); }
}

export class FakeRenderer implements PdfRenderer {
  calls = 0;
  failCount = 0;
  output = PDF_BYTES;
  async render(_input: PdfInput, signal?: AbortSignal): Promise<Uint8Array> {
    this.calls++;
    if (signal?.aborted) throw signal.reason;
    if (this.failCount > 0) { this.failCount--; throw new Error("fixture renderer failure"); }
    return Uint8Array.from(this.output);
  }
}

export class FakeGateway implements PaymentGateway {
  readonly mode = "live" as const;
  readonly resourceUrl = `${BASE_URL}/v1/pdf`;
  readonly requirements = {
    scheme: "exact" as const,
    network: "eip155:84532",
    asset: ASSET,
    amount: "10000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  };
  verifyCalls = 0;
  settleCalls = 0;
  settlementFailure: "unknown" | "definitive" | null = null;

  async verify(payload: PaymentPayloadV2) {
    this.verifyCalls++;
    const authorization = payload.payload.authorization as { from: string };
    return { isValid: true, payer: authorization.from.toLowerCase() };
  }

  async settle(): Promise<SettlementRecord> {
    this.settleCalls++;
    if (this.settlementFailure === "unknown") throw new Error("facilitator network timeout");
    if (this.settlementFailure === "definitive") throw Object.assign(new Error("invalid payment"), { definitiveSettlementFailure: true });
    return { success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:84532", payer: PAYER, amount: "10000" };
  }
}

export const PAYER = "0x2222222222222222222222222222222222222222";

export function paymentPayload(nonce = `0x${"11".repeat(32)}`, resourceUrl = `${BASE_URL}/v1/pdf`): PaymentPayloadV2 {
  const validBefore = Math.floor(Date.now() / 1000) + 600;
  return {
    x402Version: 2,
    resource: { url: resourceUrl, description: "PDF", mimeType: "application/pdf" },
    accepted: {
      scheme: "exact", network: "eip155:84532", asset: ASSET, amount: "10000", payTo: PAY_TO,
      maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" },
    },
    payload: {
      signature: `0x${"12".repeat(65)}`,
      authorization: { from: PAYER, to: PAY_TO, value: "10000", validAfter: "0", validBefore: String(validBefore), nonce },
    },
  };
}

type ServiceFixture = ReturnType<typeof buildService>;

export function makeService(options: { live: true; ttlSeconds?: number; renderer?: FakeRenderer; gateway?: FakeGateway }): ServiceFixture & { gateway: FakeGateway };
export function makeService(options?: { live?: false; ttlSeconds?: number; renderer?: FakeRenderer }): ServiceFixture & { gateway: PaymentGateway };
export function makeService(options: { live?: boolean; ttlSeconds?: number; renderer?: FakeRenderer; gateway?: FakeGateway } = {}) {
  return buildService(options);
}

function buildService(options: { live?: boolean; ttlSeconds?: number; renderer?: FakeRenderer; gateway?: FakeGateway }) {
  const jobs = new SqliteJobStore(":memory:");
  const artifacts = new MemoryArtifacts();
  const renderer = options.renderer ?? new FakeRenderer();
  const gateway = options.gateway ?? (options.live ? new FakeGateway() : {
    mode: "dev-bypass" as const,
    requirements: null,
    resourceUrl: null,
    async verify() { throw new Error("not used"); },
    async settle() { throw new Error("not used"); },
  });
  const config: ServiceConfig = {
    publicBaseUrl: BASE_URL,
    capabilitySecret: "test-only-secret-is-at-least-thirty-two-bytes-long",
    jobTtlSeconds: options.ttlSeconds ?? 3600,
    maxMarkdownBytes: 240 * 1024,
    maxPdfBytes: 20 * 1024 * 1024,
    operationTimeoutMs: 5000,
    payment: gateway,
  };
  return { service: new PdfService(jobs, artifacts, renderer, config), jobs, artifacts, renderer, gateway };
}

export function idempotencyKey(): string { return `test-${randomUUID()}`; }

export async function findRows(store: JobStore): Promise<JobRow[]> {
  const row = await store.findByRequestKey("unused");
  return row ? [row] : [];
}

export function asState(row: JobRow, state: JobState): JobRow { return { ...row, state }; }

export type { NewJobRow };
