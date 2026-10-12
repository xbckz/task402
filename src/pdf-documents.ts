import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PdfDocumentIndex, PdfPageIndex } from "./pdf-document-index.js";
import { sanitizeFilename } from "./document-utils.js";
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_PAGES, MAX_DOCUMENT_INDEX_BYTES, DocumentError } from "./document-constants.js";
import type { ArtifactStore, PdfDocumentRow, PdfDocumentStore } from "./types.js";
import { isValidCapability, sha256, validateIdempotencyKey } from "./security.js";

export const DOCUMENT_TTL_SECONDS = 24 * 60 * 60;
const MAX_READ_PAGES = 10;
const MAX_READ_CHARS = 32_000;
const MAX_SEARCH_QUERY = 200;
const MAX_SEARCH_HITS = 20;

export interface IngestedPdf {
  documentId: string;
  fileName: string;
  pageCount: number;
  contentHash: string;
  createdAt: string;
  expiresAt: string;
  capability: string;
  paymentState: NonNullable<PdfDocumentRow["paymentState"]>;
  resumed?: boolean;
}

export interface DocumentPaymentContext {
  key: string;
  fingerprint: string;
  payer: string;
}

export interface PdfDocumentServiceConfig {
  capabilitySecret: string;
  publicBaseUrl: string;
  parser: PdfDocumentParser;
  ttlSeconds?: number;
}

export interface PdfDocumentParser {
  parse(input: Uint8Array): Promise<PdfDocumentIndex>;
  render(input: Uint8Array, pageNumber: number, crop: { x: number; y: number; width: number; height: number; scale?: number }): Promise<Uint8Array>;
}

/** Capability-protected PDF operations with an injected isolated parser and durable stores. */
export class PdfDocumentService {
  constructor(
    private readonly rows: PdfDocumentStore,
    private readonly artifacts: ArtifactStore,
    private readonly config: PdfDocumentServiceConfig,
  ) {
    if (config.capabilitySecret.length < 32) throw new Error("Document capability secret must contain at least 32 characters.");
  }

  async ingest(input: Uint8Array, fileName: string, idempotencyKeyValue: string | null, recoveryKey: string | null, payment?: DocumentPaymentContext): Promise<IngestedPdf> {
    if (!input.byteLength || input.byteLength > MAX_DOCUMENT_BYTES) {
      throw new DocumentError("document_too_large", `PDF upload must contain 1 to ${MAX_DOCUMENT_BYTES} bytes.`, 413);
    }
    let key: string;
    try { key = validateIdempotencyKey(idempotencyKeyValue); }
    catch (error) { throw new DocumentError("idempotency_key_required", error instanceof Error ? error.message : "Idempotency-Key is required.", 400); }
    if (!recoveryKey || recoveryKey.length < 32 || recoveryKey.length > 256) {
      throw new DocumentError("recovery_key_required", "X-Document-Recovery-Key must be a caller-generated secret of 32 to 256 characters.", 400);
    }
    const safeName = sanitizeFilename(fileName);
    const contentHash = sha256(input);
    const recoveryHash = sha256(recoveryKey);
    // Treat the recovery secret as the request namespace so callers cannot collide across tenants.
    const idempotencyHash = sha256(`pdf-document\0${recoveryHash}\0${key}`);
    const requestHash = sha256(`${contentHash}\0${safeName}`);
    const previous = await this.rows.findByIdempotencyHash(idempotencyHash);
    if (previous) return this.resumeOrReject(previous, requestHash, recoveryHash);
    if (payment && this.rows.findByPaymentKey) {
      const paymentRow = await this.rows.findByPaymentKey(payment.key);
      if (paymentRow) throw new DocumentError("payment_replay", "This exact payment authorization is already bound to another document.", 409);
    }

    const index = await this.config.parser.parse(input);
    if (index.contentHash !== contentHash) throw new DocumentError("document_changed", "PDF bytes changed during indexing; retry with a fresh idempotency key.", 409);
    const now = Date.now();
    const id = randomUUID();
    const row: PdfDocumentRow = {
      id,
      idempotencyHash,
      requestHash,
      recoveryHash,
      contentHash,
      capabilityHash: sha256(this.capabilityFor(id)),
      fileName: safeName,
      pageCount: index.pageCount,
      createdAt: now,
      expiresAt: now + (this.config.ttlSeconds ?? DOCUMENT_TTL_SECONDS) * 1000,
      sourceKey: `${id}.pdf`,
      indexKey: `${id}.json`,
      paymentKey: payment?.key ?? null,
      paymentFingerprint: payment?.fingerprint ?? null,
      payer: payment?.payer ?? null,
      paymentState: payment ? "reserved" : "complete",
      settlement: null,
      errorCode: null,
    };
    // Atomic per-object writes happen before the unique row insert. A lost insert is cleaned up below.
    const indexBytes = new TextEncoder().encode(JSON.stringify(index));
    if (indexBytes.byteLength > MAX_DOCUMENT_INDEX_BYTES) throw new DocumentError("document_index_too_large", `Extracted PDF index exceeds ${MAX_DOCUMENT_INDEX_BYTES} bytes.`, 413);
    await this.artifacts.put(row.sourceKey, Uint8Array.from(input), "application/pdf");
    try {
      await this.artifacts.put(row.indexKey, indexBytes, "application/json");
    } catch (error) {
      await this.artifacts.delete(row.sourceKey).catch(() => undefined);
      throw error;
    }
    let inserted: boolean;
    try { inserted = await this.rows.insert(row); }
    catch (error) {
      await this.artifacts.delete(row.sourceKey).catch(() => undefined);
      await this.artifacts.delete(row.indexKey).catch(() => undefined);
      throw error;
    }
    if (!inserted) {
      await this.artifacts.delete(row.sourceKey).catch(() => undefined);
      await this.artifacts.delete(row.indexKey).catch(() => undefined);
      const winner = await this.rows.findByIdempotencyHash(idempotencyHash);
      if (winner) return this.resumeOrReject(winner, requestHash, recoveryHash);
      throw new DocumentError("document_persistence_failed", "Document reservation could not be committed.", 503);
    }
    return this.toResult(row, this.capabilityFor(id));
  }

  async activatePayment(id: string, settlement: NonNullable<PdfDocumentRow["settlement"]>): Promise<boolean> {
    return this.rows.updatePayment ? this.rows.updatePayment(id, "complete", settlement, null, "settling") : true;
  }

  async claimPaymentSettlement(id: string): Promise<boolean> {
    return this.rows.updatePayment ? this.rows.updatePayment(id, "settling", null, null, "reserved") : true;
  }

  async resume(input: Uint8Array, fileName: string, idempotencyKeyValue: string | null, recoveryKey: string | null): Promise<IngestedPdf | null> {
    let key: string;
    try { key = validateIdempotencyKey(idempotencyKeyValue); } catch { return null; }
    if (!recoveryKey || recoveryKey.length < 32 || recoveryKey.length > 256) return null;
    const safeName = sanitizeFilename(fileName);
    const recoveryHash = sha256(recoveryKey);
    const idempotencyHash = sha256(`pdf-document\0${recoveryHash}\0${key}`);
    const previous = await this.rows.findByIdempotencyHash(idempotencyHash);
    if (!previous) return null;
    const requestHash = sha256(`${sha256(input)}\0${safeName}`);
    if (previous.requestHash !== requestHash) throw new DocumentError("idempotency_conflict", "This Idempotency-Key is already bound to different PDF bytes or a different filename.", 409);
    if (previous.recoveryHash !== recoveryHash) throw notFound();
    if (previous.expiresAt <= Date.now()) throw new DocumentError("document_expired", "The document and its capability have expired; upload it again with a new idempotency key.", 410);
    return this.toResult(previous, this.capabilityFor(previous.id), true);
  }

  async markPaymentUnknown(id: string, errorCode = "settlement_outcome_unknown"): Promise<boolean> {
    return this.rows.updatePayment ? this.rows.updatePayment(id, "settlement_unknown", null, errorCode, "settling") : false;
  }

  async markPaymentFailed(id: string, errorCode = "settlement_failed"): Promise<boolean> {
    return this.rows.updatePayment ? this.rows.updatePayment(id, "payment_failed", null, errorCode, "settling") : false;
  }

  async inspect(id: string, capability: string | null): Promise<Record<string, unknown>> {
    const { row, index } = await this.authorized(id, capability);
    return {
      documentId: row.id,
      fileName: row.fileName,
      contentHash: row.contentHash,
      byteLength: index.byteLength,
      pageCount: index.pageCount,
      metadata: index.metadata,
      bookmarks: index.bookmarks,
      formFields: index.formFields,
      attachments: index.attachments,
      warnings: index.warnings,
      createdAt: new Date(row.createdAt).toISOString(),
      expiresAt: new Date(row.expiresAt).toISOString(),
      operations: ["map", "search", "batch_search", "context", "fields", "read", "citation", "compare", "validate", "render"],
    };
  }

  async getMap(id: string, capability: string | null, pageNumber?: number): Promise<Record<string, unknown>> {
    const { row, index } = await this.authorized(id, capability);
    if (pageNumber !== undefined && (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > index.pageCount)) {
      throw new DocumentError("invalid_page", `page must be between 1 and ${index.pageCount}.`);
    }
    const selectedPages = pageNumber === undefined ? index.pages : [index.pages[pageNumber - 1]!];
    return {
      documentId: row.id,
      pageCount: index.pageCount,
      bookmarks: index.bookmarks,
      pages: selectedPages.map((page) => ({
        page: page.page,
        pageLabel: page.pageLabel,
        width: page.width,
        height: page.height,
        rotation: page.rotation,
        charCount: page.charCount,
        likelyScanned: page.likelyScanned,
        annotationCount: page.annotationCount,
        preview: page.text.slice(0, 240),
        ...(pageNumber !== undefined ? {
          blockCount: page.blocks.length,
          blocksTruncated: page.blocks.length > 500,
          blocks: page.blocks.slice(0, 500).map((block) => ({ blockId: block.blockId, text: block.text.slice(0, 512), bbox: block.bbox, fontSize: block.fontSize })),
        } : {}),
      })),
      warnings: index.warnings,
    };
  }

  async search(id: string, capability: string | null, queryValue: string, options: { page?: number; limit?: number } = {}): Promise<Record<string, unknown>> {
    const { row, index } = await this.authorized(id, capability);
    const query = queryValue.trim();
    if (!query || query.length > MAX_SEARCH_QUERY) throw new DocumentError("invalid_query", `query must contain 1 to ${MAX_SEARCH_QUERY} characters.`);
    const pageFilter = options.page;
    if (pageFilter !== undefined && (!Number.isInteger(pageFilter) || pageFilter < 1 || pageFilter > index.pageCount)) {
      throw new DocumentError("invalid_page", `page must be between 1 and ${index.pageCount}.`);
    }
    const limit = boundedInt(options.limit ?? 10, 1, MAX_SEARCH_HITS, "limit");
    const needle = normalizeText(query).toLocaleLowerCase();
    const hits: Array<Record<string, unknown>> = [];
    let totalMatches = 0;
    for (const page of index.pages) {
      if (pageFilter !== undefined && page.page !== pageFilter) continue;
      const normalized = normalizeText(page.text);
      const haystack = normalized.toLocaleLowerCase();
      let from = 0;
      while (from <= haystack.length - needle.length) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) break;
        totalMatches++;
        if (hits.length < limit) {
          const start = Math.max(0, at - 100);
          const end = Math.min(normalized.length, at + needle.length + 140);
          hits.push({ page: page.page, pageLabel: page.pageLabel, excerpt: normalized.slice(start, end), normalizedOffset: at });
        }
        from = at + Math.max(1, needle.length);
      }
    }
    return { documentId: row.id, query, totalMatches, truncated: totalMatches > hits.length, hits };
  }

  async batchSearch(id: string, capability: string | null, queriesValue: string[], options: { page?: number; limit?: number } = {}): Promise<Record<string, unknown>> {
    const queries = Array.isArray(queriesValue) ? queriesValue : [];
    if (!queries.length || queries.length > 20 || queries.some((query) => typeof query !== "string" || !query.trim() || query.length > MAX_SEARCH_QUERY)) {
      throw new DocumentError("invalid_queries", "queries must contain 1 to 20 non-empty strings of at most 200 characters.");
    }
    const results = [];
    for (const query of queries) results.push(await this.search(id, capability, query, options));
    return { documentId: id, results };
  }

  async extractFields(id: string, capability: string | null, fieldsValue: Array<{ name: string; label: string; page?: number | undefined }>): Promise<Record<string, unknown>> {
    const { row, index } = await this.authorized(id, capability);
    if (!Array.isArray(fieldsValue) || fieldsValue.length < 1 || fieldsValue.length > 20) throw new DocumentError("invalid_fields", "fields must contain 1 to 20 label definitions.");
    const fields = fieldsValue.map((field) => {
      if (!field || typeof field !== "object" || typeof field.name !== "string" || !field.name.trim() || field.name.length > 80 || typeof field.label !== "string" || !normalizeText(field.label) || field.label.length > 160 || (field.page !== undefined && (!Number.isInteger(field.page) || field.page < 1 || field.page > index.pageCount))) throw new DocumentError("invalid_fields", "Each field requires a name and label, with an optional valid page.");
      return { name: field.name.trim(), label: normalizeText(field.label), page: field.page };
    });
    const values = fields.map((field) => {
      const labelLower = field.label.toLocaleLowerCase();
      for (const page of index.pages) {
        if (field.page !== undefined && page.page !== field.page) continue;
        const blocks = page.blocks;
        for (let i = 0; i < blocks.length; i++) {
          const blockText = normalizeText(blocks[i]!.text);
          const at = blockText.toLocaleLowerCase().indexOf(labelLower);
          if (at < 0) continue;
          const inline = blockText.slice(at + field.label.length).replace(/^\s*[:\-–—]\s*/, "").trim();
          const value = inline || normalizeText(blocks[i + 1]?.text ?? "");
          if (!value) continue;
          return { name: field.name, value: value.slice(0, 1000), page: page.page, pageLabel: page.pageLabel, label: field.label, evidence: [{ blockId: blocks[i]!.blockId, bbox: blocks[i]!.bbox }, ...(inline ? [] : blocks[i + 1] ? [{ blockId: blocks[i + 1]!.blockId, bbox: blocks[i + 1]!.bbox }] : [])], method: "literal label with adjacent native-text value" };
        }
      }
      return { name: field.name, value: null, page: null, label: field.label, evidence: [], method: "literal label not found" };
    });
    return { documentId: row.id, fields: values, warning: "This deterministic matcher does not infer semantic fields, OCR scanned pages, or validate values." };
  }

  async prepareContext(id: string, capability: string | null, queryValue: string, maxCharsValue = 12000, pagesValue?: number[]): Promise<Record<string, unknown>> {
    const { row, index } = await this.authorized(id, capability);
    const query = queryValue.trim();
    if (!query || query.length > MAX_SEARCH_QUERY) throw new DocumentError("invalid_query", `query must contain 1 to ${MAX_SEARCH_QUERY} characters.`);
    const maxChars = boundedInt(maxCharsValue, 1000, 32000, "maxChars");
    const requested = pagesValue === undefined ? null : [...new Set(pagesValue)].filter((page) => Number.isInteger(page)).sort((a, b) => a - b);
    if (requested && (!requested.length || requested.some((page) => page < 1 || page > index.pageCount))) throw new DocumentError("invalid_page_selection", "pages must contain valid page numbers.");
    const terms = [...new Set(normalizeText(query).toLocaleLowerCase().split(/\s+/).filter((term) => term.length > 1))];
    const candidates = index.pages.filter((page) => !requested || requested.includes(page.page)).map((page) => {
      const text = normalizeText(page.text);
      const lower = text.toLocaleLowerCase();
      const exact = lower.split(query.toLocaleLowerCase()).length - 1;
      const score = terms.reduce((sum, term) => sum + (lower.split(term).length - 1), 0) + exact * 3;
      return { page, text, score };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.page.page - b.page.page);
    let remaining = maxChars;
    const selected: Array<Record<string, unknown>> = [];
    const evidence: Array<Record<string, unknown>> = [];
    for (const candidate of candidates) {
      if (remaining <= 0) break;
      const lower = candidate.text.toLocaleLowerCase();
      const firstMatch = terms.map((term) => lower.indexOf(term)).filter((at) => at >= 0).sort((a, b) => a - b)[0] ?? 0;
      const start = Math.max(0, firstMatch - Math.min(500, Math.floor(remaining / 3)));
      const prefix = start > 0 ? "[…] " : "";
      const text = `${prefix}${candidate.text.slice(start, start + Math.max(0, remaining - prefix.length))}`;
      if (!text) continue;
      remaining -= text.length;
      selected.push({ page: candidate.page.page, pageLabel: candidate.page.pageLabel, score: candidate.score, text, truncated: text.length < candidate.text.length });
      for (const term of terms.slice(0, 8)) {
        const at = lower.indexOf(term);
        if (at >= 0) evidence.push({ page: candidate.page.page, term, excerpt: candidate.text.slice(Math.max(0, at - 100), Math.min(candidate.text.length, at + term.length + 140)).slice(0, 300), blocks: candidate.page.blocks.filter((block) => normalizeText(block.text).toLocaleLowerCase().includes(term)).slice(0, 4).map((block) => ({ blockId: block.blockId, bbox: block.bbox })) });
      }
    }
    return { documentId: row.id, query, maxChars, selectedPages: selected.map((item) => item.page), omittedPages: candidates.slice(selected.length).map((item) => item.page.page), text: selected.map((item) => `Page ${item.page}:\n${item.text}`).join("\n\n"), pages: selected, evidence: evidence.slice(0, 32), truncated: remaining <= 0 || selected.length < candidates.length, method: "bounded lexical ranking over native PDF text", warning: "This is deterministic native text; scanned pages and semantic relevance require OCR or a model outside the service." };
  }

  async read(id: string, capability: string | null, pagesValue: number[]): Promise<Record<string, unknown>> {
    const { row, index } = await this.authorized(id, capability);
    if (!Array.isArray(pagesValue) || pagesValue.length < 1 || pagesValue.length > MAX_READ_PAGES ||
        pagesValue.some((page) => !Number.isInteger(page) || page < 1 || page > index.pageCount)) {
      throw new DocumentError("invalid_page_selection", `Select 1 to ${MAX_READ_PAGES} page numbers between 1 and ${index.pageCount}.`);
    }
    const pages = [...new Set(pagesValue)].sort((a, b) => a - b);
    let remaining = MAX_READ_CHARS;
    let truncated = false;
    const content = pages.map((pageNumber) => {
      const page = index.pages[pageNumber - 1]!;
      const text = page.text.slice(0, remaining);
      remaining -= text.length;
      if (text.length < page.text.length) truncated = true;
      return { page: page.page, pageLabel: page.pageLabel, text, charCount: page.charCount, truncated: text.length < page.text.length };
    });
    return { documentId: row.id, pages: content, truncated };
  }

  async verifyCitation(id: string, capability: string | null, pageNumber: number, quoteValue: string): Promise<Record<string, unknown>> {
    const { row, index } = await this.authorized(id, capability);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > index.pageCount) throw new DocumentError("invalid_page", `page must be between 1 and ${index.pageCount}.`);
    const quote = normalizeText(quoteValue);
    if (quote.length < 5 || quote.length > 500) throw new DocumentError("invalid_quote", "quote must contain 5 to 500 normalized characters.");
    const page = index.pages[pageNumber - 1]!;
    const normalizedText = normalizeText(page.text);
    const at = normalizedText.indexOf(quote);
    if (at < 0) return { documentId: row.id, verified: false, page: pageNumber, quote, reason: "quote_not_found_in_native_text" };
    const evidence = page.blocks.filter((block) => {
      const blockText = normalizeText(block.text);
      if (!blockText) return false;
      const blockAt = normalizedText.indexOf(blockText);
      return blockAt >= 0 && blockAt < at + quote.length && blockAt + blockText.length > at;
    }).slice(0, 12).map((block) => ({ blockId: block.blockId, text: block.text, bbox: block.bbox }));
    return {
      documentId: row.id,
      verified: true,
      page: pageNumber,
      pageLabel: page.pageLabel,
      quote,
      pageTextOffset: at,
      evidence,
      method: "exact normalized text match",
      warning: "This verifies extractable text and page location, not the truth of the statement or visual reading order.",
    };
  }

  async compare(leftId: string, leftCapability: string | null, rightId: string, rightCapability: string | null): Promise<Record<string, unknown>> {
    const left = await this.authorized(leftId, leftCapability);
    const right = await this.authorized(rightId, rightCapability);
    const maxPages = Math.max(left.index.pageCount, right.index.pageCount);
    const changedPages: Array<Record<string, unknown>> = [];
    let changedPageCount = 0;
    for (let page = 1; page <= maxPages; page++) {
      const oldPage = left.index.pages[page - 1];
      const newPage = right.index.pages[page - 1];
      if (oldPage && newPage && normalizeText(oldPage.text) === normalizeText(newPage.text)) continue;
      changedPageCount++;
      if (changedPages.length >= 100) continue;
      changedPages.push({
        page,
        leftPresent: Boolean(oldPage),
        rightPresent: Boolean(newPage),
        leftChars: oldPage?.charCount ?? 0,
        rightChars: newPage?.charCount ?? 0,
        leftExcerpt: oldPage?.text.slice(0, 240) ?? null,
        rightExcerpt: newPage?.text.slice(0, 240) ?? null,
      });
    }
    return {
      left: { documentId: left.row.id, contentHash: left.row.contentHash, pageCount: left.index.pageCount },
      right: { documentId: right.row.id, contentHash: right.row.contentHash, pageCount: right.index.pageCount },
      identicalBytes: left.row.contentHash === right.row.contentHash,
      identicalExtractedPageText: changedPageCount === 0 && left.index.pageCount === right.index.pageCount,
      changedPageCount,
      changedPages,
      truncated: changedPageCount > changedPages.length,
      method: "page-by-page normalized native-text comparison",
      warning: "Visual changes, image-only differences, metadata, annotations, and page reflow within equivalent text are not compared.",
    };
  }

  async validate(id: string, capability: string | null, expectations: { pageCount?: number; requiredText?: string[] } = {}): Promise<Record<string, unknown>> {
    const { row, index } = await this.authorized(id, capability);
    if (expectations.pageCount !== undefined && (!Number.isInteger(expectations.pageCount) || expectations.pageCount < 1 || expectations.pageCount > MAX_DOCUMENT_PAGES)) {
      throw new DocumentError("invalid_expectation", `pageCount must be between 1 and ${MAX_DOCUMENT_PAGES}.`);
    }
    const requiredText = expectations.requiredText ?? [];
    if (!Array.isArray(requiredText) || requiredText.length > 20 || requiredText.some((text) => typeof text !== "string" || !normalizeText(text) || text.length > 500)) {
      throw new DocumentError("invalid_expectation", "requiredText must contain at most 20 strings of 1 to 500 characters.");
    }
    const fullText = normalizeText(index.pages.map((page) => page.text).join("\n")).toLocaleLowerCase();
    const checks = [
      { check: "pdf_parse", passed: true, detail: "PDF.js parsed the document and indexed every page." },
      { check: "page_count", passed: expectations.pageCount === undefined || expectations.pageCount === index.pageCount, expected: expectations.pageCount ?? null, actual: index.pageCount },
      ...requiredText.map((text) => ({ check: "required_text", value: text, passed: fullText.includes(normalizeText(text).toLocaleLowerCase()) })),
      { check: "native_text_coverage", passed: index.pages.some((page) => !page.likelyScanned), scannedOrSparsePages: index.pages.filter((page) => page.likelyScanned).map((page) => page.page) },
    ];
    return {
      documentId: row.id,
      valid: checks.every((check) => check.passed),
      checks,
      warnings: [...index.warnings, "PDF/A conformance, cryptographic signatures, visual layout, and image-only text were not validated."],
    };
  }

  async renderPage(id: string, capability: string | null, pageNumber: number, crop: { x: number; y: number; width: number; height: number; scale?: number }): Promise<Uint8Array> {
    const { row, index } = await this.authorized(id, capability);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > index.pageCount) throw new DocumentError("invalid_page", `page must be between 1 and ${index.pageCount}.`);
    const { x, y, width, height } = crop;
    const scale = crop.scale ?? 1.5;
    if (![x, y, width, height, scale].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1 || scale < 0.5 || scale > 3) {
      throw new DocumentError("invalid_crop", "Crop x/y/width/height must fit in normalized page bounds; scale must be 0.5 to 3.");
    }
    const bytes = await this.artifacts.get(row.sourceKey);
    if (!bytes) throw new DocumentError("document_artifact_missing", "The retained PDF file is missing.", 503);
    return this.config.parser.render(bytes, pageNumber, { x, y, width, height, scale });
  }

  async cleanupExpired(limit = 100): Promise<number> {
    const expired = await this.rows.listExpired(Date.now(), Math.min(Math.max(limit, 1), 500));
    let cleaned = 0;
    for (const row of expired) {
      if (row.paymentState === "settling" || row.paymentState === "settlement_unknown") continue;
      try {
        await this.artifacts.delete(row.sourceKey);
        await this.artifacts.delete(row.indexKey);
        await this.rows.delete(row.id);
        cleaned++;
      } catch { /* The row remains eligible and cleanup can retry. */ }
    }
    return cleaned;
  }

  documentUrls(id: string): { inspectUrl: string; mapUrl: string } {
    const base = this.config.publicBaseUrl.replace(/\/+$/, "");
    return { inspectUrl: `${base}/v1/documents/${id}`, mapUrl: `${base}/v1/documents/${id}/map` };
  }

  private async authorized(id: string, capability: string | null): Promise<{ row: PdfDocumentRow; index: PdfDocumentIndex }> {
    if (!isUuid(id) || !isValidCapability(capability)) throw notFound();
    const row = await this.rows.get(id);
    if (!row || row.expiresAt <= Date.now()) throw notFound();
    if (row.paymentState === "reserved" || row.paymentState === "settlement_unknown") throw new DocumentError("payment_recovery_pending", "Document payment has not reached a definitive settlement. Access is held until it is reconciled.", 503);
    if (row.paymentState === "payment_failed") throw notFound();
    const supplied = Buffer.from(sha256(capability!), "hex");
    const expected = Buffer.from(row.capabilityHash, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw notFound();
    const bytes = await this.artifacts.get(row.indexKey);
    if (!bytes || bytes.byteLength > MAX_DOCUMENT_INDEX_BYTES) throw new DocumentError("document_index_missing", "The retained text index is missing or exceeds the read limit.", 503);
    try { return { row, index: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as PdfDocumentIndex }; }
    catch { throw new DocumentError("document_index_corrupt", "The retained text index could not be read.", 503); }
  }

  private resumeOrReject(row: PdfDocumentRow, requestHash: string, recoveryHash: string): IngestedPdf {
    if (row.expiresAt <= Date.now()) throw new DocumentError("document_expired", "The document and its capability have expired; upload it again with a new idempotency key.", 410);
    if (row.requestHash !== requestHash) throw new DocumentError("idempotency_conflict", "This Idempotency-Key is already bound to different PDF bytes or a different filename.", 409);
    if (row.recoveryHash !== recoveryHash) throw notFound();
    return this.toResult(row, this.capabilityFor(row.id), true);
  }

  private toResult(row: PdfDocumentRow, capability: string, resumed = false): IngestedPdf {
    return {
      documentId: row.id,
      fileName: row.fileName,
      pageCount: row.pageCount,
      contentHash: row.contentHash,
      createdAt: new Date(row.createdAt).toISOString(),
      expiresAt: new Date(row.expiresAt).toISOString(),
      capability,
      ...(resumed ? { resumed: true } : {}),
      paymentState: row.paymentState ?? "complete",
    };
  }

  private capabilityFor(id: string): string { return createHmac("sha256", this.config.capabilitySecret).update(`pdf-document:${id}`).digest("base64url"); }
}

function normalizeText(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function boundedInt(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new DocumentError("invalid_argument", `${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}
function notFound(): DocumentError { return new DocumentError("document_not_found", "The document does not exist, has expired, or its capability is invalid.", 404); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
