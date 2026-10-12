import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ArtifactStore, JobRow, JobState, JobStore, NewJobRow, PaidToolCallRow, PaidToolCallState, PaidToolCallStore, PdfDocumentRow, PdfDocumentStore } from "./types.js";

const schema = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  payment_key TEXT UNIQUE,
  payment_fingerprint TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  capability_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  payment_retain_until INTEGER NOT NULL,
  artifact_key TEXT,
  artifact_bytes INTEGER,
  settlement_json TEXT,
  error_code TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT
);
CREATE INDEX IF NOT EXISTS jobs_expiry_idx ON jobs(expires_at);
CREATE TABLE IF NOT EXISTS pdf_documents (
  id TEXT PRIMARY KEY,
  idempotency_hash TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  capability_hash TEXT NOT NULL,
  file_name TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  index_key TEXT NOT NULL,
  payment_key TEXT UNIQUE,
  payment_fingerprint TEXT,
  payer TEXT,
  payment_state TEXT NOT NULL DEFAULT 'complete',
  settlement_json TEXT,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS pdf_documents_expiry_idx ON pdf_documents(expires_at);
CREATE TABLE IF NOT EXISTS paid_tool_calls (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  payment_key TEXT UNIQUE,
  payment_fingerprint TEXT NOT NULL,
  tool TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  payer TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  result_json TEXT,
  settlement_json TEXT,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS paid_tool_calls_expiry_idx ON paid_tool_calls(expires_at);
`;

export class SqliteJobStore implements JobStore {
  private readonly db: DatabaseSync;

  constructor(path = ".data/jobs.sqlite") {
    const absolute = resolve(path);
    if (path !== ":memory:") mkdirSync(dirname(absolute), { recursive: true });
    this.db = new DatabaseSync(path === ":memory:" ? path : absolute);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(schema);
    for (const statement of [
      "ALTER TABLE pdf_documents ADD COLUMN payment_key TEXT",
      "ALTER TABLE pdf_documents ADD COLUMN payment_fingerprint TEXT",
      "ALTER TABLE pdf_documents ADD COLUMN payer TEXT",
      "ALTER TABLE pdf_documents ADD COLUMN payment_state TEXT NOT NULL DEFAULT 'complete'",
      "ALTER TABLE pdf_documents ADD COLUMN settlement_json TEXT",
      "ALTER TABLE pdf_documents ADD COLUMN error_code TEXT",
    ]) { try { this.db.exec(statement); } catch { /* column already exists */ } }
    try { this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS pdf_documents_payment_key_idx ON pdf_documents(payment_key) WHERE payment_key IS NOT NULL"); } catch { /* older SQLite may already have it */ }
  }

  async findByRequestKey(key: string): Promise<JobRow | null> {
    return this.row(this.db.prepare("SELECT * FROM jobs WHERE request_key = ?").get(key));
  }

  async findByPaymentKey(key: string): Promise<JobRow | null> {
    return this.row(this.db.prepare("SELECT * FROM jobs WHERE payment_key = ?").get(key));
  }

  async insertJob(job: NewJobRow): Promise<boolean> {
    try {
      this.db.prepare(`INSERT INTO jobs
        (id, request_key, payment_key, payment_fingerprint, input_hash, capability_hash, title, state, created_at, expires_at, payment_retain_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`)
        .run(job.id, job.requestKey, job.paymentKey, job.paymentFingerprint, job.inputHash, job.capabilityHash,
          job.title, job.createdAt, job.expiresAt, job.paymentRetainUntil);
      return true;
    } catch (error) {
      if (isUniqueConstraint(error)) return false;
      throw error;
    }
  }

  async acquire(id: string, now: number, leaseUntil: number, leaseToken: string): Promise<boolean> {
    const result = this.db.prepare(`UPDATE jobs SET lease_until = ?, lease_token = ?
      WHERE id = ? AND state IN ('reserved', 'rendered', 'render_failed') AND lease_until <= ?`)
      .run(leaseUntil, leaseToken, id, now);
    return Number(result.changes) === 1;
  }

  async updateState(id: string, state: JobState, options: Parameters<JobStore["updateState"]>[2] = {}): Promise<boolean> {
    const sets = ["state = ?"];
    const values: (string | number | null)[] = [state];
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
    const result = this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE ${conditions.join(" AND ")}`).run(...values);
    return Number(result.changes) === 1;
  }

  async get(id: string): Promise<JobRow | null> {
    return this.row(this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id));
  }

  async listExpired(now: number, limit: number): Promise<JobRow[]> {
    return this.db.prepare(`SELECT * FROM jobs WHERE ((expires_at <= ? AND state != 'expired') OR (state = 'expired' AND artifact_key IS NOT NULL))
      AND state NOT IN ('settling', 'settlement_unknown') AND lease_until <= ? ORDER BY expires_at LIMIT ?`)
      .all(now, now, limit).map((row) => this.row(row)).filter((row): row is JobRow => row !== null);
  }

  async purgeExpiredTombstones(now: number, limit: number): Promise<number> {
    const result = this.db.prepare(`DELETE FROM jobs WHERE id IN (
      SELECT id FROM jobs WHERE state = 'expired' AND artifact_key IS NULL AND payment_retain_until <= ? LIMIT ?
    )`).run(now, limit);
    return Number(result.changes);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }

  private row(value: unknown): JobRow | null {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    return {
      id: String(row.id),
      requestKey: String(row.request_key),
      paymentKey: row.payment_key === null ? null : String(row.payment_key),
      paymentFingerprint: String(row.payment_fingerprint),
      inputHash: String(row.input_hash),
      capabilityHash: String(row.capability_hash),
      title: String(row.title),
      state: String(row.state) as JobState,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      paymentRetainUntil: Number(row.payment_retain_until),
      artifactKey: row.artifact_key === null ? null : String(row.artifact_key),
      artifactBytes: row.artifact_bytes === null ? null : Number(row.artifact_bytes),
      settlement: row.settlement_json ? JSON.parse(String(row.settlement_json)) : null,
      errorCode: row.error_code === null ? null : String(row.error_code),
      leaseUntil: Number(row.lease_until),
      leaseToken: row.lease_token === null ? null : String(row.lease_token),
    };
  }
}

export class FileArtifactStore implements ArtifactStore {
  private readonly root: string;

  constructor(path = ".data/objects") {
    this.root = resolve(path);
    mkdirSync(this.root, { recursive: true });
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const { rename, unlink, writeFile } = await import("node:fs/promises");
    const target = this.pathFor(key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const { readFile } = await import("node:fs/promises");
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const { unlink } = await import("node:fs/promises");
    try {
      await unlink(this.pathFor(key));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  private pathFor(key: string): string {
    if (!/^[a-f0-9-]{36}\.(pdf|json|png)$/.test(key)) throw new Error("invalid artifact key");
    return join(this.root, key);
  }
}

export class SqlitePdfDocumentStore implements PdfDocumentStore {
  private readonly db: DatabaseSync;

  constructor(path = ".data/documents.sqlite") {
    const absolute = resolve(path);
    if (path !== ":memory:") mkdirSync(dirname(absolute), { recursive: true });
    this.db = new DatabaseSync(path === ":memory:" ? path : absolute);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(schema);
  }

  async findByIdempotencyHash(hash: string): Promise<PdfDocumentRow | null> {
    return this.row(this.db.prepare("SELECT * FROM pdf_documents WHERE idempotency_hash = ?").get(hash));
  }

  async get(id: string): Promise<PdfDocumentRow | null> {
    return this.row(this.db.prepare("SELECT * FROM pdf_documents WHERE id = ?").get(id));
  }

  async findByPaymentKey(key: string): Promise<PdfDocumentRow | null> {
    return this.row(this.db.prepare("SELECT * FROM pdf_documents WHERE payment_key = ?").get(key));
  }

  async insert(row: PdfDocumentRow): Promise<boolean> {
    try {
      this.db.prepare(`INSERT INTO pdf_documents
        (id, idempotency_hash, request_hash, recovery_hash, content_hash, capability_hash, file_name, page_count, created_at, expires_at, source_key, index_key, payment_key, payment_fingerprint, payer, payment_state, settlement_json, error_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.id, row.idempotencyHash, row.requestHash, row.recoveryHash, row.contentHash, row.capabilityHash,
          row.fileName, row.pageCount, row.createdAt, row.expiresAt, row.sourceKey, row.indexKey, row.paymentKey ?? null, row.paymentFingerprint ?? null, row.payer ?? null, row.paymentState ?? "complete", row.settlement ? JSON.stringify(row.settlement) : null, row.errorCode ?? null);
      return true;
    } catch (error) {
      if (isUniqueConstraint(error)) return false;
      throw error;
    }
  }

  async updatePayment(id: string, state: NonNullable<PdfDocumentRow["paymentState"]>, settlement: PdfDocumentRow["settlement"] = null, errorCode: string | null = null, expectedState?: NonNullable<PdfDocumentRow["paymentState"]>): Promise<boolean> {
    const condition = expectedState ? " AND payment_state = ?" : "";
    const values = expectedState ? [state, settlement ? JSON.stringify(settlement) : null, errorCode, id, expectedState] : [state, settlement ? JSON.stringify(settlement) : null, errorCode, id];
    const result = this.db.prepare(`UPDATE pdf_documents SET payment_state = ?, settlement_json = ?, error_code = ? WHERE id = ?${condition}`).run(...values);
    return Number(result.changes) === 1;
  }

  async listExpired(now: number, limit: number): Promise<PdfDocumentRow[]> {
    return this.db.prepare("SELECT * FROM pdf_documents WHERE expires_at <= ? ORDER BY expires_at LIMIT ?")
      .all(now, limit).map((row) => this.row(row)).filter((row): row is PdfDocumentRow => row !== null);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM pdf_documents WHERE id = ?").run(id);
  }

  close(): void { this.db.close(); }

  private row(value: unknown): PdfDocumentRow | null {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    return {
      id: String(row.id),
      idempotencyHash: String(row.idempotency_hash),
      requestHash: String(row.request_hash),
      recoveryHash: String(row.recovery_hash),
      contentHash: String(row.content_hash),
      capabilityHash: String(row.capability_hash),
      fileName: String(row.file_name),
      pageCount: Number(row.page_count),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      sourceKey: String(row.source_key),
      indexKey: String(row.index_key),
      paymentKey: row.payment_key == null ? null : String(row.payment_key),
      paymentFingerprint: row.payment_fingerprint == null ? null : String(row.payment_fingerprint),
      payer: row.payer == null ? null : String(row.payer),
      ...(row.payment_state == null ? {} : { paymentState: String(row.payment_state) as NonNullable<PdfDocumentRow["paymentState"]> }),
      settlement: row.settlement_json ? JSON.parse(String(row.settlement_json)) : null,
      errorCode: row.error_code == null ? null : String(row.error_code),
    };
  }
}

export class SqlitePaidToolCallStore implements PaidToolCallStore {
  private readonly db: DatabaseSync;

  constructor(path = ".data/paid-tools.sqlite") {
    const absolute = resolve(path);
    if (path !== ":memory:") mkdirSync(dirname(absolute), { recursive: true });
    this.db = new DatabaseSync(path === ":memory:" ? path : absolute);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(schema);
  }

  async findByRequestKey(key: string): Promise<PaidToolCallRow | null> {
    return this.row(this.db.prepare("SELECT * FROM paid_tool_calls WHERE request_key = ?").get(key));
  }

  async findByPaymentKey(key: string): Promise<PaidToolCallRow | null> {
    return this.row(this.db.prepare("SELECT * FROM paid_tool_calls WHERE payment_key = ?").get(key));
  }

  async insert(row: PaidToolCallRow): Promise<boolean> {
    try {
      this.db.prepare(`INSERT INTO paid_tool_calls
        (id, request_key, payment_key, payment_fingerprint, tool, input_hash, payer, state, created_at, expires_at, result_json, settlement_json, error_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.id, row.requestKey, row.paymentKey, row.paymentFingerprint, row.tool, row.inputHash, row.payer, row.state,
          row.createdAt, row.expiresAt, row.resultJson, row.settlement ? JSON.stringify(row.settlement) : null, row.errorCode);
      return true;
    } catch (error) {
      if (isUniqueConstraint(error)) return false;
      throw error;
    }
  }

  async update(id: string, state: PaidToolCallState, options: Parameters<PaidToolCallStore["update"]>[2] = {}): Promise<boolean> {
    const sets = ["state = ?"];
    const values: (string | null)[] = [state];
    if ("resultJson" in options) { sets.push("result_json = ?"); values.push(options.resultJson ?? null); }
    if ("settlement" in options) { sets.push("settlement_json = ?"); values.push(options.settlement ? JSON.stringify(options.settlement) : null); }
    if ("errorCode" in options) { sets.push("error_code = ?"); values.push(options.errorCode ?? null); }
    const conditions = ["id = ?"];
    values.push(id);
    if (options.expectedState) { conditions.push("state = ?"); values.push(options.expectedState); }
    const result = this.db.prepare(`UPDATE paid_tool_calls SET ${sets.join(", ")} WHERE ${conditions.join(" AND ")}`).run(...values);
    return Number(result.changes) === 1;
  }

  async delete(id: string): Promise<void> { this.db.prepare("DELETE FROM paid_tool_calls WHERE id = ?").run(id); }

  async cleanupExpired(now: number, limit: number): Promise<number> {
    const result = this.db.prepare(`UPDATE paid_tool_calls SET state = 'expired', result_json = NULL, error_code = 'expired'
      WHERE id IN (SELECT id FROM paid_tool_calls WHERE expires_at <= ? AND state IN ('complete', 'failed') LIMIT ?)`)
      .run(now, limit);
    return Number(result.changes);
  }

  close(): void { this.db.close(); }

  private row(value: unknown): PaidToolCallRow | null {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    return {
      id: String(row.id), requestKey: String(row.request_key), paymentKey: row.payment_key == null ? null : String(row.payment_key),
      paymentFingerprint: String(row.payment_fingerprint), tool: String(row.tool), inputHash: String(row.input_hash), payer: String(row.payer),
      state: String(row.state) as PaidToolCallState, createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
      resultJson: row.result_json == null ? null : String(row.result_json), settlement: row.settlement_json ? JSON.parse(String(row.settlement_json)) : null,
      errorCode: row.error_code == null ? null : String(row.error_code),
    };
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
}
