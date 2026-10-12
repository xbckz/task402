export const USE_CASES = {
  "citation-verification": { title: "Verify citations against PDF page text", description: "Find a passage, read the source page and verify an exact normalized quote with page evidence." },
  "compare-pdfs": { title: "Compare PDF revisions by changed page", description: "Compare extractable text in two PDF revisions and inspect changed pages without an LLM call." },
  "reduce-pdf-context": { title: "Read relevant PDF passages before filling agent context", description: "Search and read selected PDF pages to reduce the document text sent to a language model." },
} as const;
export type UseCase = keyof typeof USE_CASES;
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const code = (value: string) => `<pre><code>${escape(value)}</code></pre>`;

export function agentDocsBody(baseUrl: string, priceUsd: string, documentPriceUsd = "0.01", webEvidencePriceUsd = "0.005", openApiPriceUsd = "0.001", chainPriceUsd = "0.001"): string {
  return `<h1>Evidence tools agents can call directly.</h1><p class="lead">Index a native-text PDF for $${escape(documentPriceUsd)}, then use included document evidence tools. Public web evidence starts at $${escape(webEvidencePriceUsd)}, OpenAPI inspection at $${escape(openApiPriceUsd)}, Base reads at $${escape(chainPriceUsd)}, and Markdown-to-PDF generation costs $${escape(priceUsd)} through x402.</p>
<p><a href="#mcp">MCP setup</a> · <a href="#rest">REST example</a> · <a href="#payments">Payment boundary</a> · <a href="#limits">Limits</a></p>
 <h2>Useful agent workflows</h2><ul>${Object.entries(USE_CASES).map(([slug, item]) => `<li><a href="/docs/${slug}">${escape(item.title)}</a>: ${escape(item.description)}</li>`).join("")}</ul>
 <h2 id="first-paid-call">Run the first paid call</h2><p>Start with <code>web_evidence</code>: one public page, $${escape(webEvidencePriceUsd)}, and a bounded result. The unsigned request is free and returns the exact x402 terms; only the explicit signed retry settles a payment.</p><ol><li>Call <code>web_evidence</code> without payment.</li><li>Check the returned network, USDC asset, recipient, amount, resource, and timeout.</li><li>Ask your wallet signer to approve those exact terms, then retry the same arguments with <code>_meta["x402/payment"]</code>.</li><li>Store the settlement receipt and return only the bounded evidence to your model.</li></ol>
 ${code(`const input = { url: "https://example.com/", query: "revenue", max_chars: 4000, idempotency_key: crypto.randomUUID() };
const challengeResult = await mcp.callTool({ name: "web_evidence", arguments: input });
const challenge = challengeResult.structuredContent ?? JSON.parse(challengeResult.content?.find(item => item.type === "text")?.text ?? "{}");
if (challenge.x402Version !== 2 || !Array.isArray(challenge.accepts)) throw new Error("Missing x402 requirements");
const payment = await approvedWallet.createPaymentPayload(challenge);
const paid = await mcp.callTool({
  name: "web_evidence",
  arguments: input,
  _meta: { "x402/payment": payment }
});
if (paid.isError || !paid._meta?.["x402/payment-response"]) throw new Error("No definitive settlement");`)}
<h2 id="mcp">Copy a remote MCP configuration</h2><p>For Cursor, use <code>.cursor/mcp.json</code>. No server API key is needed to initialize or list tools. The MCP surface includes <code>generate_pdf</code>, <code>get_pdf_job</code>, <code>inspect_pdf</code>, <code>get_document_map</code>, <code>search_document</code>, <code>batch_search_document</code>, <code>prepare_document_context</code>, <code>extract_document_fields</code>, <code>read_document</code>, <code>verify_document_citation</code>, <code>compare_pdfs</code>, <code>validate_pdf_text</code>, <code>render_pdf_page_region</code>, <code>web_evidence</code>, <code>inspect_openapi</code>, <code>plan_api_request</code>, <code>diff_openapi</code>, <code>get_chain_balance</code>, <code>get_chain_transaction</code>, and <code>get_erc20_balance</code>. Upload a PDF through REST first; document tool arguments require its capability.</p>
${code(JSON.stringify({ mcpServers: { task402: { url: `${baseUrl}/mcp` } } }, null, 2))}
<p>For VS Code, use <code>.vscode/mcp.json</code>:</p>
${code(JSON.stringify({ servers: { task402: { type: "http", url: `${baseUrl}/mcp` } } }, null, 2))}
<p>Claude Code CLI:</p>${code(`claude mcp add --transport http task402 ${baseUrl}/mcp`)}
<p>These configurations connect the transport; they do not provide automatic x402 wallet signing. Keep paid tool execution behind your client's approval controls. Hosted browser clients may require an explicitly approved Origin; a configuration alone does not establish compatibility with every host.</p>
<h2 id="rest">Copy a Node.js REST flow</h2><p>Node.js 24+, no package installation required. Save as <code>task402-example.mjs</code>. The upload portion is intentionally an unsigned request shape: production returns <code>402</code> until your wallet adapter signs the exact challenge and retries it. Add the same x402 signer/retry layer used by your agent runtime before running it against the live endpoint. Indexing is charged at the published document price; retrieval and verification use the returned short-lived capability. Recovery keys and returned capabilities stay in memory; use your own secure state store before upload if you need recovery after a crash.</p>
${code(`import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
const base = ${JSON.stringify(baseUrl)};
async function json(path, init = {}) {
  const response = await fetch(base + path, { ...init, redirect: "error" });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}
await json("/v1/pricing");
const recovery = randomBytes(32).toString("base64url");
const key = randomUUID();
const doc = await json("/v1/documents", {
  method: "POST",
  headers: { "Content-Type": "application/pdf", "Idempotency-Key": key,
    "X-Document-Recovery-Key": recovery },
  body: await readFile(process.argv[2])
});
const headers = { Authorization: "Bearer " + doc.capability,
  "Content-Type": "application/json" };
const search = await json("/v1/documents/" + doc.documentId + "/search", {
  method: "POST", headers, body: JSON.stringify({ query: "revenue", limit: 5 })
});
const pages = [...new Set(search.hits.map(hit => hit.page))].slice(0, 10);
if (pages.length) {
  const read = await json("/v1/documents/" + doc.documentId + "/read", {
    method: "POST", headers, body: JSON.stringify({ pages })
  });
  // Route selected text into your agent; do not log doc or headers.
  console.log({ matchedPages: pages, returnedPages: read.pages.length });
} else console.log({ matchedPages: 0 });`)}
<h2>Verify a quote and compare revisions</h2><p>Send the exact source quote (5–500 normalized characters) and its one-based page. <code>verified: true</code> means an exact normalized text match on that page; it does not establish factual truth or visual reading order.</p>
${code(`POST /v1/documents/{documentId}/citation
Authorization: Bearer <document-capability>
Content-Type: application/json

{"page":1,"quote":"exact source passage"}

POST /v1/documents/compare
Content-Type: application/json

{"leftId":"<first-document-id>","leftCapability":"<first-capability>",
 "rightId":"<second-document-id>","rightCapability":"<second-capability>"}`)}
<p>Comparison aligns pages by number and compares native text. Inserting a page can shift later comparisons. It is not a legal redline, table reconstruction, or image/layout diff.</p>
<h2 id="web">Web, API, and chain tools</h2><p>Task402 also exposes paid deterministic JSON tools. Each requires an <code>Idempotency-Key</code>; an unsigned request returns an x402 challenge with the exact amount and resource to sign.</p>
${code(`POST /v1/web/evidence
Idempotency-Key: web-2026-0001
Content-Type: application/json

{"url":"https://example.com/","query":"Example Domain","max_chars":12000}

POST /v1/openapi/inspect
Idempotency-Key: api-2026-0001
Content-Type: application/json

{"spec":{"openapi":"3.1.0","info":{"title":"Example API","version":"1"},"servers":[{"url":"https://api.example.com"}],"paths":{"/users/{id}":{"get":{"operationId":"getUser","parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string"}}],"responses":{"200":{"description":"OK"}}}}}}}

POST /v1/openapi/request-plan
{"spec":{"openapi":"3.1.0","info":{"title":"Example API","version":"1"},"servers":[{"url":"https://api.example.com"}],"paths":{"/users/{id}":{"get":{"operationId":"getUser","parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string"}}],"responses":{"200":{"description":"OK"}}}}}},"operation_id":"getUser"}

POST /v1/openapi/diff
{"before":{"openapi":"3.1.0","info":{"title":"Example API","version":"1"},"paths":{}},"after":{"openapi":"3.1.0","info":{"title":"Example API","version":"2"},"paths":{"/health":{"get":{"operationId":"health","responses":{"200":{"description":"OK"}}}}}}}

POST /v1/chain/balance
{"network":"eip155:8453","address":"0xAEA6fDF13ca10aD6B906884ffAcBb58a0e9E144A"}

POST /v1/chain/transaction
{"network":"eip155:8453","tx_hash":"0x6a20a573804c89b1bf0104ac23ea9bbcd5bcfad53d8f0fd1ead2edbe40209c3f"}

POST /v1/chain/erc20-balance
{"network":"eip155:8453","token":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","address":"0xAEA6fDF13ca10aD6B906884ffAcBb58a0e9E144A"}`)}
<ul><li><code>web_evidence</code> accepts public HTTPS HTML, plain text, and JSON only. It does not send cookies, credentials, custom headers, or JavaScript; page content is untrusted and may contain prompt injection.</li><li>OpenAPI tools accept caller-supplied JSON and local references only. They never fetch remote references or execute generated requests.</li><li>Chain tools use fixed Base RPC endpoints and read balances/receipts only. They never sign, submit, or move funds.</li></ul>
<h2 id="payments">Generate only after explicit payment approval</h2><p>Discover the current contract at <a href="/v1/pricing">/v1/pricing</a>. An unsigned generation request returns 402; requesting that challenge does not sign or transfer funds.</p>
${code(`POST /v1/pdf
Content-Type: application/json
Idempotency-Key: <stable-request-id>

{"title":"Report","markdown":"# Summary\\n\\nRevenue: 42"}`)}
<p>For a later approved paid retry, an external wallet signs the exact returned x402 requirements after checking amount, network, asset, recipient, resource and validity. Resend the identical body and idempotency key with <code>PAYMENT-SIGNATURE: base64(JSON payment payload)</code>. For MCP, call <code>generate_pdf</code> again with identical arguments and <code>_meta["x402/payment"]</code>. Keep that authorization private and retain the returned job capability. On ambiguous settlement, inspect the job and facilitator status; do not automatically sign a new authorization or resend payment.</p>
<h2 id="limits">Native-text limits and privacy</h2><ul><li>20 MiB uploads, at most 100 pages, bounded text/index output. One isolated parser task at a time, with a 60-second deadline; 503 means retry later using the same recovery state.</li><li>Read at most 10 pages and 32,000 characters per request. Search returns bounded excerpts. Select relevant passages instead of automatically placing a whole document in model context.</li><li>Context/token savings depend on document length and the task; no fixed savings percentage is promised. Retrieval can miss evidence outside the selected pages.</li><li>Scanned/image-only PDFs need external OCR. No OCR, PDF/A certification, signature validation, visual semantic comparison or inferred table structure.</li><li>Uploading sends PDF bytes to this service. Source and index are retained for the configured TTL (24 hours by default). Capability expiry denies access; physical deletion runs on scheduled cleanup and may lag.</li><li>Capabilities and recovery keys are bearer secrets. Pass them through trusted tool orchestration, never public logs or examples; never upload a sensitive document without authorization.</li></ul>
<p>Client format references: <a href="https://prod.cursor.com/docs/mcp">Cursor</a>, <a href="https://code.visualstudio.com/docs/agent-customization/mcp-servers">VS Code</a>, <a href="https://code.claude.com/docs/en/mcp">Claude Code</a>.</p>`;
}

export function useCaseBody(slug: UseCase): string {
  const item = USE_CASES[slug];
  const workflows: Record<UseCase, string> = {
    "citation-verification": `<ol><li>Upload an authorized native-text PDF and retain its capability.</li><li>Search for a term, read the candidate pages, and select an exact quote.</li><li>Call <code>verify_document_citation</code> with document_id, capability, page and quote.</li><li>Return the one-based page, quote and evidence only after inspecting <code>verified</code>.</li></ol><p>A failed match can reflect OCR needs, line breaks, normalization, ligatures or an incorrect quote. A successful match proves extractable text location, not factual correctness. Page evidence should accompany any agent-written conclusion.</p>`,
    "compare-pdfs": `<ol><li>Upload both revisions separately and retain both capabilities.</li><li>Call <code>compare_pdfs</code> with left_document_id, left_capability, right_document_id and right_capability.</li><li>Use returned changed pages to select <code>read_document</code> or bounded page rendering.</li><li>Review relevant changes before drawing a business or legal conclusion.</li></ol><p>Comparison uses page-aligned normalized native text. Page insertions can shift subsequent matches. Text-identical PDFs can have different layouts, signatures or images; this tool does not establish legal equivalence.</p>`,
    "reduce-pdf-context": `<ol><li>Inspect page count and warnings with <code>inspect_pdf</code>.</li><li>Use <code>get_document_map</code> and <code>search_document</code> to locate candidate evidence.</li><li>Read only the selected pages; verify important quotes with <code>verify_document_citation</code>.</li><li>Send selected text and page evidence to your model, widening retrieval if needed.</li></ol><p>The native-text tools do not invoke a language model. Smaller retrieved inputs can reduce model context consumption, but savings depend on the document and workflow. A search hit is not proof that every relevant passage was found; coverage matters more than minimizing tokens.</p>`,
  };
  return `<h1>${escape(item.title)}</h1><p class="lead">${escape(item.description)}</p>${workflows[slug]}<h2>Start with the included tools</h2><p>Indexing a PDF uses the published x402 document price. Retrieval and verification are included with the returned short-lived bearer capability; no paid generation is required for these workflows.</p><p><a href="/docs#rest">Copy the REST example</a> · <a href="/docs#mcp">Connect an MCP client</a> · <a href="/docs#limits">Review limits and retention</a></p>`;
}
