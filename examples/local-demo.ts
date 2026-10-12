import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.env.API_BASE_URL ?? "http://127.0.0.1:8787";
const input = {
  title: "Your first agent-generated document",
  markdown: `## A working local demo

This PDF was created by sending Markdown to the running document API. The server formatted the content, rendered it with Chromium, stored the PDF, and returned a private download capability.

## What an agent sends

An agent supplies a **title**, **Markdown content**, and an **idempotency key**. It can use either the REST API or the MCP tool.

| Step | What happens | Result |
| --- | --- | ---: |
| 1 | Validate the request | Accepted |
| 2 | Format and render the document | PDF |
| 3 | Store the artifact privately | 24-hour lifetime |
| 4 | Download with the returned capability | Authorized |

## Why repeated requests are safe

Retrying the same request with the same idempotency key returns the existing job. It does not generate a second PDF or settle a second payment.

## Local mode

This demonstration uses the explicit local payment bypass. **No cryptocurrency payment is made.** A deployed service must use the configured x402 facilitator to verify payment before rendering and settle after storing the output.

## International text

Příliš žluťoučký kůň. Français: qualité et résultat. Deutsch: Größe und Zuverlässigkeit.

> The document you are reading came from the live local API, rather than the sample bundled with the project.
`,
};
const headers = { "content-type": "application/json", "idempotency-key": `local-demo-${randomUUID()}` };
const health = await fetch(`${base}/healthz`).then(r => r.json()) as { payments: string };
assert.equal(health.payments, "dev-bypass", "This example requires local dev-bypass mode.");
console.log("1. Local server ready; payments are bypassed for this demo.");
const response = await fetch(`${base}/v1/pdf`, { method: "POST", headers, body: JSON.stringify(input) });
assert.equal(response.status, 201, await response.clone().text());
const job = await response.json() as { jobId: string; capability: string; downloadUrl: string; artifactBytes: number };
console.log(`2. POST /v1/pdf -> 201; job ${job.jobId}; ${job.artifactBytes} bytes.`);
const denied = await fetch(job.downloadUrl);
assert.equal(denied.status, 404);
console.log("3. Download without the capability -> 404, as expected.");
const pdf = await fetch(job.downloadUrl, { headers: { authorization: `Bearer ${job.capability}` } });
assert.equal(pdf.status, 200);
const output = new URL("./local-demo.pdf", import.meta.url);
await writeFile(output, new Uint8Array(await pdf.arrayBuffer()));
console.log(`4. Authorized download saved to ${fileURLToPath(output)}.`);
const retry = await fetch(`${base}/v1/pdf`, { method: "POST", headers, body: JSON.stringify(input) });
assert.equal(retry.status, 200);
assert.equal((await retry.json() as { jobId: string }).jobId, job.jobId);
console.log("5. Repeat the identical request -> 200 and the same job; no duplicate render.");

const client = new Client({ name: "local-demo-agent", version: "1.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)) as unknown as Parameters<typeof client.connect>[0]);
  const tools = await client.listTools();
  console.log(`6. Agent connected through MCP. Tools: ${tools.tools.map(t => t.name).join(", ")}.`);
  const status = await client.callTool({ name: "get_pdf_job", arguments: { job_id: job.jobId, capability: job.capability } });
  assert.ok(!status.isError);
  assert.equal((status.structuredContent as { state: string }).state, "complete");
  console.log("7. Agent retrieved this REST-created job through MCP: complete.");
} finally {
  await client.close();
}
