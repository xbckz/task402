import assert from "node:assert/strict";
import test from "node:test";
import { documentHtml } from "../src/markdown.js";
import { buildPaymentRequired } from "../src/payments.js";
import { InputError, isAllowedLocalHost, validatePdfInput } from "../src/security.js";
import { validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { idempotencyKey, makeService, paymentPayload, PAYER } from "./helpers.js";

test("local Host validation rejects DNS rebinding names and accepts configured proxy authority", () => {
  assert.equal(isAllowedLocalHost("127.0.0.1:8787", 8787), true);
  assert.equal(isAllowedLocalHost("localhost:8787", 8787), true);
  assert.equal(isAllowedLocalHost("attacker.test:8787", 8787), false);
  assert.equal(isAllowedLocalHost(undefined, 8787), false);
  assert.equal(isAllowedLocalHost("pdf.example.test", 8787, "https://pdf.example.test"), true);
  assert.equal(isAllowedLocalHost("pdf.example.test.attacker.test", 8787, "https://pdf.example.test"), false);
});

test("input validation rejects extra fields, empty content, and oversized UTF-8 markdown", () => {
  assert.throws(() => validatePdfInput({ title: "X", markdown: "# hi", output: "html" }), (error) => error instanceof InputError && error.code === "unknown_fields");
  assert.throws(() => validatePdfInput({ title: " ", markdown: "# hi" }), (error) => error instanceof InputError && error.code === "invalid_title");
  assert.throws(() => validatePdfInput({ title: "X", markdown: "😀".repeat(20) }, 16), (error) => error instanceof InputError && error.status === 413);
});

test("rendered HTML escapes title and strips raw HTML, scripts, images, and unsafe links", () => {
  const html = documentHtml({
    title: `Quarterly <script>alert('x')</script>`,
    markdown: `# Hi\n\n<script>steal()</script>\n\n![x](https://attacker.test/a.png)\n\n[bad](javascript:alert(1))\n\n| A | B |\n| --- | ---: |\n| ok | 2 |`,
  });
  assert.match(html, /Quarterly &lt;script&gt;/);
  assert.doesNotMatch(html, /<script(?:\s|>)|<img\b|href="javascript:/i);
  assert.match(html, /&lt;script&gt;steal\(\)&lt;\/script&gt;/);
  assert.match(html, /text-align:right/);
  assert.match(html, /table-layout: fixed/);
  assert.match(html, /overflow-wrap: anywhere/);
});

test("payment requirements expose valid Bazaar metadata for REST and MCP discovery", () => {
  const fixture = makeService({ live: true });
  try {
    const rest = buildPaymentRequired(fixture.gateway, "https://pdf.example.test/v1/pdf");
    const restBazaar = (rest?.extensions as { bazaar: Parameters<typeof validateDiscoveryExtension>[0] }).bazaar;
    assert.equal(validateDiscoveryExtension(restBazaar).valid, true);
    assert.equal(((restBazaar as { info: { input: { type: string; method: string } } }).info.input).type, "http");
    assert.equal(((restBazaar as { info: { input: { method: string } } }).info.input).method, "POST");

    const mcp = buildPaymentRequired(fixture.gateway, "https://pdf.example.test/mcp");
    const mcpBazaar = (mcp?.extensions as { bazaar: Parameters<typeof validateDiscoveryExtension>[0] }).bazaar;
    assert.equal(validateDiscoveryExtension(mcpBazaar).valid, true);
    assert.equal(((mcpBazaar as { info: { input: { type: string; toolName: string } } }).info.input).type, "mcp");
    assert.equal(((mcpBazaar as { info: { input: { toolName: string } } }).info.input).toolName, "generate_pdf");
    const mcpInput = (mcpBazaar as { info: { input: { inputSchema: { required?: string[]; properties?: Record<string, unknown> } } } }).info.input.inputSchema;
    assert.deepEqual(mcpInput.required, ["title", "markdown", "idempotency_key"]);
    assert.ok(mcpInput.properties?.markdown);
  } finally { fixture.jobs.close(); }
});

test("dev job uses an unguessable capability, real-looking PDF with trailing newline, and same-key retries do not duplicate work", async () => {
  const { service, renderer, artifacts, jobs } = makeService();
  try {
    const key = idempotencyKey();
    const input = { title: "Test doc", markdown: "# Hello\n\nSome content." };
    const first = await service.create(input, key, null, `${service.config.publicBaseUrl}/v1/pdf`);
    assert.equal(first.kind, "job");
    if (first.kind !== "job") return;
    assert.equal(first.job.state, "complete");
    assert.match(first.job.capability, /^[A-Za-z0-9_-]{40,64}$/);
    assert.equal(renderer.calls, 1);
    const second = await service.create(input, key, null, `${service.config.publicBaseUrl}/v1/pdf`);
    assert.equal(second.kind, "job");
    if (second.kind !== "job") return;
    assert.equal(second.job.resumed, true);
    assert.equal(second.job.capability, first.job.capability);
    assert.equal(renderer.calls, 1);
    assert.equal(await service.getJob(first.job.jobId, null), null);
    assert.equal(await service.getJob(first.job.jobId, `${first.job.capability}x`), null);
    assert.equal((await service.getJob(first.job.jobId, first.job.capability))?.state, "complete");
    const download = await service.readPdf(first.job.jobId, first.job.capability);
    assert.ok(download);
    assert.match(new TextDecoder().decode(download.bytes).trimEnd(), /%%EOF$/);
    assert.equal(artifacts.data.size, 1);
    assert.equal((await jobs.get(first.job.jobId))?.capabilityHash.length, 64);
    const changedBody = await service.create({ title: "Test doc", markdown: "# Changed" }, key, null, `${service.config.publicBaseUrl}/v1/pdf`);
    assert.equal(changedBody.kind, "error");
    if (changedBody.kind === "error") assert.equal(changedBody.error.code, "idempotency_conflict");
  } finally { jobs.close(); }
});

test("semantic payment nonce replay is blocked even across different idempotency keys", async () => {
  const fixture = makeService({ live: true });
  try {
    const payload = paymentPayload();
    const first = await fixture.service.create({ title: "Paid", markdown: "# one" }, idempotencyKey(), payload, `${fixture.service.config.publicBaseUrl}/v1/pdf`);
    assert.equal(first.kind, "job");
    const replay = await fixture.service.create({ title: "Paid again", markdown: "# two" }, idempotencyKey(), { ...payload, extensions: { ignoredBySigner: true } }, `${fixture.service.config.publicBaseUrl}/v1/pdf`);
    assert.equal(replay.kind, "error");
    if (replay.kind === "error") assert.equal(replay.error.code, "payment_replay");
    assert.equal(fixture.gateway.settleCalls, 1);
    assert.equal(fixture.renderer.calls, 1);
  } finally { fixture.jobs.close(); }
});

test("uncertain settlement is observable and never automatically sent again", async () => {
  const gateway = new (await import("./helpers.js")).FakeGateway();
  gateway.settlementFailure = "unknown";
  const fixture = makeService({ live: true, gateway });
  try {
    const key = idempotencyKey();
    const input = { title: "Paid", markdown: "# uncertain" };
    const payload = paymentPayload();
    const outcome = await fixture.service.create(input, key, payload, gateway.resourceUrl!);
    assert.equal(outcome.kind, "error");
    assert.equal(gateway.settleCalls, 1);
    if (outcome.kind === "error") {
      assert.equal(outcome.error.status, 503);
      assert.ok(outcome.error.details && typeof outcome.error.details === "object");
      const reference = outcome.error.details as { jobId: string; capability: string };
      const status = await fixture.service.getJob(reference.jobId, reference.capability);
      assert.equal(status?.state, "settlement_unknown");
      const retry = await fixture.service.create(input, key, payload, gateway.resourceUrl!);
      assert.equal(retry.kind, "error");
      if (retry.kind === "error") assert.equal(retry.error.code, "payment_recovery_pending");
      assert.equal(gateway.settleCalls, 1);
    }
  } finally { fixture.jobs.close(); }
});

test("expired job returns 410 and keeps the payment nonce tombstone", async () => {
  const fixture = makeService({ live: true, ttlSeconds: 0 });
  try {
    const key = idempotencyKey();
    const input = { title: "Short-lived", markdown: "# expire" };
    const payload = paymentPayload();
    const created = await fixture.service.create(input, key, payload, fixture.gateway.resourceUrl!);
    assert.equal(created.kind, "job");
    if (created.kind !== "job") return;
    await fixture.service.cleanupExpired();
    assert.equal(await fixture.service.getJob(created.job.jobId, created.job.capability), null);
    const replay = await fixture.service.create(input, key, payload, fixture.gateway.resourceUrl!);
    assert.equal(replay.kind, "error");
    if (replay.kind === "error") assert.equal(replay.error.status, 410);
    assert.equal(await fixture.jobs.findByPaymentKey((await import("../src/security.js")).payloadSemanticKey(payload).key) !== null, true);
    assert.equal(await fixture.artifacts.get(`${created.job.jobId}.pdf`), null);
  } finally { fixture.jobs.close(); }
});

test("pre-settlement render failure can retry same idempotency key without another payment", async () => {
  const { service, renderer, jobs } = makeService({ live: true });
  renderer.failCount = 1;
  try {
    const key = idempotencyKey();
    const input = { title: "Retry", markdown: "# retry" };
    const payload = paymentPayload();
    const failed = await service.create(input, key, payload, `${service.config.publicBaseUrl}/v1/pdf`);
    assert.equal(failed.kind, "error");
    if (failed.kind === "error") assert.equal(failed.error.status, 502);
    const success = await service.create(input, key, payload, `${service.config.publicBaseUrl}/v1/pdf`);
    assert.equal(success.kind, "job");
    assert.equal(renderer.calls, 2);
  } finally { jobs.close(); }
});
