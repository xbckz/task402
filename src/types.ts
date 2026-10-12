export type JobState =
  | "reserved"
  | "rendered"
  | "settling"
  | "complete"
  | "render_failed"
  | "payment_failed"
  | "settlement_unknown"
  | "expired";

export interface PdfInput {
  title: string;
  markdown: string;
}

export interface JobRow {
  id: string;
  requestKey: string;
  paymentKey: string | null;
  paymentFingerprint: string;
  inputHash: string;
  capabilityHash: string;
  title: string;
  state: JobState;
  createdAt: number;
  expiresAt: number;
  paymentRetainUntil: number;
  artifactKey: string | null;
  artifactBytes: number | null;
  settlement: SettlementRecord | null;
  errorCode: string | null;
  leaseUntil: number;
  leaseToken: string | null;
}

export interface NewJobRow {
  id: string;
  requestKey: string;
  paymentKey: string | null;
  paymentFingerprint: string;
  inputHash: string;
  capabilityHash: string;
  title: string;
  createdAt: number;
  expiresAt: number;
  paymentRetainUntil: number;
}

export interface SettlementRecord {
  success: true;
  transaction: string;
  network: string;
  payer?: string;
  amount?: string;
}

export interface JobStore {
  findByRequestKey(key: string): Promise<JobRow | null>;
  findByPaymentKey(key: string): Promise<JobRow | null>;
  insertJob(job: NewJobRow): Promise<boolean>;
  acquire(id: string, now: number, leaseUntil: number, leaseToken: string): Promise<boolean>;
  updateState(id: string, state: JobState, options?: {
    artifactKey?: string | null;
    artifactBytes?: number | null;
    settlement?: SettlementRecord | null;
    errorCode?: string | null;
    leaseUntil?: number;
    /** Expected lease owner for compare-and-swap updates. Use null to match an unclaimed row. */
    leaseToken?: string | null;
    /** New fencing value to install after a state transition. */
    fenceToken?: string | null;
    expectedState?: JobState;
  }): Promise<boolean>;
  get(id: string): Promise<JobRow | null>;
  listExpired(now: number, limit: number): Promise<JobRow[]>;
  purgeExpiredTombstones(now: number, limit: number): Promise<number>;
  delete(id: string): Promise<void>;
}

export interface ArtifactStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export interface PdfRenderer {
  render(input: PdfInput, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface PaymentPayloadV2 {
  x402Version: number;
  resource?: { url?: string; [key: string]: unknown };
  accepted: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra?: Record<string, unknown>;
  };
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface PaymentGateway {
  readonly mode: "live" | "dev-bypass" | "unconfigured";
  readonly requirements: PaymentRequirements | null;
  readonly resourceUrl: string | null;
  verify(payload: PaymentPayloadV2, requirements: PaymentRequirements): Promise<{
    isValid: boolean;
    payer?: string;
    reason?: string;
  }>;
  settle(payload: PaymentPayloadV2, requirements: PaymentRequirements): Promise<SettlementRecord>;
}

export interface ServiceConfig {
  publicBaseUrl: string;
  capabilitySecret: string;
  jobTtlSeconds: number;
  maxMarkdownBytes: number;
  maxPdfBytes: number;
  operationTimeoutMs: number;
  payment: PaymentGateway;
}

export interface PdfJobResult {
  jobId: string;
  state: JobState;
  title: string;
  createdAt: string;
  expiresAt: string;
  statusUrl: string;
  downloadUrl: string;
  capability: string;
  artifactBytes?: number;
  settlement?: SettlementRecord;
  resumed?: boolean;
}

export interface PdfDocumentRow {
  id: string;
  idempotencyHash: string;
  requestHash: string;
  recoveryHash: string;
  contentHash: string;
  capabilityHash: string;
  fileName: string;
  pageCount: number;
  createdAt: number;
  expiresAt: number;
  sourceKey: string;
  indexKey: string;
  /** Payment fields are optional for rows created before paid indexing was enabled. */
  paymentKey?: string | null;
  paymentFingerprint?: string | null;
  payer?: string | null;
  paymentState?: "complete" | "reserved" | "settling" | "settlement_unknown" | "payment_failed";
  settlement?: SettlementRecord | null;
  errorCode?: string | null;
}

export interface PdfDocumentStore {
  findByIdempotencyHash(hash: string): Promise<PdfDocumentRow | null>;
  get(id: string): Promise<PdfDocumentRow | null>;
  insert(row: PdfDocumentRow): Promise<boolean>;
  listExpired(now: number, limit: number): Promise<PdfDocumentRow[]>;
  delete(id: string): Promise<void>;
  findByPaymentKey?(key: string): Promise<PdfDocumentRow | null>;
  updatePayment?(id: string, state: NonNullable<PdfDocumentRow["paymentState"]>, settlement?: SettlementRecord | null, errorCode?: string | null, expectedState?: NonNullable<PdfDocumentRow["paymentState"]>): Promise<boolean>;
}

/** Durable state machine for generic paid tools. */
export type PaidToolCallState = "reserved" | "processing" | "ready_to_settle" | "settling" | "settlement_unknown" | "complete" | "failed" | "expired";

export interface PaidToolCallRow {
  id: string;
  requestKey: string;
  paymentKey: string | null;
  paymentFingerprint: string;
  tool: string;
  inputHash: string;
  payer: string;
  state: PaidToolCallState;
  createdAt: number;
  expiresAt: number;
  resultJson: string | null;
  settlement: SettlementRecord | null;
  errorCode: string | null;
}

export interface PaidToolCallStore {
  findByRequestKey(key: string): Promise<PaidToolCallRow | null>;
  findByPaymentKey(key: string): Promise<PaidToolCallRow | null>;
  insert(row: PaidToolCallRow): Promise<boolean>;
  update(id: string, state: PaidToolCallState, options?: {
    resultJson?: string | null;
    settlement?: SettlementRecord | null;
    errorCode?: string | null;
    expectedState?: PaidToolCallState;
  }): Promise<boolean>;
  cleanupExpired(now: number, limit: number): Promise<number>;
  delete(id: string): Promise<void>;
  close?(): void;
}

export type ToolStatsOutcome = "success" | "error" | "payment_required";

export type TrafficStatsEventName =
  | "overview_request"
  | "docs_request"
  | "pricing_request"
  | "mcp_initialize_request"
  | "mcp_tools_list_request"
  | "generation_payment_challenge"
  | "generation_completed"
  | "paid_tool_payment_challenge"
  | "paid_tool_completed"
  | "document_ingest_completed"
  | "document_ingest_resumed"
  | "document_tool_completed"
  | "download_completed";

export interface TrafficStatsEvent {
  event: TrafficStatsEventName;
  createdAt?: number;
}

export interface TrafficStatsRow {
  event: TrafficStatsEventName;
  calls: number;
  lastSeenAt: number;
}

export interface ToolStatsEvent {
  tool: string;
  outcome: ToolStatsOutcome;
  status: number;
  durationMs: number;
  settledAmountAtomic?: string;
  createdAt?: number;
}

export interface ToolStatsRow {
  tool: string;
  calls: number;
  successes: number;
  errors: number;
  paymentRequired: number;
  settledCalls: number;
  settledAmountAtomic: string;
  totalDurationMs: number;
  maxDurationMs: number;
  lastSeenAt: number;
}

export interface ToolStatsTimelineRow {
  bucketStart: string;
  granularity: "day" | "hour";
  calls: number;
  successes: number;
  errors: number;
  paymentRequired: number;
}

export interface ToolStatsSummary {
  generatedAt: string;
  since: string | null;
  totalCalls: number;
  totalSuccesses: number;
  totalErrors: number;
  totalPaymentRequired: number;
  totalSettledCalls: number;
  totalSettledAmountAtomic: string;
  averageDurationMs: number;
  byTool: ToolStatsRow[];
  traffic: TrafficStatsRow[];
  timeline: ToolStatsTimelineRow[];
}

export interface ToolStatsStore {
  record(event: ToolStatsEvent): Promise<void>;
  recordTraffic?(event: TrafficStatsEvent): Promise<void>;
  summarize(sinceMs?: number): Promise<ToolStatsSummary>;
  close?(): void;
}

export interface ServiceError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}
