import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest, type ApiRuntime } from "../src/api.js";
import { SqliteToolStatsStore } from "../src/local-stats.js";
import { makeService, paymentPayload, idempotencyKey } from "./helpers.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { STATS_SCHEMA, upsertSql } from "../src/stats-core.js";

const STATS_PASSWORD = "test-operator-password-with-enough-entropy";

test("stats preserve amounts above the JS safe integer limit and report UTC bucket boundaries", async () => {
  const stats = new SqliteToolStatsStore(":memory:");
  try {
    const cutoff = Date.UTC(2026, 9, 9, 12);
    await stats.record({ tool: "generate_pdf", outcome: "success", status: 201, durationMs: 1, settledAmountAtomic: "9007199254740993", createdAt: cutoff - 1 });
    await stats.record({ tool: "generate_pdf", outcome: "success", status: 201, durationMs: 1, settledAmountAtomic: "2", createdAt: cutoff });
    const summary = await stats.summarize(cutoff);
    assert.equal(summary.totalSettledAmountAtomic, "9007199254740995");
    assert.equal(summary.since, "2026-10-09T00:00:00.000Z");
    assert.equal(summary.totalCalls, 2);
  } finally { stats.close(); }
});

test("checked-in migrations produce the same stats schema as the local adapter", () => {
  const migrated = new DatabaseSync(":memory:");
  const local = new DatabaseSync(":memory:");
  try {
    for (const migration of ["0001_init.sql", "0002_tool_stats.sql", "0003_pdf_documents.sql", "0004_traffic_stats.sql", "0005_document_payment_state.sql", "0006_paid_tool_calls.sql", "0007_stats_hourly.sql"]) migrated.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    local.exec(STATS_SCHEMA);
    assert.deepEqual(migrated.prepare("PRAGMA table_info(tool_stats_daily)").all(), local.prepare("PRAGMA table_info(tool_stats_daily)").all());
    assert.deepEqual(migrated.prepare("PRAGMA table_info(traffic_stats_daily)").all(), local.prepare("PRAGMA table_info(traffic_stats_daily)").all());
    assert.deepEqual(migrated.prepare("PRAGMA table_info(tool_stats_hourly)").all(), local.prepare("PRAGMA table_info(tool_stats_hourly)").all());
    migrated.prepare(upsertSql()).run(0, "generate_pdf", 1, 1, 0, 0, 1, "10000", 1, 1, 1);
    assert.equal(migrated.prepare("SELECT calls FROM tool_stats_daily").get()?.calls, 1);
  } finally { migrated.close(); local.close(); }
});

test("REST counts recovered requests as calls without counting their settlement twice", async () => {
  const fixture = makeService({ live: true });
  const stats = new SqliteToolStatsStore(":memory:");
  const runtime: ApiRuntime = { service: fixture.service, priceUsd: "0.01", paymentMode: "live", allowedMcpOrigins: new Set(), stats };
  const key = idempotencyKey();
  const payment = Buffer.from(JSON.stringify(paymentPayload())).toString("base64");
  try {
    for (let index = 0; index < 2; index++) {
      const response = await handleRequest(new Request("https://pdf.example.test/v1/pdf", { method: "POST", headers: { "idempotency-key": key, "payment-signature": payment, "content-type": "application/json" }, body: JSON.stringify({ title: "Stats", markdown: "# Paid" }) }), runtime);
      assert.equal(response.status, index === 0 ? 201 : 200);
    }
    const summary = await stats.summarize();
    assert.equal(summary.totalCalls, 2);
    assert.equal(summary.totalSettledCalls, 1);
    assert.equal(summary.totalSettledAmountAtomic, "10000");
    assert.equal(summary.traffic.find((row) => row.event === "generation_completed")?.calls, 1);
  } finally { stats.close(); fixture.jobs.close(); }
});

test("tool stats aggregate outcomes and preserve atomic settled amounts", async () => {
  const stats = new SqliteToolStatsStore(":memory:");
  await stats.record({ tool: "generate_pdf", outcome: "success", status: 201, durationMs: 12, settledAmountAtomic: "10000", createdAt: Date.now() });
  await stats.record({ tool: "generate_pdf", outcome: "payment_required", status: 402, durationMs: 3, createdAt: Date.now() });
  await stats.record({ tool: "search_document", outcome: "error", status: 404, durationMs: 8, createdAt: Date.now() });
  await stats.record({ tool: "web_evidence", outcome: "success", status: 200, durationMs: 20, settledAmountAtomic: "5000", createdAt: Date.now() });
  const summary = await stats.summarize();
  assert.equal(summary.totalCalls, 4);
  assert.equal(summary.totalSuccesses, 2);
  assert.equal(summary.totalErrors, 1);
  assert.equal(summary.totalPaymentRequired, 1);
  assert.equal(summary.totalSettledCalls, 2);
  assert.equal(summary.totalSettledAmountAtomic, "15000");
  assert.deepEqual(summary.byTool.map((row) => row.tool), ["generate_pdf", "search_document", "web_evidence"]);
  assert.equal(summary.timeline.length, 1);
  assert.equal(summary.timeline[0]?.calls, 4);
  stats.close();
});

test("stats expose hourly request buckets for the operator timeline", async () => {
  const stats = new SqliteToolStatsStore(":memory:");
  try {
    const first = Date.UTC(2026, 9, 11, 10, 12);
    const second = Date.UTC(2026, 9, 11, 11, 4);
    await stats.record({ tool: "generate_pdf", outcome: "success", status: 201, durationMs: 20, createdAt: first });
    await stats.record({ tool: "generate_pdf", outcome: "payment_required", status: 402, durationMs: 4, createdAt: first + 1_000 });
    await stats.record({ tool: "search_document", outcome: "error", status: 500, durationMs: 8, createdAt: second });
    const summary = await stats.summarize(Date.UTC(2026, 9, 11, 0));
    assert.deepEqual(summary.timeline.map((row) => [row.bucketStart, row.calls, row.successes, row.errors, row.paymentRequired]), [
      ["2026-10-11T10:00:00.000Z", 2, 1, 0, 1],
      ["2026-10-11T11:00:00.000Z", 1, 0, 1, 0],
    ]);
  } finally { stats.close(); }
});

test("admin stats endpoint requires the configured password and exposes no secret", async () => {
  const fixture = makeService();
  const stats = new SqliteToolStatsStore(":memory:");
  const runtime: ApiRuntime = {
    service: fixture.service,
    priceUsd: "0.01",
    paymentMode: "dev-bypass",
    allowedMcpOrigins: new Set(),
    stats,
    statsPassword: STATS_PASSWORD,
  };
  const unauthorized = await handleRequest(new Request("http://localhost/v1/admin/stats"), runtime);
  assert.equal(unauthorized.status, 401);
  const wrong = await handleRequest(new Request("http://localhost/v1/admin/stats", { headers: { authorization: "Bearer wrong" } }), runtime);
  assert.equal(wrong.status, 401);

  await handleRequest(new Request("http://localhost/healthz"), runtime);
  const authorized = await handleRequest(new Request("http://localhost/v1/admin/stats?hours=24", { headers: { authorization: `Bearer ${STATS_PASSWORD}` } }), runtime);
  assert.equal(authorized.status, 200);
  const body = await authorized.json() as { totalCalls: number; byTool: Array<{ tool: string }>; timeline?: unknown; [key: string]: unknown };
  assert.equal(body.totalCalls, 0);
  assert.ok(Array.isArray(body.timeline));
  assert.equal(body.byTool.some((row) => row.tool === "healthz"), false);
  assert.equal(JSON.stringify(body).includes(STATS_PASSWORD), false);
  stats.close();
  fixture.jobs.close();
});

test("stats keep a bounded traffic funnel separate from product tool calls", async () => {
  const stats = new SqliteToolStatsStore(":memory:");
  try {
    await stats.recordTraffic?.({ event: "overview_request" });
    await stats.recordTraffic?.({ event: "mcp_tools_list_request" });
    const summary = await stats.summarize();
    assert.deepEqual(summary.traffic.map((row) => [row.event, row.calls]), [["mcp_tools_list_request", 1], ["overview_request", 1]]);
  } finally { stats.close(); }
});

test("generic probes and malformed document IDs do not count as product use", async () => {
  const fixture = makeService();
  const stats = new SqliteToolStatsStore(":memory:");
  const runtime: ApiRuntime = { service: fixture.service, priceUsd: "0.01", paymentMode: "dev-bypass", allowedMcpOrigins: new Set(), stats };
  try {
    await stats.record({ tool: "unknown_route", outcome: "error", status: 404, durationMs: 1 });
    await stats.record({ tool: "healthz", outcome: "success", status: 200, durationMs: 1 });
    for (const path of ["/.env", "/favicon.ico", "/healthz", "/admin", "/v1/documents/random", "/v1/documents/compare"]) await handleRequest(new Request(`https://pdf.example.test${path}`), runtime);
    await handleRequest(new Request("https://pdf.example.test/v1/pdf"), runtime);
    assert.equal((await stats.summarize()).totalCalls, 0);
  } finally { stats.close(); fixture.jobs.close(); }
});

test("mobile admin dashboard is public, protected by the API, and does not embed the secret", async () => {
  const fixture = makeService();
  const stats = new SqliteToolStatsStore(":memory:");
  const runtime: ApiRuntime = {
    service: fixture.service,
    priceUsd: "0.01",
    paymentMode: "dev-bypass",
    allowedMcpOrigins: new Set(),
    stats,
    statsPassword: STATS_PASSWORD,
  };
  try {
    const response = await handleRequest(new Request("http://localhost/admin"), runtime);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    const html = await response.text();
    assert.match(html, /Task402 stats/);
    assert.match(html, /v1\/admin\/stats/);
    assert.match(html, /placeholder="Password"/);
    assert.match(html, /Call mix by tool/);
    assert.match(html, /Requests over time/);
    assert.match(html, /Total paid/);
    assert.match(html, /SECURE VIEW/);
    assert.match(html, /form\.noValidate = true/);
    assert.match(html, /window-select/);
    assert.doesNotMatch(html, /Re-enter password/);
    assert.match(html, /Challenges/);
    assert.match(html, /role="list"/);
    assert.match(html, /Password cleared/);
    assert.doesNotMatch(html, /Private operator view/);
    assert.doesNotMatch(html, /Load last 24 hours/);
    assert.doesNotMatch(html, new RegExp(STATS_PASSWORD));
  } finally {
    stats.close();
    fixture.jobs.close();
  }
});

test("public discovery pages are free and do not enter product stats", async () => {
  const fixture = makeService();
  const stats = new SqliteToolStatsStore(":memory:");
  const runtime: ApiRuntime = { service: fixture.service, priceUsd: "0.01", paymentMode: "dev-bypass", allowedMcpOrigins: new Set(), stats, documentRuntime: "node-local" };
  try {
    for (const path of ["/", "/docs", "/pricing", "/llms.txt", "/robots.txt", "/sitemap.xml", "/server.json", "/v1/pricing", "/.well-known/x402.json", "/v1/tools", "/openapi.json", "/.well-known/mcp/server-card.json", "/.well-known/ai-plugin.json", "/favicon.svg", "/task402-bg.webp"]) {
      const response = await handleRequest(new Request(`http://localhost${path}`), runtime);
      assert.equal(response.status, 200, path);
      if (path === "/") { const home = await response.text(); assert.match(home, /first-paid-call/); assert.match(home, /document capability window/); }
      if (path === "/docs") { const docs = await response.text(); assert.match(docs, /id="first-paid-call"/); assert.match(docs, /challengeResult/); assert.match(docs, /x402\/payment-response/); assert.doesNotMatch(docs, /const challenge = await mcp\.callTool\(\{ name: "web_evidence", arguments: \{/); }
      if (path === "/favicon.svg") { assert.match(response.headers.get("content-type") ?? "", /image\/svg\+xml/); assert.match(await response.text(), /Task402 mark/); }
      if (path === "/task402-bg.webp") { assert.match(response.headers.get("content-type") ?? "", /image\/webp/); assert.ok((await response.arrayBuffer()).byteLength > 1000); }
      if (path === "/llms.txt") assert.match(await response.text(), /Task402 Agent Evidence Tools\n\n/);
      if (path === "/robots.txt") assert.match(await response.text(), /User-agent: \*\nAllow: \/\n/);
      if (path === "/sitemap.xml") { const sitemap = await response.text(); assert.match(sitemap, /<loc>https:\/\/pdf\.example\.test\/pricing<\/loc>/); assert.match(sitemap, /citation-verification/); }
      if (path === "/v1/pricing") { const pricing = await response.json() as { billing?: { paid?: string[]; free?: string[] }; operations?: Array<{ name: string; billing: string }> }; assert.ok(pricing.billing?.paid?.includes("generate_pdf")); assert.ok(pricing.billing?.paid?.includes("web_evidence")); assert.ok(pricing.billing?.paid?.includes("inspect_openapi")); assert.ok(pricing.billing?.free?.includes("search_document")); assert.equal(pricing.operations?.find((operation) => operation.name === "generate_pdf")?.billing, "paid"); assert.equal(pricing.operations?.find((operation) => operation.name === "web_evidence")?.billing, "paid"); }
      if (path === "/server.json") { const manifest = await response.json() as { name?: string; version?: string; remotes?: Array<{ url?: string }>; _meta?: Record<string, unknown> }; assert.equal(manifest.name, "xyz.task402/x402-docs"); assert.equal(manifest.version, "0.3.2"); assert.equal(manifest.remotes?.[0]?.url, "https://pdf.example.test/mcp"); assert.ok(manifest._meta); }
      if (path === "/openapi.json") { const openapi = await response.json() as { openapi?: string; paths?: Record<string, unknown> }; assert.equal(openapi.openapi, "3.1.0"); assert.ok(Object.keys(openapi.paths ?? {}).includes("/v1/jobs/{id}/download")); assert.ok(Object.keys(openapi.paths ?? {}).includes("/v1/documents/{id}/pages/{page}/render")); }
      if (path === "/.well-known/mcp/server-card.json") {
        const card = await response.json() as { name?: string; remotes?: Array<{ url?: string }>; tools?: Array<{ name?: string; inputSchema?: { required?: string[]; properties?: Record<string, unknown> } }> };
        assert.equal(card.name, "xyz.task402/x402-docs");
        assert.equal(card.remotes?.[0]?.url, "https://pdf.example.test/mcp");
        const tool = (name: string) => card.tools?.find((entry) => entry.name === name);
        assert.ok(tool("generate_pdf"));
        assert.deepEqual(tool("generate_pdf")?.inputSchema?.required, ["title", "markdown", "idempotency_key"]);
        assert.ok(tool("generate_pdf")?.inputSchema?.properties?.markdown);
        assert.ok(tool("web_evidence")?.inputSchema?.properties?.max_chars);
        if (tool("batch_search_document")) assert.ok(tool("batch_search_document")?.inputSchema?.properties?.queries);
        assert.ok(tool("plan_api_request")?.inputSchema?.properties?.operation_id);
        assert.ok(tool("get_chain_balance")?.inputSchema?.properties?.block);
      }
      if (path === "/.well-known/ai-plugin.json") {
        const manifest = await response.json() as Record<string, unknown>;
        assert.equal(manifest.name_for_model, "task402_agent_evidence_tools");
        assert.deepEqual((manifest.api as Record<string, unknown>).type, "openapi");
      }
    }
    const summary = await stats.summarize();
    assert.equal(summary.totalCalls, 0);
    assert.deepEqual(summary.traffic.map((row) => row.event).sort(), ["docs_request", "overview_request", "pricing_request"]);
  } finally { stats.close(); fixture.jobs.close(); }
});

test("stats endpoint fails closed when no password is installed", async () => {
  const fixture = makeService();
  const stats = new SqliteToolStatsStore(":memory:");
  const runtime: ApiRuntime = { service: fixture.service, priceUsd: "0.01", paymentMode: "dev-bypass", allowedMcpOrigins: new Set(), stats };
  const response = await handleRequest(new Request("http://localhost/v1/admin/stats"), runtime);
  assert.equal(response.status, 503);
  stats.close();
  fixture.jobs.close();
});
