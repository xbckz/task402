import type { ArtifactStore, JobRow, JobState, JobStore, NewJobRow, PaidToolCallRow, PaidToolCallState, PaidToolCallStore, PdfDocumentRow, PdfDocumentStore } from "./types.js";

interface D1JobRow {
  id: string;
  request_key: string;
  payment_key: string | null;
  payment_fingerprint: string;
  input_hash: string;
  capability_hash: string;
  title: string;
  state: JobState;
  created_at: number;
  expires_at: number;
  payment_retain_until: number;
  artifact_key: string | null;
  artifact_bytes: number | null;
  settlement_json: string | null;
  error_code: string | null;
  lease_until: number;
  lease_token: string | null;
}

export class D1JobStore implements JobStore {
  constructor(private readonly db: D1Database) {}

  findByRequestKey(key: string): Promise<JobRow | null> {
    return this.select("SELECT * FROM jobs WHERE request_key = ?", key);
  }

  findByPaymentKey(key: string): Promise<JobRow | null> {
    return this.select("SELECT * FROM jobs WHERE payment_key = ?", key);
  }

  async insertJob(job: NewJobRow): Promise<boolean> {
    const result = await this.db.prepare(`INSERT OR IGNORE INTO jobs
      (id, request_key, payment_key, payment_fingerprint, input_hash, capability_hash, title, state, created_at, expires_at, payment_retain_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`)
      .bind(job.id, job.requestKey, job.paymentKey, job.paymentFingerprint, job.inputHash, job.capabilityHash,
        job.title, job.createdAt, job.expiresAt, job.paymentRetainUntil).run();
    return result.meta.changes === 1;
  }

  async acquire(id: string, now: number, leaseUntil: number, leaseToken: string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE jobs SET lease_until = ?, lease_token = ?
      WHERE id = ? AND state IN ('reserved', 'rendered', 'render_failed') AND lease_until <= ?`)
      .bind(leaseUntil, leaseToken, id, now).run();
    return result.meta.changes === 1;
  }

  async updateState(id: string, state: JobState, options: Parameters<JobStore["updateState"]>[2] = {}): Promise<boolean> {
    const sets = ["state = ?"];
    const values: unknown[] = [state];
    if ("artifactKey" in options) { sets.push("artifact_key = ?"); values.push(options.artifactKey ?? null); }
    if ("artifactBytes" in options) { sets.push("artifact_bytes = ?"); values.push(options.artifactBytes ?? null); }
    if ("settlement" in options) { sets.push("settlement_json = ?"); values.push(options.settlement ? JSON.stringify(options.settlement) : null); }
    if ("errorCode" in options) { sets.push("error_code = ?"); values.push(options.errorCode ?? null); }
    if ("leaseUntil" in options) { sets.push("lease_until = ?"); values.push(options.leaseUntil ?? 0); }
    if ("fenceToken" in options) { sets.push("lease_token = ?"); values.push(options.fenceToken ?? null); }
    const conditions = ["id = ?"];
    values.push(id);
    if ("expectedState" in options && options.expectedState) { conditions.push("state = ?"); values.push(options.expectedState); }
    if ("leaseToken" in options) {
      if (options.leaseToken === null) conditions.push("lease_token IS NULL");
      else { conditions.push("lease_token = ?"); values.push(options.leaseToken); }
    }
    const result = await this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE ${conditions.join(" AND ")}`).bind(...values).run();
    return result.meta.changes === 1;
  }

  get(id: string): Promise<JobRow | null> {
    return this.select("SELECT * FROM jobs WHERE id = ?", id);
  }

  async listExpired(now: number, limit: number): Promise<JobRow[]> {
    const result = await this.db.prepare(`SELECT * FROM jobs WHERE ((expires_at <= ? AND state != 'expired') OR (state = 'expired' AND artifact_key IS NOT NULL))
      AND state NOT IN ('settling', 'settlement_unknown') AND lease_until <= ? ORDER BY expires_at LIMIT ?`)
      .bind(now, now, limit).all<D1JobRow>();
    return (result.results ?? []).map(toJob);
  }

  async purgeExpiredTombstones(now: number, limit: number): Promise<number> {
    const result = await this.db.prepare(`DELETE FROM jobs WHERE id IN (
      SELECT id FROM jobs WHERE state = 'expired' AND artifact_key IS NULL AND payment_retain_until <= ? LIMIT ?
    )`).bind(now, limit).run();
    return result.meta.changes;
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM jobs WHERE id = ?").bind(id).run();
  }

  private async select(query: string, key: string): Promise<JobRow | null> {
    const row = await this.db.prepare(query).bind(key).first<D1JobRow>();
    return row ? toJob(row) : null;
  }
}

export class R2ArtifactStore implements ArtifactStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.bucket.put(key, bytes, {
      httpMetadata: { contentType, cacheControl: "private, no-store" },
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return new Uint8Array(await object.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}

interface D1PaidToolCallRow {
  id: string;
  request_key: string;
  payment_key: string | null;
  payment_fingerprint: string;
  tool: string;
  input_hash: string;
  payer: string;
  state: PaidToolCallState;
  created_at: number;
  expires_at: number;
  result_json: string | null;
  settlement_json: string | null;
  error_code: string | null;
}

export class D1PaidToolCallStore implements PaidToolCallStore {
  constructor(private readonly db: D1Database) {}

  findByRequestKey(key: string): Promise<PaidToolCallRow | null> { return this.select("SELECT * FROM paid_tool_calls WHERE request_key = ?", key); }
  findByPaymentKey(key: string): Promise<PaidToolCallRow | null> { return this.select("SELECT * FROM paid_tool_calls WHERE payment_key = ?", key); }

  async insert(row: PaidToolCallRow): Promise<boolean> {
    const result = await this.db.prepare(`INSERT OR IGNORE INTO paid_tool_calls
      (id, request_key, payment_key, payment_fingerprint, tool, input_hash, payer, state, created_at, expires_at, result_json, settlement_json, error_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(row.id, row.requestKey, row.paymentKey, row.paymentFingerprint, row.tool, row.inputHash, row.payer, row.state,
        row.createdAt, row.expiresAt, row.resultJson, row.settlement ? JSON.stringify(row.settlement) : null, row.errorCode).run();
    return result.meta.changes === 1;
  }

  async update(id: string, state: PaidToolCallState, options: Parameters<PaidToolCallStore["update"]>[2] = {}): Promise<boolean> {
    const sets = ["state = ?"];
    const values: unknown[] = [state];
    if ("resultJson" in options) { sets.push("result_json = ?"); values.push(options.resultJson ?? null); }
    if ("settlement" in options) { sets.push("settlement_json = ?"); values.push(options.settlement ? JSON.stringify(options.settlement) : null); }
    if ("errorCode" in options) { sets.push("error_code = ?"); values.push(options.errorCode ?? null); }
    const conditions = ["id = ?"];
    values.push(id);
    if (options.expectedState) { conditions.push("state = ?"); values.push(options.expectedState); }
    const result = await this.db.prepare(`UPDATE paid_tool_calls SET ${sets.join(", ")} WHERE ${conditions.join(" AND ")}`).bind(...values).run();
    return result.meta.changes === 1;
  }

  async delete(id: string): Promise<void> { await this.db.prepare("DELETE FROM paid_tool_calls WHERE id = ?").bind(id).run(); }

  async cleanupExpired(now: number, limit: number): Promise<number> {
    const result = await this.db.prepare(`UPDATE paid_tool_calls SET state = 'expired', result_json = NULL, error_code = 'expired'
      WHERE id IN (SELECT id FROM paid_tool_calls WHERE expires_at <= ? AND state IN ('complete', 'failed') LIMIT ?)`)
      .bind(now, limit).run();
    return result.meta.changes;
  }

  private async select(query: string, key: string): Promise<PaidToolCallRow | null> {
    const row = await this.db.prepare(query).bind(key).first<D1PaidToolCallRow>();
    return row ? toPaidToolCall(row) : null;
  }
}

interface D1PdfDocumentRow {
  id: string;
  idempotency_hash: string;
  request_hash: string;
  recovery_hash: string;
  content_hash: string;
  capability_hash: string;
  file_name: string;
  page_count: number;
  created_at: number;
  expires_at: number;
  source_key: string;
  index_key: string;
  payment_key?: string | null;
  payment_fingerprint?: string | null;
  payer?: string | null;
  payment_state?: string | null;
  settlement_json?: string | null;
  error_code?: string | null;
}

export class D1PdfDocumentStore implements PdfDocumentStore {
  constructor(private readonly db: D1Database) {}

  findByIdempotencyHash(hash: string): Promise<PdfDocumentRow | null> {
    return this.select("SELECT * FROM pdf_documents WHERE idempotency_hash = ?", hash);
  }

  get(id: string): Promise<PdfDocumentRow | null> {
    return this.select("SELECT * FROM pdf_documents WHERE id = ?", id);
  }

  findByPaymentKey(key: string): Promise<PdfDocumentRow | null> {
    return this.select("SELECT * FROM pdf_documents WHERE payment_key = ?", key);
  }

  async insert(row: PdfDocumentRow): Promise<boolean> {
    const result = await this.db.prepare(`INSERT OR IGNORE INTO pdf_documents
      (id, idempotency_hash, request_hash, recovery_hash, content_hash, capability_hash, file_name, page_count, created_at, expires_at, source_key, index_key, payment_key, payment_fingerprint, payer, payment_state, settlement_json, error_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(row.id, row.idempotencyHash, row.requestHash, row.recoveryHash, row.contentHash, row.capabilityHash, row.fileName, row.pageCount, row.createdAt, row.expiresAt, row.sourceKey, row.indexKey, row.paymentKey ?? null, row.paymentFingerprint ?? null, row.payer ?? null, row.paymentState ?? "complete", row.settlement ? JSON.stringify(row.settlement) : null, row.errorCode ?? null).run();
    return result.meta.changes === 1;
  }

  async updatePayment(id: string, state: NonNullable<PdfDocumentRow["paymentState"]>, settlement: PdfDocumentRow["settlement"] = null, errorCode: string | null = null, expectedState?: NonNullable<PdfDocumentRow["paymentState"]>): Promise<boolean> {
    const query = expectedState ? "UPDATE pdf_documents SET payment_state = ?, settlement_json = ?, error_code = ? WHERE id = ? AND payment_state = ?" : "UPDATE pdf_documents SET payment_state = ?, settlement_json = ?, error_code = ? WHERE id = ?";
    const bindings = expectedState ? [state, settlement ? JSON.stringify(settlement) : null, errorCode, id, expectedState] : [state, settlement ? JSON.stringify(settlement) : null, errorCode, id];
    const result = await this.db.prepare(query).bind(...bindings).run();
    return result.meta.changes === 1;
  }

  async listExpired(now: number, limit: number): Promise<PdfDocumentRow[]> {
    const result = await this.db.prepare("SELECT * FROM pdf_documents WHERE expires_at <= ? ORDER BY expires_at LIMIT ?").bind(now, limit).all<D1PdfDocumentRow>();
    return (result.results ?? []).map(toPdfDocument);
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM pdf_documents WHERE id = ?").bind(id).run();
  }

  private async select(query: string, value: string): Promise<PdfDocumentRow | null> {
    const row = await this.db.prepare(query).bind(value).first<D1PdfDocumentRow>();
    return row ? toPdfDocument(row) : null;
  }
}

function toJob(row: D1JobRow): JobRow {
  return {
    id: row.id,
    requestKey: row.request_key,
    paymentKey: row.payment_key,
    paymentFingerprint: row.payment_fingerprint,
    inputHash: row.input_hash,
    capabilityHash: row.capability_hash,
    title: row.title,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paymentRetainUntil: row.payment_retain_until,
    artifactKey: row.artifact_key,
    artifactBytes: row.artifact_bytes,
    settlement: row.settlement_json ? JSON.parse(row.settlement_json) : null,
    errorCode: row.error_code,
    leaseUntil: row.lease_until,
    leaseToken: row.lease_token,
  };
}

function toPdfDocument(row: D1PdfDocumentRow): PdfDocumentRow {
  return {
    id: row.id,
    idempotencyHash: row.idempotency_hash,
    requestHash: row.request_hash,
    recoveryHash: row.recovery_hash,
    contentHash: row.content_hash,
    capabilityHash: row.capability_hash,
    fileName: row.file_name,
    pageCount: row.page_count,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    sourceKey: row.source_key,
    indexKey: row.index_key,
    paymentKey: row.payment_key ?? null,
    paymentFingerprint: row.payment_fingerprint ?? null,
    payer: row.payer ?? null,
    ...(row.payment_state == null ? {} : { paymentState: row.payment_state as NonNullable<PdfDocumentRow["paymentState"]> }),
    settlement: row.settlement_json ? JSON.parse(row.settlement_json) : null,
    errorCode: row.error_code ?? null,
  };
}

function toPaidToolCall(row: D1PaidToolCallRow): PaidToolCallRow {
  return {
    id: row.id,
    requestKey: row.request_key,
    paymentKey: row.payment_key,
    paymentFingerprint: row.payment_fingerprint,
    tool: row.tool,
    inputHash: row.input_hash,
    payer: row.payer,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resultJson: row.result_json,
    settlement: row.settlement_json ? JSON.parse(row.settlement_json) : null,
    errorCode: row.error_code,
  };
}
