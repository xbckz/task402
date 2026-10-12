import { createHash } from "node:crypto";
import type { PdfInput } from "./types.js";

export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_TITLE_CHARS = 160;
export const DEFAULT_MAX_MARKDOWN_BYTES = 240 * 1024;
export const MAX_MARKDOWN_BYTES = DEFAULT_MAX_MARKDOWN_BYTES;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const JOB_TTL_SECONDS = 24 * 60 * 60;
export const OPERATION_TIMEOUT_MS = 90_000;

/** Check the original Host before the local adapter constructs its trusted URL. */
export function isAllowedLocalHost(host: string | undefined, port: number, publicBaseUrl?: string): boolean {
  if (!host) return false;
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (publicBaseUrl) allowed.add(new URL(publicBaseUrl).host.toLowerCase());
  return allowed.has(host.toLowerCase());
}

export class InputError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export function validatePdfInput(value: unknown, maxMarkdownBytes = DEFAULT_MAX_MARKDOWN_BYTES): PdfInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError("invalid_document", "Request body must be a JSON object.");
  }

  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => key !== "title" && key !== "markdown");
  if (unknownKeys.length) {
    throw new InputError("unknown_fields", `Unsupported field: ${unknownKeys[0]}`);
  }
  if (typeof record.title !== "string" || typeof record.markdown !== "string") {
    throw new InputError("invalid_document", "Both title and markdown must be strings.");
  }

  const title = record.title.trim();
  const markdown = record.markdown.replace(/\r\n?/g, "\n").trim();
  if (!title || title.length > MAX_TITLE_CHARS) {
    throw new InputError("invalid_title", `title must contain 1 to ${MAX_TITLE_CHARS} characters.`);
  }
  if (!markdown) {
    throw new InputError("empty_markdown", "markdown must contain document content.");
  }
  const markdownBytes = Buffer.byteLength(markdown, "utf8");
  if (markdownBytes > maxMarkdownBytes) {
    throw new InputError("document_too_large", `markdown exceeds the ${maxMarkdownBytes} byte limit.`, 413);
  }
  if (markdown.split("\n").length > 20_000) {
    throw new InputError("too_many_lines", "markdown exceeds the 20,000 line limit.", 413);
  }

  return { title, markdown };
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function payloadSemanticKey(payload: unknown): { key: string; payer: string; authorizationExpiresAt: number } {
  if (!payload || typeof payload !== "object") {
    throw new InputError("invalid_payment", "Payment payload is malformed.", 400);
  }
  const candidate = payload as Partial<import("./types.js").PaymentPayloadV2>;
  const accepted = candidate.accepted;
  const payloadData = candidate.payload;
  const authorization = payloadData && typeof payloadData === "object"
    ? (payloadData as Record<string, unknown>).authorization
    : undefined;
  if (!accepted || typeof accepted.network !== "string" || typeof accepted.asset !== "string" ||
      !authorization || typeof authorization !== "object") {
    throw new InputError("invalid_payment", "Only x402 exact EVM authorization payments are supported.", 400);
  }
  const auth = authorization as Record<string, unknown>;
  if (typeof auth.from !== "string" || typeof auth.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(auth.nonce) ||
      typeof auth.validBefore !== "string" || !/^\d+$/.test(auth.validBefore)) {
    throw new InputError("invalid_payment", "Payment authorization must include an EVM payer and 32-byte nonce.", 400);
  }
  const payer = auth.from.toLowerCase();
  const keyMaterial = [accepted.network.toLowerCase(), accepted.asset.toLowerCase(), payer, auth.nonce.toLowerCase()].join("\0");
  const authorizationExpiresAt = Number(auth.validBefore) * 1000;
  if (!Number.isSafeInteger(authorizationExpiresAt) || authorizationExpiresAt < 0) {
    throw new InputError("invalid_payment", "Payment authorization expiry is malformed.", 400);
  }
  return { key: sha256(keyMaterial), payer, authorizationExpiresAt };
}

export function paymentPayloadFingerprint(payload: unknown): string {
  return sha256(stableJson(payload));
}

export function validateIdempotencyKey(value: string | null): string {
  if (!value || value.length < 8 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new InputError("idempotency_key_required", "Send an Idempotency-Key with 8 to 128 letters, digits, '.', '_', ':', or '-'.", 400);
  }
  return value;
}

export function isValidCapability(value: string | null): boolean {
  return !!value && /^[A-Za-z0-9_-]{40,64}$/.test(value);
}

export function isStatsPasswordValid(provided: string, expected: string): boolean {
  if (!provided || !expected || provided.length !== expected.length || provided.length > 256) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}
