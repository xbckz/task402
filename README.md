# Task402 Agent Evidence Tools

[![CI](https://github.com/xbckz/task402/actions/workflows/ci.yml/badge.svg)](https://github.com/xbckz/task402/actions/workflows/ci.yml)
[![Live MCP endpoint](https://img.shields.io/badge/MCP-live%20on%20task402.xyz-47d9b3)](https://task402.xyz/mcp)
[![x402 payments](https://img.shields.io/badge/payments-x402%20USDC%20on%20Base-79e7ff)](https://task402.xyz/v1/pricing)
[![Smithery](https://smithery.ai/badge/martin00207/task402)](https://smithery.ai/servers/martin00207/task402)

Give agents bounded evidence from PDFs, public webpages, OpenAPI contracts, and Base chain data. Connect to the hosted **20-tool MCP service** at `https://task402.xyz/mcp`; no local server, API key, or wallet is needed for discovery. Paid calls use x402 v2 USDC on Base. Connecting an MCP host does not automatically give it a payment signer.

## Connect your agent

For Cursor, merge [`examples/cursor.mcp.json`](examples/cursor.mcp.json) into `.cursor/mcp.json`. For VS Code, merge [`examples/vscode.mcp.json`](examples/vscode.mcp.json) into `.vscode/mcp.json`. Other Streamable HTTP clients can use:

```json
{
  "mcpServers": {
    "task402": { "url": "https://task402.xyz/mcp" }
  }
}
```

Initialize the connection and run `tools/list` to inspect executable schemas. With Node.js 24 and this repository's dependencies installed, `npm run discover` performs discovery through the official MCP SDK and prints tool names only. It never calls a paid tool or signs a payment.

Every hosted tool advertises a tool-specific output schema, parameter descriptions, and MCP safety annotations. Agents can therefore plan the result shape and retry behavior from `tools/list` before approving any x402 payment.

| Tools | Billing at the 12 October 2026 live check |
| --- | --- |
| `generate_pdf` | $0.01 per PDF |
| `web_evidence` | $0.005 per public HTTPS page |
| `inspect_openapi` | $0.001 per specification |
| `plan_api_request`, `diff_openapi` | $0.002 per call |
| `get_chain_balance`, `get_chain_transaction`, `get_erc20_balance` | $0.001 per read |
| `get_pdf_job` | Included with generation; requires the job capability |
| `inspect_pdf`, `get_document_map`, `search_document`, `batch_search_document`, `prepare_document_context`, `extract_document_fields`, `read_document`, `verify_document_citation`, `compare_pdfs`, `validate_pdf_text`, `render_pdf_page_region` | Included after paid PDF indexing; requires document capabilities |

PDF indexing is the separate REST operation `POST /v1/documents` ($0.01 per PDF); binary upload is not an MCP tool. Generated PDF download is also REST-only. Read [`/v1/pricing`](https://task402.xyz/v1/pricing) and the payment challenge for current terms before approving payment. Native-text PDF tools do not provide OCR or verify factual truth.

Start with [`docs/FIRST-PAID-CALL.md`](docs/FIRST-PAID-CALL.md) for a challenge, signed retry, and result workflow. Use [`docs/PUBLISHING.md`](docs/PUBLISHING.md) to publish the repository and remote MCP metadata.

## Service architecture

This project converts Markdown into paginated PDF files through one shared service used by REST and MCP. The local runner uses Playwright Chromium and SQLite; the Cloudflare Worker adapter uses Browser Run Quick Actions, D1, and R2. The live payment path uses the official x402 SDK facilitator client, verifies before rendering, and settles only after a PDF artifact is stored.

The paid operations are `generate_pdf`, `ingest_document`, `web_evidence`, OpenAPI inspection/planning/diffing, and fixed-method Base chain reads. Retrieval, citation, batch search, bounded context preparation, and explicit-label field matching are included after indexing. Web evidence is public HTTPS HTML/text only, OpenAPI tools accept caller-supplied JSON and local references only, and chain tools never sign or submit transactions. Input HTML is not executed, remote images and other external resources are omitted or blocked, and hyperlinks are preserved in generated PDFs but never fetched during rendering.

Distribution metadata, conversion guidance, and channel-ready copy live in [`docs/MARKETING.md`](docs/MARKETING.md) and [`docs/LAUNCH-KIT.md`](docs/LAUNCH-KIT.md); the public MCP directory metadata is in [`server.json`](server.json) and [`glama.json`](glama.json).

The detailed agent, discovery, operations, deployment, operator-stats, and security guide is [`docs/AGENT-GUIDE.md`](./docs/AGENT-GUIDE.md).

## Use the hosted MCP server

No local process is required. Add the Streamable HTTP endpoint to an MCP-compatible client:

```json
{
  "mcpServers": {
    "task402": {
      "type": "http",
      "url": "https://task402.xyz/mcp"
    }
  }
}
```

The server is discoverable without payment. Paid operations return an x402 v2 challenge; the client must inspect the network, USDC asset, recipient, amount, resource, and timeout, obtain explicit wallet approval, then retry the same request with the signed payment. Task402 never receives a private key and never signs or submits transactions for the caller. Start with the [first paid call](https://task402.xyz/docs#first-paid-call), then use [`examples/agent-flow.ts`](./examples/agent-flow.ts) for a complete injected-signer flow.

### What is included

| Capability | Payment | Interface |
| --- | ---: | --- |
| Generate a paginated PDF from Markdown | $0.01 | REST, MCP |
| Index one native-text PDF | $0.01 | REST |
| Search, cite, compare, validate, map, read, extract fields, prepare context, and render | Included after indexing | REST, MCP |
| Bounded public-page evidence | $0.005 | REST, MCP |
| OpenAPI inspect, request plan, and diff | $0.001–$0.002 | REST, MCP |
| Read-only Base balance, transaction, and ERC-20 data | $0.001 | REST, MCP |

Prices, limits, schemas, and payment terms are machine-readable at [`/v1/pricing`](https://task402.xyz/v1/pricing). The service does not provide OCR, JavaScript page rendering, arbitrary API execution, transaction signing, or visual/legal PDF redlining.

The remote MCP server metadata is version `0.3.2` in [`server.json`](./server.json). In the 2026-10-12 audit, the official Registry served `0.2.0`; publishing the new metadata requires the domain publisher proof key, which is intentionally not stored in this workspace. Recheck the live Registry record before claiming the release is published. Paid REST and MCP challenges include x402 Bazaar discovery metadata, and the production facilitator is `https://facilitator.openx402.ai`.

Public discovery pages are available at [`https://task402.xyz/`](https://task402.xyz/), [`/docs#first-paid-call`](https://task402.xyz/docs#first-paid-call), [`/llms.txt`](https://task402.xyz/llms.txt), [`/demo`](https://task402.xyz/demo), [`/v1/tools`](https://task402.xyz/v1/tools), [`/openapi.json`](https://task402.xyz/openapi.json), [`/v1/pricing`](https://task402.xyz/v1/pricing), [`/.well-known/x402.json`](https://task402.xyz/.well-known/x402.json), [`/.well-known/mcp/server-card.json`](https://task402.xyz/.well-known/mcp/server-card.json), [`/.well-known/ai-plugin.json`](https://task402.xyz/.well-known/ai-plugin.json), and [`/sitemap.xml`](https://task402.xyz/sitemap.xml). They give agents and directory crawlers a clear entry point without requiring payment or an operator credential. Registry publication improves discoverability for clients that sync the MCP Registry; it does not create synthetic traffic or guarantee calls.

The public quickstart includes focused workflows for [citation verification](https://task402.xyz/docs/citation-verification), [PDF revision comparison](https://task402.xyz/docs/compare-pdfs), and [reducing PDF context before model calls](https://task402.xyz/docs/reduce-pdf-context). Copy-paste client files are in [`examples/agent-flow.ts`](./examples/agent-flow.ts), [`examples/cursor.mcp.json`](./examples/cursor.mcp.json), and [`examples/vscode.mcp.json`](./examples/vscode.mcp.json). The TypeScript example obtains unsigned generation and indexing challenges and exposes explicit retry methods for a separately approved wallet payload; it never signs or submits a payment automatically.

When you are ready for one controlled live payment, follow [`docs/TEST-TRANSACTION.md`](./docs/TEST-TRANSACTION.md). It requires an external wallet signer and never asks for a private key.

For a disposable local test wallet, the repository also includes a guarded terminal helper: `npm run test:live`. It validates the live Base/USDC challenge before signing, requires `TASK402_CONFIRM=YES`, downloads the PDF, and never prints the payment payload or capability. See the terminal section of the test guide for setup and cleanup.

To reproduce an MCP agent exactly, use `npm run test:agent`; it performs discovery, receives the structured x402 challenge, signs through the official EVM client, retries with `_meta["x402/payment"]`, checks the job through `get_pdf_job`, and downloads the result.

## Local development

Use Node.js 24 or newer (verified with Node 24.13; local durable state uses `node:sqlite`). From this directory:

```powershell
npm ci
Copy-Item .dev.vars.example .dev.vars
npm run setup:browser
npm run dev
```

The local server binds only to `127.0.0.1:8787` and accepts only the matching loopback/localhost Host authority (plus the configured public authority in live mode). The local web-evidence adapter resolves every hostname before fetching and rejects private, loopback, link-local, and reserved DNS destinations; the hosted Worker relies on its platform egress boundary plus the same URL checks. The example `.dev.vars` enables an explicit no-payment development bypass, and the bypass exists only in `src/local.ts`; `src/worker.ts` rejects it unconditionally. If `.dev.vars` is absent, the server starts with payments unconfigured and paid generation fails closed. Local jobs and artifacts are durable under `.data/` and are ignored by Git.

If Playwright cannot find its pinned Chromium download on your machine, point it to an installed Chromium executable before starting the local process:

```powershell
$env:BROWSER_EXECUTABLE_PATH = "C:\path\to\chrome.exe"
npm run dev
```

Generate and download a sample PDF:

```powershell
$body = @{ title = "Quarterly Report"; markdown = "# Summary`n`n| Metric | Value |`n| --- | ---: |`n| Revenue | 42 |" } | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/v1/pdf `
  -Headers @{ "Idempotency-Key" = "report-2026-q3-0001" } `
  -ContentType "application/json" -Body $body
$job | Format-List
Invoke-WebRequest -Uri $job.downloadUrl `
  -Headers @{ Authorization = "Bearer $($job.capability)" } `
  -OutFile .\report.pdf
```

The capability is a bearer secret. Keep it in memory, do not log it, and send it only to the returned status/download URLs. Status and download access require `Authorization: Bearer <capability>` (or `X-Job-Capability`); a job ID or idempotency key alone does not authorize access.

## API and limits

| Route | Purpose |
| --- | --- |
| `GET /v1/pricing` | Machine-readable operation, price, payment mode, and size/TTL limits |
| `GET /.well-known/x402` | Same discovery document at a well-known path |
| `GET /` and `GET /docs` | Public service overview and agent quickstart |
| `GET /llms.txt` and `GET /sitemap.xml` | Compact agent-readable metadata and crawler discovery |
| `POST /v1/pdf` | Generate a PDF; requires `Idempotency-Key`; live mode uses x402 v2 `PAYMENT-SIGNATURE` |
| `GET /v1/jobs/{jobId}` | Read authorized job state |
| `GET /v1/jobs/{jobId}/download` | Download an authorized completed PDF |
| `GET /v1/admin/stats` | Password-protected aggregate tool statistics; optional `?hours=24` |
| `GET /admin` | Mobile-friendly password form for viewing the protected stats endpoint |
| `POST /mcp` | MCP Streamable HTTP endpoint with PDF, web, OpenAPI, and Base read-only tools |
| `POST /v1/documents` | Paid raw PDF indexing for deterministic native-text operations |
| `GET /v1/documents/{documentId}` and `/map` | Inspect document metadata or read its page map |
| `POST /v1/documents/{documentId}/search`, `/batch-search`, `/context`, `/fields`, `/read`, `/citation`, `/validate` | Search, build cited context, read selected pages, verify a text quote, or validate stated expectations |
| `POST /v1/documents/compare` | Compare two separately authorized PDFs by page and normalized native text |
| `GET /v1/documents/{documentId}/pages/{page}/render` | Render a bounded page crop to PNG |
| `POST /v1/web/evidence` | Paid public HTTPS page extraction with bounded text, links, source hash, and prompt-injection warning |
| `POST /v1/openapi/inspect` | Paid OpenAPI operation, parameter, request-body, security, and local-reference inspection |
| `POST /v1/openapi/request-plan` and `/v1/openapi/diff` | Paid safe request planning and deterministic API contract comparison; no requests are executed |
| `POST /v1/chain/balance`, `/v1/chain/transaction`, `/v1/chain/erc20-balance` | Paid read-only Base RPC utilities; no signing or fund movement |

The default limits are a 256 KiB request body, 240 KiB normalized Markdown, 160 title characters, 20,000 Markdown lines, 20 MiB PDF output, a 24-hour artifact lifetime, and a 90-second render deadline. The PDF uses A4 layout, repeats table headers, keeps rows together when possible, and includes page numbers. Cleanup runs once an hour in Cloudflare, and on startup and hourly in the local process. Cleanup batches are bounded; expired capabilities stop working immediately, while physical deletion can take additional batches. Uncertain settlements retain their artifacts for operator reconciliation.

## Local PDF inspection and retrieval

The deployed Worker exposes the deterministic PDF document operations through an isolated Cloudflare Container parser. The Worker keeps capabilities, D1 metadata, R2 source/index objects, validation, and cleanup; the Container performs native PDF.js extraction and bounded page rendering with outbound Internet disabled. Local development continues to use the same operations directly through the Node.js parser.

Upload a raw PDF with a caller-generated idempotency key and separate high-entropy recovery secret (the recovery secret scopes that key to the caller). Save the returned capability and recovery secret in the caller's secret store; the server never returns the recovery secret. Reuse both keys only to recover the same upload after a lost response. The idempotency key alone cannot disclose an existing document capability.

```powershell
$recovery = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$doc = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/v1/documents `
  -Headers @{ "Idempotency-Key" = "research-pdf-2026-0001"; "X-Document-Recovery-Key" = $recovery; "X-File-Name" = "research.pdf" } `
  -ContentType "application/pdf" -InFile .\research.pdf
$headers = @{ Authorization = "Bearer $($doc.capability)" }
Invoke-RestMethod -Uri $doc.inspectUrl -Headers $headers
Invoke-RestMethod -Method Post -Uri "$($doc.inspectUrl)/search" -Headers $headers `
  -ContentType "application/json" -Body '{"query":"revenue","limit":5}'
Invoke-RestMethod -Method Post -Uri "$($doc.inspectUrl)/read" -Headers $headers `
  -ContentType "application/json" -Body '{"pages":[1,2]}'
```

The returned capability is a bearer secret. Keep it private and send it only in the `Authorization` header to the returned URLs. Binary upload accepts at most 20 MiB and 100 pages. Parsing builds a bounded local index containing metadata, page labels and sizes, bookmarks, native text blocks with normalized bounding boxes, form-field names/types/values, annotation counts, and embedded-attachment filenames/sizes. The index is limited to 8 MiB and 50,000 text blocks. `GET .../map?page=1` includes up to 500 positioned blocks for that page; the default map returns compact page summaries. Source PDF bytes and the extracted index are stored durably in `.data/document-objects/` and `.data/documents.sqlite` and removed at expiry; the default retention is 24 hours (`DOCUMENT_TTL_SECONDS` can extend it to at most seven days).

The MCP endpoint adds `inspect_pdf`, `get_document_map`, `search_document`, `batch_search_document`, `prepare_document_context`, `extract_document_fields`, `read_document`, `verify_document_citation`, `compare_pdfs`, `validate_pdf_text`, and `render_pdf_page_region` when the deployed parser Container is configured. MCP does not upload binary content; first use the REST upload and then pass its document ID and capability to the tools.

Search is case-insensitive exact matching after whitespace normalization. Reading is capped at 10 pages and 32,000 output characters. Citation checks establish only that normalized text appears on the stated page and return nearby text blocks and their bounding boxes; they do not establish truth or visual reading order. Comparison reports page-level normalized-text changes and does not inspect image, visual, metadata, or signature differences. Validation checks parser readability, optional page count, and required text only. Page crops use normalized page fractions and are limited to four million raster pixels and 4 MiB of PNG output.

No OCR, table-structure extraction/query, form filling, attachment download, PDF/A conformance test, or cryptographic signature validation is provided. Sparse native text is reported as a warning; scanned pages do not receive invented text. PDF links are retained as text and never fetched. A PDF signature marker is surfaced as metadata only; trust and validity are not checked.

Native PDF parsing and rendering run in the isolated parser Container. The Worker admits one parser task at a time, enforces a 60-second startup/processing deadline, and destroys the Container after each task to reset process and filesystem state. Concurrent uploads or renders receive 503 and should retry shortly with the same recovery/idempotency keys. Upload, page, text, index, output, and instance memory limits also apply; the Container has no outbound Internet access and receives no payment or capability secrets. OCR, visual semantic comparison, PDF/A conformance, and cryptographic signature verification remain unsupported and are reported explicitly by the validation tool.

The idempotency key is scoped to the verified payer in live mode and bound to the normalized input and payment payload. Reusing it with different content or payment returns `409`; a duplicate exact payment authorization is rejected using the EVM network/asset/payer/authorization nonce. Payment replay tombstones are retained for at least 30 days after both the artifact expiry and authorization expiry. The same completed request can recover its original capability during the job lifetime without another render or settlement.

REST clients receive x402 v2 terms in a `402` response and a standard `PAYMENT-REQUIRED` header. MCP clients receive the same `PaymentRequired` object as an `isError: true` tool result, and send payment through `params._meta["x402/payment"]`; a settled tool result includes `_meta["x402/payment-response"]`.

## MCP client with a protected wallet

[`examples/mcp-client.ts`](./examples/mcp-client.ts) demonstrates the official MCP SDK Streamable HTTP client and the x402 MCP transport fields. It takes an `ApprovedWallet` adapter from the caller and has no private-key field, environment key, or signing implementation. Implement that adapter with a hardware wallet, HSM, KMS, or a separately sandboxed wallet service; have the signer enforce the expected network, USDC asset, recipient, amount ceiling, and nonce policy before it signs. Do not add a long-lived private key to the MCP client or repository.

The example performs an unpaid call to obtain the challenge, asks the injected signer for a payload, retries with `_meta["x402/payment"]`, then returns the job capability for an authenticated download. This is a minimal happy-path example: a production client should persist the idempotency key and exact signed payment payload securely so it can retry the same request, and should retain recovery details returned after an uncertain settlement. The local development bypass does not create or settle chain payments; use a properly configured test wallet and testnet facilitator for an end-to-end x402 transfer.

## Cloudflare deployment

The Worker entry point is `src/worker.ts`. The checked-in `wrangler.toml` contains the production D1, R2, Browser Run, and parser Durable Object/Container bindings. When deploying to a different account, replace those resource identifiers and provision corresponding resources. Building the parser image requires a running Docker engine and a Docker CLI on PATH. Provision resources using your Cloudflare account:

```powershell
npx wrangler login
npx wrangler d1 create x402-docs-mvp
npx wrangler r2 bucket create x402-docs-mvp
```

Copy the D1 `database_id` printed by Wrangler into `wrangler.toml`, then apply the checked-in schema:

```powershell
npx wrangler d1 migrations apply x402-docs-mvp --remote
```

The stats endpoint uses the `tool_stats_daily` table from migration `0002_tool_stats.sql`. Install its password as a Worker secret before serving traffic:

```powershell
npx wrangler secret put STATS_PASSWORD
npx wrangler secret put DOCUMENT_CONTAINER_TOKEN
```

Enable Browser Run for the account and keep the `[browser]` binding in `wrangler.toml`. This project calls the documented `BROWSER.quickAction("pdf", ...)` API. Browser Run is available to Workers Paid accounts, but the Paid plan does not guarantee a hard five-dollar maximum: Browser Run, D1, R2, and Worker usage can incur metered charges. Review Cloudflare's current billing/pricing and configure account budgets/alerts before deploying.

For Worker-side preview, Browser Run Quick Actions require `npx wrangler dev --remote` (local `wrangler dev` does not implement `quickAction`). The regular `npm run dev` command remains fully local and uses Playwright Chromium instead.

Set non-secret Worker variables in the dashboard or Wrangler variables:

```text
PAYMENTS_MODE=live
PUBLIC_BASE_URL=https://task402.xyz
PRICE_USD=0.01
PRICE_DOCUMENT_USD=0.01
PRICE_WEB_EVIDENCE_USD=0.005
PRICE_OPENAPI_USD=0.001
PRICE_CHAIN_USD=0.001
X402_NETWORK=eip155:8453
X402_ASSET=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
X402_PAY_TO=0xAEA6fDF13ca10aD6B906884ffAcBb58a0e9E144A
X402_FACILITATOR_URL=https://facilitator.openx402.ai
MCP_ALLOWED_ORIGINS=https://<your-approved-mcp-client-origin>
```

`STATS_PASSWORD` is required in Worker deployments and must contain 20–256 characters. Use a unique high-entropy random secret. It is not a payment credential and should be kept separate from wallet and facilitator secrets. `DOCUMENT_CONTAINER_TOKEN` is a separate internal secret used only between the Worker and parser Container. The protected operator route is `GET /v1/admin/stats`; for phone access, open the mobile page at `/admin`. See [`docs/AGENT-GUIDE.md`](./docs/AGENT-GUIDE.md).

The deployed configuration uses Base mainnet USDC (`eip155:8453`) and `https://facilitator.openx402.ai`. Its public supported-capabilities response advertises Base mainnet exact EVM payments and the discovery extension, which enables Bazaar cataloging when clients echo the payment extension. Treat the facilitator as a payment dependency: review its availability, terms, supported network, discovery behavior, and settlement behavior before changing production traffic. The service converts `PRICE_USD` to six-decimal USDC units.

Install the capability HMAC secret and, if required by your facilitator, its bearer token as Worker secrets. Generate a random secret of at least 32 characters and do not commit or paste it into the TOML file:

```powershell
npx wrangler secret put CAPABILITY_SECRET
npx wrangler secret put X402_FACILITATOR_BEARER_TOKEN
```

The facilitator token is optional for a facilitator that does not require authentication. Run the local checks, then inspect a deployment bundle before choosing to deploy:

```powershell
npm ci
npm run typecheck
npm test
npm run deploy:dry-run
# npx wrangler deploy   # explicit operator action after reviewing account config and costs
```

No wallet credentials or facilitator secrets are included in this repository. The checked-in Wrangler configuration contains the deployment resource identifiers needed by this project; replace them when deploying to another account. The Worker requires live payment configuration and fails closed if it is missing; it has no development bypass. Set the Worker `PUBLIC_BASE_URL` to the exact trusted HTTPS origin, without a path, credentials, query, or fragment, so MCP results contain absolute status/download URLs without trusting a caller-controlled `Host` header. The facilitator URL may contain a path but must use HTTPS without URL credentials, query, or fragment.

## Settlement recovery

If settlement times out or the facilitator returns a pending/ambiguous result, the job becomes `settlement_unknown`. The response includes the job ID and capability so its status remains observable. The service retains the rendered PDF and will not automatically retry settlement with the same authorization. Check the facilitator's transaction status and the target network before taking an operator action. Do not resubmit the same authorization: a timeout may mean the chain transaction was accepted even when the response was lost. This MVP does not include a reconciliation/admin endpoint; an operator must reconcile against the facilitator/network and record the outcome through an audited operational process.

## Checks

`npm test` covers input limits, HTML/script/URL sanitization, payment idempotency and replay handling, uncertain and definitive facilitator outcomes, real PDF parsing, capability-gated document recovery, map/search/read/citation/compare/validation, bounded crop rendering, expiry cleanup, and official MCP SDK initialize/list/tool calls. PDF generation and visual pagination were also exercised with local Chromium against short and long-table/long-token fixtures. These tests do not submit a real blockchain payment or validate account-specific Cloudflare bindings.

## Distribution readiness

The checked-in directory metadata is in server.json and glama.json; the discovery evidence and publication checklist is in docs/DISTRIBUTION-AUDIT.md. Before claiming directory availability, verify the live MCP Registry record, facilitator Bazaar resource, and any third-party listing URL against the current /v1/pricing contract. These files prepare the submission; external directories still require their own publisher or repository workflow.

Agents should prefer /v1/pricing for current prices, /openapi.json for REST schemas, and MCP tools/list for executable input schemas. The public /docs, /llms.txt, and /sitemap.xml pages are intentionally credential-free so crawlers can understand the service before any payment.
