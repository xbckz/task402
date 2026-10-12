import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface DocumentHandle { documentId: string; capability: string; }
export interface UploadRecovery { idempotencyKey: string; recoveryKey: string; }
export interface PendingGeneration { idempotencyKey: string; input: { title: string; markdown: string }; challenge: Record<string, unknown>; }
export interface PendingUpload { recovery: UploadRecovery; bytes: Uint8Array; fileName: string; challenge: Record<string, unknown>; }

/** Values are secret state; persist securely BEFORE upload if crash recovery is needed. */
export function createRecovery(): UploadRecovery {
  return { idempotencyKey: randomUUID(), recoveryKey: randomBytes(32).toString("base64url") };
}

/** No wallet, private key, payment header or automatic paid retry is used in this client. */
export class Task402Client {
  private readonly origin: string;
  constructor(baseUrl = "https://task402.xyz", private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Use a trusted HTTPS origin.");
    this.origin = url.origin;
  }
  async discover() { return this.json("/v1/pricing"); }
  /** Obtain an unsigned x402 challenge for PDF indexing. Keep the bytes and recovery state private. */
  async uploadChallenge(bytes: Uint8Array, recovery: UploadRecovery, fileName = "document.pdf"): Promise<PendingUpload> {
    const response = await this.fetcher(`${this.origin}/v1/documents`, { method: "POST", headers: {
      "content-type": "application/pdf", "idempotency-key": recovery.idempotencyKey,
      "x-document-recovery-key": recovery.recoveryKey, "x-file-name": fileName,
    }, body: Uint8Array.from(bytes), redirect: "error" });
    const value = await response.json() as Record<string, unknown>;
    if (response.status !== 402 || !value.paymentRequired || typeof value.paymentRequired !== "object") throw new Error("Expected an unsigned x402 v2 indexing challenge.");
    return { recovery, bytes, fileName, challenge: value.paymentRequired as Record<string, unknown> };
  }
  /** Retry the exact upload after a separately approved external wallet signature. */
  async retryApprovedUpload(pending: PendingUpload, approvedPayload: Record<string, unknown>) {
    return this.json("/v1/documents", { method: "POST", headers: {
      "content-type": "application/pdf", "idempotency-key": pending.recovery.idempotencyKey,
      "x-document-recovery-key": pending.recovery.recoveryKey, "x-file-name": pending.fileName,
      "payment-signature": Buffer.from(JSON.stringify(approvedPayload)).toString("base64"),
    }, body: Uint8Array.from(pending.bytes) });
  }
  /** Convenience wrapper for callers that already have a separately approved payment payload. */
  async upload(bytes: Uint8Array, recovery: UploadRecovery, approvedPayload?: Record<string, unknown>, fileName = "document.pdf"): Promise<DocumentHandle | PendingUpload> {
    if (!approvedPayload) return this.uploadChallenge(bytes, recovery, fileName);
    const value = await this.retryApprovedUpload({ recovery, bytes, fileName, challenge: {} }, approvedPayload);
    if (typeof value.documentId !== "string" || typeof value.capability !== "string") throw new Error("Upload returned an incomplete document handle.");
    return { documentId: value.documentId, capability: value.capability };
  }
  async search(document: DocumentHandle, query: string) { return this.operation(document, "search", { query, limit: 5 }); }
  async read(document: DocumentHandle, pages: number[]) { return this.operation(document, "read", { pages }); }
  async verifyCitation(document: DocumentHandle, page: number, quote: string) { return this.operation(document, "citation", { page, quote }); }
  async compare(left: DocumentHandle, right: DocumentHandle) {
    return this.json("/v1/documents/compare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leftId: left.documentId, leftCapability: left.capability, rightId: right.documentId, rightCapability: right.capability }) });
  }
  /** Only obtains a challenge. This method cannot settle a payment. */
  async generationChallenge(input: PendingGeneration["input"], idempotencyKey = randomUUID()): Promise<PendingGeneration> {
    const response = await this.fetcher(`${this.origin}/v1/pdf`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify(input), redirect: "error" });
    const value = await response.json() as { paymentRequired?: Record<string, unknown> };
    if (response.status !== 402 || value.paymentRequired?.x402Version !== 2) throw new Error("Expected an unsigned x402 v2 challenge.");
    return { idempotencyKey, input, challenge: value.paymentRequired };
  }
  /** Call ONLY after separate human approval and external signing. Never used by main(). */
  async retryApprovedGeneration(pending: PendingGeneration, approvedPayload: Record<string, unknown>) {
    return this.json("/v1/pdf", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": pending.idempotencyKey, "payment-signature": Buffer.from(JSON.stringify(approvedPayload)).toString("base64") }, body: JSON.stringify(pending.input) });
  }
  async mcpSearch(document: DocumentHandle, query: string) {
    const client = new Client({ name: "task402-free-example", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${this.origin}/mcp`)) as unknown as Parameters<typeof client.connect>[0]);
      await client.listTools();
      return await client.callTool({ name: "search_document", arguments: { document_id: document.documentId, capability: document.capability, query, limit: 5 } });
    } finally { await client.close(); }
  }
  private operation(document: DocumentHandle, operation: string, body: unknown) {
    return this.json(`/v1/documents/${encodeURIComponent(document.documentId)}/${operation}`, { method: "POST", headers: { authorization: `Bearer ${document.capability}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  private async json(path: string, init: RequestInit = {}): Promise<Record<string, any>> {
    const response = await this.fetcher(this.origin + path, { ...init, redirect: "error" });
    const value = await response.json() as Record<string, any>;
    // Do not print response bodies: errors may contain recovery/job capability details.
    if (!response.ok) throw new Error(`Task402 returned HTTP ${response.status}; retain private recovery state and inspect the response securely.`);
    return value;
  }
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: npx tsx examples/agent-flow.ts ./document.pdf [search term]");
  const api = new Task402Client();
  await api.discover();
  const recovery = createRecovery();
  const pendingUpload = await api.uploadChallenge(new Uint8Array(await readFile(file)), recovery);
  const pending = await api.generationChallenge({ title: "Unsigned example", markdown: "# Preview\n\nNo payment is signed by this script." });
  // Only non-secret summary fields are logged. Handles/recovery/challenge remain in memory.
  console.log(JSON.stringify({ indexingX402Version: pendingUpload.challenge.x402Version, generationX402Version: pending.challenge.x402Version, paymentSigned: false }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) void main().catch(() => { console.error("Example failed; no payment was signed. Keep any recovery state private."); process.exitCode = 1; });
