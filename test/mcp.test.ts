import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleRequest } from "../src/api.js";
import type { ApiRuntime } from "../src/api.js";
import { makeService, paymentPayload, idempotencyKey } from "./helpers.js";
import { SqliteToolStatsStore } from "../src/local-stats.js";

test("MCP discovery inspection stops reading oversized chunked requests at the body limit", { timeout: 5000 }, async () => {
  const fixture = makeService();
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++pulls > 40) { controller.close(); return; }
      controller.enqueue(new Uint8Array(32 * 1024).fill(32));
    },
  });
  try {
    const request = new Request("https://pdf.example.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body, duplex: "half" } as RequestInit);
    const response = await handleRequest(request, { service: fixture.service, priceUsd: "0.01", paymentMode: "dev-bypass", allowedMcpOrigins: new Set() });
    assert.equal(response.status, 413);
    assert.ok(pulls < 20, `bounded readers consumed ${pulls} chunks`);
  } finally { fixture.jobs.close(); }
});

test("official MCP client initializes, lists tools, receives x402 payment-required, and completes a paid tool call", async () => {
  const fixture = makeService({ live: true });
  const stats = new SqliteToolStatsStore(":memory:");
  const runtime: ApiRuntime = {
    service: fixture.service,
    priceUsd: "0.01",
    paymentMode: "live",
    allowedMcpOrigins: new Set(),
    stats,
  };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
        method: incoming.method ?? "GET",
        headers: incoming.headers as HeadersInit,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await handleRequest(request, runtime);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch {
      outgoing.writeHead(500);
      outgoing.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: "x402-pdf-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(endpoint);

  try {
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["generate_pdf", "get_pdf_job"]);
    const generateDefinition = listed.tools.find((tool) => tool.name === "generate_pdf") as typeof listed.tools[number] & { outputSchema?: { properties?: Record<string, unknown> } };
    assert.ok(generateDefinition.outputSchema, "generated PDF tool must advertise a structured output schema");
    assert.ok(Object.keys(generateDefinition.outputSchema?.properties ?? {}).length >= 6, "output schema should expose useful result fields");
  assert.ok(generateDefinition.outputSchema?.properties?.x402Version, "paid tools should describe the x402 challenge envelope");
  assert.ok(generateDefinition.outputSchema?.properties?.error, "tools should describe structured service errors");
    assert.equal((generateDefinition.inputSchema as { properties?: Record<string, { description?: string }> }).properties?.title?.description, "Human-readable title for the generated PDF.");

    const input = { title: "Protocol test", markdown: "# MCP handshake\n\nPaid PDF." };
    const key = idempotencyKey();
    const challenge = await client.callTool({ name: "generate_pdf", arguments: { ...input, idempotency_key: key } }) as unknown as {
      isError?: boolean;
      structuredContent: Record<string, unknown>;
      content: Array<{ type: string; text?: string }>;
    };
    assert.equal(challenge.isError, true);
    const required = challenge.structuredContent as Record<string, unknown>;
    const textRequired = JSON.parse(challenge.content[0]?.type === "text" ? challenge.content[0].text ?? "{}" : "{}");
    assert.deepEqual(required, textRequired);
    assert.equal(required.x402Version, 2);
    assert.ok(Array.isArray(required.accepts));

    const payload = paymentPayload("0x" + "33".repeat(32), "https://pdf.example.test/mcp");
    const result = await client.callTool({
      name: "generate_pdf",
      arguments: { ...input, idempotency_key: key },
      _meta: { "x402/payment": payload },
    });
    assert.equal(result.isError, undefined);
    const job = result.structuredContent as { jobId: string; state: string; capability: string; statusUrl: string; downloadUrl: string };
    assert.equal(job.state, "complete");
    assert.match(job.capability, /^[A-Za-z0-9_-]{40,64}$/);
    assert.equal(new URL(job.statusUrl).origin, "https://pdf.example.test");
    assert.equal((result._meta as Record<string, unknown>)?.["x402/payment-response"] !== undefined, true);

    const status = await client.callTool({ name: "get_pdf_job", arguments: { job_id: job.jobId, capability: job.capability } });
    assert.equal((status.structuredContent as { state: string }).state, "complete");
    await client.callTool({ name: "generate_pdf", arguments: { ...input, idempotency_key: key }, _meta: { "x402/payment": payload } });
    const summary = await stats.summarize();
    assert.equal(summary.totalSettledCalls, 1);
    assert.equal(summary.totalSettledAmountAtomic, "10000");
    assert.equal(summary.totalPaymentRequired, 1);
    assert.equal(summary.totalCalls, 4);
    assert.equal(summary.traffic.find((row) => row.event === "mcp_initialize_request")?.calls, 1);
    assert.equal(summary.traffic.find((row) => row.event === "mcp_tools_list_request")?.calls, 1);
    assert.equal(summary.traffic.find((row) => row.event === "generation_completed")?.calls, 1);
    assert.equal(summary.traffic.some((row) => row.event === "document_tool_completed"), false);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fixture.jobs.close();
    stats.close();
  }
});
