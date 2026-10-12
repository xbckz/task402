import { DurableObject } from "cloudflare:workers";
import { MAX_DOCUMENT_INDEX_BYTES } from "./document-constants.js";

export interface DocumentContainerEnv { DOCUMENT_CONTAINER_TOKEN: string; }

export class DocumentParserContainer extends DurableObject<DocumentContainerEnv> {
  private busy = false;

  async fetch(request: Request): Promise<Response> {
    if (!this.env.DOCUMENT_CONTAINER_TOKEN || request.headers.get("x-document-container-token") !== this.env.DOCUMENT_CONTAINER_TOKEN) return new Response("Not found", { status: 404 });
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/parse", "/render"].includes(path)) return new Response("Not found", { status: 404 });
    if (this.busy) return Response.json({ error: { code: "document_parser_busy", message: "PDF processing is at capacity; retry shortly." } }, { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } });
    this.busy = true;
    const container = this.ctx.container!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("PDF processing deadline exceeded."));
        }, 60_000);
      });
      return await Promise.race([this.process(request, controller.signal), deadline]);
    } catch {
      return Response.json({ error: { code: "document_parser_unavailable", message: "PDF processing failed or exceeded its deadline; retry shortly." } }, { status: 503, headers: { "cache-control": "no-store" } });
    } finally {
      if (timer) clearTimeout(timer);
      // Reset process and filesystem between tasks; kill timed-out work outside its blocked event loop.
      try { await container.destroy(); }
      catch { /* The next task also destroys any surviving container before startup. */ }
      finally { this.busy = false; }
    }
  }

  private async process(request: Request, signal: AbortSignal): Promise<Response> {
    const container = this.ctx.container!;
    const image = container.images.parser;
    if (!image) throw new Error("PDF parser image is not configured.");
    if (container.running) await container.destroy();
    container.start({ image, instance: "standard-1", enableInternet: false, env: { DOCUMENT_CONTAINER_TOKEN: this.env.DOCUMENT_CONTAINER_TOKEN } });
    signal.throwIfAborted();
    const port = container.getTcpPort(8080);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      signal.throwIfAborted();
      try {
        const health = await port.fetch(new Request("http://container/health", { headers: { "x-document-container-token": this.env.DOCUMENT_CONTAINER_TOKEN }, signal }));
        await health.body?.cancel();
        if (health.ok) { ready = true; break; }
      } catch { /* Only readiness probes are retried, never document processing. */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    signal.throwIfAborted();
    if (!ready) throw new Error("PDF parser did not become ready.");
    await container.setInactivityTimeout(60_000);
    const url = new URL(request.url);
    url.protocol = "http:";
    url.host = "container";
    const forwarded = new Request(url, { ...{ method: request.method, headers: request.headers, body: request.body }, signal });
    forwarded.headers.delete("host");
    const response = await port.fetch(forwarded);
    const maximum = response.ok ? (url.pathname === "/render" ? 4 * 1024 * 1024 : MAX_DOCUMENT_INDEX_BYTES) : 4096;
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maximum) { await reader.cancel(); throw new Error("PDF parser output limit exceeded."); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(bytes, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
}
