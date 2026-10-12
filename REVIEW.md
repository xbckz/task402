# Historical independent quality review

> This document records an earlier MVP review. Its test counts and deployment notes are historical. The current repository validation is the `npm run typecheck`, `npm test`, and `npm run deploy:dry-run` result reported with the latest release.

Luna Max implemented this MVP. The parent agent reviewed the source, requested corrections, and independently exercised the running service.

## Verified

- `npm run typecheck`: passed.
- `npm test`: all 11 tests passed. Payment tests use mocks, including mocked HTTP responses through the real official x402 SDK.
- `npm run deploy:dry-run`: passed with D1, R2, and Browser Run bindings. This bundles the Worker without deploying it.
- Production dependency audit: no known vulnerabilities reported at review time.
- 17 independent checks against the running local service passed: real Chromium PDF generation, authorized download, rejected missing/wrong download credentials, repeated request, conflicting request, status, malformed JSON, content type, API and local HTTP body size limits, MCP origin check, official MCP client connection/discovery/generation/status/download, health, and pricing. The final checks used a fresh server process.
- Independent recovery checks passed: concurrent matching paid requests render/settle once; an obsolete lease holder cannot update state after takeover; the Worker refuses development payment bypass and missing live configuration.
- Real PDF samples were rendered and inspected visually. A two-page report and ten-page stress document retained international text, all 140 table item identifiers, long unbroken strings, and final markers. Extracted characters remained within page bounds. Numeric table alignment was checked after correction.

## Corrections requested and incorporated

- Bind download capabilities to the persisted job identifier.
- Pass each request's verified payment payload directly through processing.
- Fence job updates by lease token, and return recovery details for pending jobs.
- Preserve payment replay records after artifact expiration.
- Recognize SDK verification/settlement exceptions and distinguish known rejection from an uncertain settlement outcome.
- Refuse automatic settlement retries after uncertainty.
- Make local artifact writes retryable and atomic.
- Return absolute artifact URLs, bound MCP request size, and validate expiration before replaying successful results.
- Fix long table cells, numeric alignment, and PDF EOF checks.

## Remaining deployment validation

The local MVP works and the Worker bundles successfully. No live on-chain payment or real Cloudflare Browser Run, D1, or R2 integration was exercised. Those require account configuration and a deployed end-to-end test. Follow the README before enabling paid traffic.

An uncertain settlement requires operator reconciliation. Do not blindly resend the payment or delete the job ledger. The implementation checks the PDF container and size; it does not automatically prove every possible layout is correct. General document formats, OCR, DOCX, and spreadsheet tools are outside this PDF-first MVP.

The Cloudflare $5 plan is a base subscription, not an application spending cap. Configure account usage controls and observe actual Browser Run usage before opening public traffic.
