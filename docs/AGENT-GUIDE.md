# x402 Docs: agent and operator guide

This service gives an agent four focused capability families:

1. `generate_pdf` turns trusted Markdown input into a paginated PDF.
2. `ingest_document` indexes one PDF for $0.01 USDC; the capability then includes inspect, search, batch search, cited context preparation, cite, compare, validate, and selective rendering without sending the entire file through an LLM.
3. `web_evidence` fetches one public HTTPS HTML/text page for $0.005 and returns bounded text, links, timestamps, a source hash, match excerpts, and prompt-injection warnings.
4. OpenAPI inspection/planning/diffing and fixed-method Base read-only chain tools are paid deterministic JSON operations. They never execute caller-generated API requests or move funds.

The service returns structured JSON, bounded outputs, stable error codes, and short-lived bearer capabilities. A client can use REST or MCP. Payments are exact x402 v2 USDC payments in live mode; local development uses an explicit loopback-only bypass.

## What an agent can do

### Generate a PDF

`POST /v1/pdf` accepts:

```json
{
  "title": "Quarterly report",
  "markdown": "# Summary\n\nThe report text."
}
```

Every request must include an `Idempotency-Key`. In live mode, the first response is `402 Payment Required` with the x402 requirements. The client signs the exact requirement with its approved wallet and retries with `PAYMENT-SIGNATURE`. A successful response includes a `jobId`, status URL, download URL, and a short-lived capability. Keep the capability in a secret store and send it only to those returned URLs.

The same idempotency key and exact payment safely recover a completed job. Reusing either with different content is rejected. A payment that has an uncertain settlement result is never silently submitted again.

### Work with a PDF locally

Upload a raw PDF to `POST /v1/documents` with `Content-Type: application/pdf`, `Idempotency-Key`, `X-Document-Recovery-Key`, and optional `X-File-Name`. The response contains a document ID and capability. Use the capability in `Authorization: Bearer ...` for:

| Operation | Route | Result |
| --- | --- | --- |
| Inspect | `GET /v1/documents/{id}` | Page count, metadata, warnings, forms, attachments |
| Map | `GET /v1/documents/{id}/map?page=1` | Page sizes, previews, and positioned native text blocks |
| Search | `POST /v1/documents/{id}/search` | Bounded exact normalized-text matches and excerpts |
| Batch search | `POST /v1/documents/{id}/batch-search` | Up to 20 searches in one call |
| Context pack | `POST /v1/documents/{id}/context` | Ranked pages and cited excerpts under a character budget |
| Fields | `POST /v1/documents/{id}/fields` | Explicit labels with page and block evidence |
| Read | `POST /v1/documents/{id}/read` | Native text for up to ten selected pages |
| Verify citation | `POST /v1/documents/{id}/citation` | Whether a quote occurs on a stated page, with nearby blocks |
| Validate | `POST /v1/documents/{id}/validate` | Parser readability, expected page count, required text |
| Compare | `POST /v1/documents/compare` | Page-level normalized-text changes between two authorized PDFs |
| Render crop | `GET /v1/documents/{id}/pages/{page}/render` | A bounded PNG crop for visual confirmation |

These operations are deterministic native-text operations. They do not claim that a scanned page contains no text, perform OCR, infer table structure, validate cryptographic signatures, or establish that a quote is true. A sparse-text warning is returned when the PDF probably needs OCR.

### Recommended agent workflow

For a question about a PDF, use this sequence:

1. Upload once and retain the capability securely.
2. Inspect the document and check `pageCount` and warnings.
3. Search for a narrow phrase before reading pages.
4. Read only the pages containing relevant matches.
5. Verify every quoted statement with the citation operation.
6. Render a small crop only when layout, a chart, or a table needs visual confirmation.
7. Delete or wait for expiry when the document is no longer needed.

This workflow keeps large files out of the model context and gives the final answer stable page evidence.

### Web evidence

`POST /v1/web/evidence` accepts `url`, an optional `query`, and an optional `max_chars`. It only follows public HTTPS redirects, accepts HTML/plain text/JSON, caps the upstream response at 1 MiB, strips scripts and styles, and never forwards cookies, authorization, payment headers, or caller-supplied headers. Treat returned page text as untrusted source material; the `warnings` array identifies instruction-like content but does not make a safety decision for the agent.

### OpenAPI and chain tools

`POST /v1/openapi/inspect` inventories operations, effective security, parameters, request bodies, and local `$ref`s. `POST /v1/openapi/request-plan` selects one operation and creates a request plan without executing it. `POST /v1/openapi/diff` reports added, removed, and potentially breaking request changes. All three accept JSON documents supplied by the caller and do not fetch remote references.

`POST /v1/chain/balance`, `/v1/chain/transaction`, and `/v1/chain/erc20-balance` use fixed Base mainnet or Base Sepolia RPC endpoints. They return decimal strings and observation metadata. They support read-only methods only; no private key, signer, transaction submission, or arbitrary RPC URL is accepted.

## MCP

The Streamable HTTP endpoint is `POST /mcp`. The paid server exposes `generate_pdf`, `get_pdf_job`, `web_evidence`, `inspect_openapi`, `plan_api_request`, `diff_openapi`, `get_chain_balance`, `get_chain_transaction`, and `get_erc20_balance`, plus included document evidence tools. When the production parser Container is configured, the same endpoint additionally exposes `inspect_pdf`, `get_document_map`, `search_document`, `batch_search_document`, `prepare_document_context`, `extract_document_fields`, `read_document`, `verify_document_citation`, `compare_pdfs`, `validate_pdf_text`, and `render_pdf_page_region`.

MCP does not upload binary PDFs. Upload through REST first, then pass the returned document ID and capability to the document tools. For a paid call, the client sends its signed x402 payload in `params._meta["x402/payment"]`; the server returns payment requirements as a structured tool error when payment is missing.

Tool descriptions are deliberately explicit about limits and unsupported features. Do not hide OCR, visual comparison, or signature validation behind a tool name that suggests they exist.

## Discovery and distribution

The repository now includes [`server.json`](../server.json), the metadata file used for official MCP Registry publication. It points clients to the public Streamable HTTP endpoint at `https://task402.xyz/mcp` and uses the reverse-domain namespace `xyz.task402/x402-docs`.

The public overview, quickstart, free workflow preview, compact agent summary, tool catalog, OpenAPI contract, pricing contract, and crawler map are available at `/`, `/docs`, `/demo`, `/llms.txt`, `/v1/tools`, `/openapi.json`, `/v1/pricing`, and `/sitemap.xml`. These routes are intentionally free and contain no bearer credentials, so an agent or catalog crawler can understand the service before attempting a paid call.

There are three useful discovery paths:

1. **MCP Registry:** publish `server.json` after DNS is delegated and the HTTPS endpoint responds publicly. The registry lets MCP hosts that sync it find the server and connect to `/mcp`; it does not create a payment listing.
2. **x402 Bazaar:** include the Bazaar extension in each `402 Payment Required` response. Compatible facilitators can index the endpoint, tool name, input schema, price, network, and examples so payment-aware agents can search for it.
3. **Public agent pages:** link the service overview and `/llms.txt` from directories, agent catalogs, and README files. Submit factual listings manually and respect each directory's review and rate limits; discovery pages improve conversion but cannot manufacture traffic.

For the Registry, install the official `mcp-publisher` CLI, then run:

```powershell
mcp-publisher validate server.json
# Use a locally generated Ed25519 private key; never commit it or put it in Worker vars.
mcp-publisher login dns --domain=task402.xyz --private-key=<64-character-hex-private-key>
mcp-publisher publish server.json
```

The DNS login flow prints a proof TXT record. Add that record at the registrar/Cloudflare DNS, rerun the login command, and keep the private key in a local secret store. Use it only after the nameservers are delegated and the public endpoint is reachable. A registry record is versioned, so increment `version` when the remote URL, tools, or compatibility contract changes.

For Bazaar, the production facilitator must advertise discovery support. The Worker now emits a schema-validated Bazaar extension for the REST generator and MCP `generate_pdf` tool, and the configured Base mainnet facilitator advertises the discovery extension. A resource is cataloged only after a compatible client echoes the extension in a real payment payload and the facilitator indexes it; verify that round trip through the facilitator's discovery endpoint before claiming catalog visibility.

The configured catalog can be queried with:

```text
GET https://facilitator.openx402.ai/discovery/resources?payTo=0xAEA6fDF13ca10aD6B906884ffAcBb58a0e9E144A
```

After the first successful paid call made by a Bazaar-compatible client, look for the resource URL and the MCP tool name in that response. If the facilitator returns an `EXTENSION-RESPONSES` header, `bazaar.status` reports `success`, `processing`, or `rejected`; indexing may be asynchronous.

For paid routes, add the x402 Bazaar discovery extension to the payment requirement. It gives compatible clients a machine-readable description of the endpoint, input schema, price, and payment network. A listing provides discoverability; it does not guarantee traffic, so maintain examples and a reliable public endpoint.

The service should be described with task language that matches agent requests:

- “Find a clause in a large PDF and return exact page evidence.”
- “Compare two contract revisions and list changed pages.”
- “Generate a paginated PDF from Markdown.”

The strongest proof is a short reproducible example with input, output, price, latency, limits, and citation behavior.

## Operator statistics

`GET /v1/admin/stats` returns aggregate tool usage. It includes total calls, successful calls, errors, payment-required responses, average and maximum duration, settled call count, and settled USDC atomic units per tool. It stores daily counters only; document bytes, prompts, capabilities, wallet addresses, payment payloads, and passwords are never written to the stats store.

For a phone or another browser, open `https://your-domain.example/admin`. Enter the same password in the form; the page calls the protected API with `X-Stats-Password` over HTTPS, keeps the value only in memory for that request, and does not put it in the URL or browser storage. The raw `/v1/admin/stats` endpoint remains available for scripts and monitoring.

Authenticate with either:

```text
Authorization: Bearer <STATS_PASSWORD>
```

or:

```text
X-Stats-Password: <STATS_PASSWORD>
```

Use `?hours=24` to restrict the window to UTC daily buckets starting at midnight on the day containing the cutoff. This can include up to 24 extra hours; the returned `since` is the actual bucket boundary. Without a window the endpoint returns all retained counters. Counters are best-effort operational telemetry, not a financial ledger: failed writes and uncertain settlements require reconciliation against durable job records and the facilitator. Successful retries count as calls but do not count a completed settlement again.

Example:

```powershell
$stats = Invoke-RestMethod `
  -Uri https://your-domain.example/v1/admin/stats?hours=24 `
  -Headers @{ Authorization = "Bearer $env:STATS_PASSWORD" }
$stats.byTool | Format-Table tool, calls, successes, errors, totalDurationMs, maxDurationMs
```

The endpoint fails closed when `STATS_PASSWORD` is absent. It must be installed as a secret, never placed in a URL, committed to Git, or embedded in a dashboard.

## Deployment

1. Create the Worker, D1 database, and R2 bucket described in `wrangler.toml`.
2. Apply all migrations, including `0002_tool_stats.sql`, `0003_pdf_documents.sql`, `0004_traffic_stats.sql`, `0005_document_payment_state.sql`, `0006_paid_tool_calls.sql`, and `0007_stats_hourly.sql`.
3. Set the exact HTTPS `PUBLIC_BASE_URL` to the new domain.
4. Set `MCP_ALLOWED_ORIGINS` only to approved client origins.
5. Install `CAPABILITY_SECRET`, `STATS_PASSWORD`, and `DOCUMENT_CONTAINER_TOKEN` with `wrangler secret put`.
6. Configure the live x402 network, USDC asset, recipient, facilitator, and price.
7. Run the typecheck, tests, dependency audit, and Worker dry run.
8. Deploy, then check `/`, `/docs`, `/llms.txt`, `/healthz`, `/v1/pricing`, `/.well-known/x402`, and the protected stats endpoint.

The Worker exposes PDF generation and deterministic native-text PDF operations through an isolated Cloudflare Container. The Worker owns authentication, capabilities, D1 metadata, R2 source/index objects, validation, and cleanup; the Container receives only bounded PDF bytes, runs with outbound Internet disabled, and returns bounded index or PNG results. OCR, visual semantic comparison, PDF/A conformance, and cryptographic signature verification remain outside this service.

## Security checklist

- Use HTTPS in live mode and an exact trusted public origin.
- Keep `CAPABILITY_SECRET`, `STATS_PASSWORD`, facilitator tokens, and wallet keys outside source control.
- Use a separate high-entropy document recovery key for every upload.
- Treat every capability as a bearer secret and avoid logging it.
- Keep MCP origins allowlisted; do not use `*` for a paid endpoint.
- Set Cloudflare account budgets and alerts because Browser Run, D1, R2, and Worker usage are metered.
- Keep input, page, output, extraction, and render limits enabled.
- Run the service in an isolated process before accepting public PDFs.
- Review the registry metadata and payment recipient before publishing.
- Reconcile uncertain settlements against the facilitator and chain before any operator action.

## Troubleshooting

| Symptom | Meaning | Action |
| --- | --- | --- |
| `402 payment_required` | The request has no acceptable signed payment | Use the returned x402 requirements and retry the exact request |
| `409 payment_replay` | A payment authorization was already used | Create a new payment authorization and idempotency key |
| `503 payment_recovery_pending` | Settlement outcome is unknown | Check the facilitator and chain; do not resubmit automatically |
| `503 document_parser_busy` or `503 document_parser_unavailable` | The isolated parser is busy, starting, or exceeded its 60-second deadline | Retry shortly with the same idempotency and recovery keys; document parsing has one active slot |
| `401 stats_unauthorized` | The operator password is missing or incorrect | Send the secret through an Authorization header |
| `503 stats_unconfigured` | No stats password/store is configured | Install `STATS_PASSWORD` and apply the stats migration |

## Versioning

Pin the server version in registry metadata, keep tool schemas backward compatible, and document any change to limits or payment requirements. Add a new tool when the operation has different safety, pricing, or output semantics; use optional modes when the same operation and authorization model still apply.
