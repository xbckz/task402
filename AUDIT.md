# Historical production audit — 2026-10-10

> This is an audit log, not a current deployment claim. Later sections supersede earlier findings, but live bindings, secrets, and settlement still require verification against the deployed Worker. Use the current release checks and `docs/PUBLISHING.md` before publishing operational status.

## Final Container follow-up — 2026-10-10

This section supersedes the historical deployment and native-ingestion boundaries recorded below. The public Worker now has a D1 document adapter/migration, R2 source/index persistence, a private parser Container binding, and REST/MCP document operations. Public health and pricing were independently verified; the deployment operator reports successful upload, inspect, map, search, read, citation, validation, render, comparison, and MCP tools/list smoke tests before this final hardening patch.

The final audit found and fixed these production blockers:

| Severity | Finding | Resolution |
| --- | --- | --- |
| High | Native parsing ran in a persistent HTTP process without a hard processing deadline or admission limit; concurrent uploads could exhaust the sole parser, and a blocked parser could remain pinned. | The Durable Object admits one task, starts with outbound Internet disabled and fixed instance memory, enforces a 60-second deadline outside the parser event loop, aborts forwarding, and destroys the Container in finally after success or failure. Each task gets fresh process/filesystem state. |
| Medium | The readiness retry loop also retried failed parsing requests, amplifying resource use and risking duplicate work. | Retry only health probes; send a document operation once. Set inactivity timeout only after readiness succeeds. |
| Medium | Parser output validation checked only a few top-level fields and buffered error responses without a bound. | Enforce the complete index schema, sequential/count-matched pages, original byte length, text/block aggregate bounds, bounded error output, and PNG signature. Preserve expected 400/413/415/422/503 statuses without exposing runtime details. |
| Low | REST discovery still advertised version 0.1.1 while MCP/registry metadata advertised 0.1.2, and documentation retained obsolete local-only/deployment text. | Align discovery to 0.1.2 and document current Container admission, deadline, and bindings. |

Verification: TypeScript check and all 35 tests pass, including simulated Durable Object admission, readiness ordering, successful VM reset, forced deadline destruction, release of admission, no operation retries, malformed index rejection, bounded parser errors, status preservation and PNG checks. The lifecycle tests execute the actual transpiled DO class with a platform stub; they do not claim to exercise Cloudflare's VM implementation. Wrangler dry-run including the Linux Docker build passes (1,924.58 KiB / 367.41 KiB gzip before the final discovery-version text change). Worker bundling keeps native PDF.js/canvas and local SQLite outside the Worker runtime.

Acceptance: **accepted at source level for the bounded single-slot public MVP after these fixes; redeploy and repeat live smoke tests before accepting the hardened deployment.** The previously deployed version does not contain these final lifecycle protections. No new credentials, payments, or remote changes were made by this audit. Single-slot parsing deliberately trades throughput/cold-start latency for containment. Documents remain synchronously ingested; overload returns 503 and callers retry with the same idempotency/recovery keys. This is not a durable asynchronous ingestion queue or a per-customer quota system. Account budgets/alerts, storage cleanup backlog monitoring, payment reconciliation and real on-chain settlement verification remain operator responsibilities; expired document authorization fails closed even if physical cleanup is delayed.

The remainder records earlier audit stages and their findings.

Scope: current REST/MCP implementation, native PDF.js extraction and crop rendering, local SQLite/file persistence, D1/R2 adapters and migration, capability/recovery authorization, x402 SDK integration, Worker bundle, and deployment documentation. No credentials were added and no deployment or blockchain transfer was performed.

## Findings fixed

| Severity | Finding | Resolution |
| --- | --- | --- |
| High | Local HTTP adapter ignored the original Host before rebuilding its trusted URL, permitting DNS rebinding access to the local API. | Reject authorities outside loopback/localhost and the explicitly configured live public authority. |
| High | The SDK returns facilitator JSON without matching a claimed settlement success to the requested payment. Malformed transaction/network/payer/amount fields could release a PDF as paid. | Require literal success, an EVM transaction hash, the expected network, and matching optional amount/payer. Mismatches enter the existing uncertain-settlement recovery path. The facilitator remains a trusted settlement authority. |
| Medium | Empty PDF.js text items advanced a cursor over nonempty text blocks, dropping later native text and corrupting search/read/citation results. | Assemble directly from source text items and preserve empty-item end-of-line markers. |
| Medium | Local generated artifacts were never cleaned automatically; only documents had an hourly cleanup timer. | Clean both job and document retention on startup and hourly, with failed batches remaining retryable. |
| Medium | The local HTTP adapter kept consuming oversized request bodies before returning an error. | Stop reading immediately at the adapter limit and return 413 with connection closure. |
| Medium | Public/facilitator URL validation used a protocol prefix rather than parsed URL structure. | Validate HTTPS URLs and enforce an exact public origin without URL credentials, path, query, or fragment. |
| Low | Text comparison omitted added/deleted blank pages from its changed-page count. | Compare page presence as well as normalized native text. |
| Low | Whitespace-only required text normalized to an empty string and always passed validation. | Reject empty normalized expectations. |
| Low | Aggregate extracted-text size was checked only after all remaining pages were processed. | Reject as soon as the limit is exceeded. |
| Low | MCP responses lacked explicit cache prevention despite containing capabilities and document text. | Set Cache-Control: no-store on transport responses. |

## Retained production boundaries

- The paid Worker exposes generation/status/download and their MCP tools. Native document tools are absent when no document service is configured; document routes return 501. The generated Worker contains no PDF.js, native canvas, SQLite, or Playwright imports.
- Native PDF operations remain loopback development features and are disabled in live mode and NODE_ENV=production. They do not have process-enforced CPU/memory limits for malicious compressed PDFs. This is a prerequisite before any public ingestion service, not a guarantee supplied by upload/output bounds.
- Payment verification precedes rendering; settlement follows durable artifact storage. Nonce uniqueness and durable leases protect concurrent processing; ambiguous settlement is never automatically resent. Reconciliation is manual and uncertain artifacts deliberately remain retained.
- Account-specific Browser Run/D1/R2 behavior and real facilitator/network settlement still require an operator-owned integration test. Dry-run packaging proves bundling, not live resource provisioning, payment finality, operational monitoring, or a spending cap. Cloudflare's [Quick Actions documentation](https://developers.cloudflare.com/browser-run/quick-actions/) confirms the Worker binding API used here.
- Before deployment, provision bindings, apply the migration, configure the exact public origin and live facilitator/network/token/recipient terms, install secrets through the provider, and establish monitoring/reconciliation and account usage controls. No deployment is ready until those operator-owned settings are supplied.

## Verification

TypeScript check passed. All 28 tests passed, including focused regressions for the fixed behaviors and a real local-process smoke test for Host rejection, early oversized-body rejection, and durable startup cleanup. `npm audit --json` reported zero known vulnerabilities across all dependencies, including development dependencies. Wrangler 4.149.0 dry-run passed; final bundle 1,873.70 KiB uncompressed / 355.34 KiB gzip. The emitted Worker contains no `node:sqlite`, PDF.js, native canvas, local job/store, or local stats adapter imports.

## Documentation and protected stats follow-up

| Severity | Finding | Resolution |
| --- | --- | --- |
| Medium | Successful REST retries counted a completed settlement again, while successful MCP generation omitted settled totals entirely. | Count first generation completions in both transports; recovered requests still count as calls without counting their settlement again. REST and official MCP-client regression tests cover retries. |
| Medium | SQL atomic totals decoded as JavaScript numbers could lose precision above 2^53. | Cast the SQL integer sum to text before SQLite/D1 decoding; preserve string totals through BigInt aggregation. A regression sums 9,007,199,254,740,993 plus two exactly. |
| Low | The hours filter used daily buckets but reported an exact timestamp and was described as an exact window. | Return the actual UTC midnight boundary and document that up to 24 additional hours can be included. |
| Low | Configured passwords above 256 characters passed startup validation but could never authenticate. | Align local and Worker startup validation with the endpoint's 20–256-character bounds. |
| Low | The guide requested a nonexistent per-tool average-duration field. | Show available total and maximum duration fields instead. |

Stats authentication fails closed, accepts bearer or dedicated password headers, and uses bounded comparison without returning the secret. Responses use no-store caching. Stats aggregate only fixed tool names and counters, without document content, capabilities, wallet addresses, payment payloads, or passwords. The checked-in migrations produce the same stats table as the local adapter and accept the shared upsert. Native SQLite and D1 adapters share environment-neutral SQL/helpers while remaining separate entry-point dependencies.

Stats remain best-effort operational telemetry. Writes can fail without failing paid work; crashes, uncertain settlements, and finalization failures require durable-job/facilitator reconciliation. Counters do not substitute for an accounting ledger. The existing SQLite signed 64-bit aggregate range is ample for the configured microtransaction price but is not an unlimited-precision persistent ledger.

Acceptance: **accepted for the documented production Worker scope at the source-code level after these fixes; deployment is not yet production-validated.** No remaining high or medium issue was found in this follow-up scope. Provision actual D1/R2/Browser Run bindings (the D1 ID remains a placeholder), apply both migrations, install unique high-entropy secrets, configure live payment terms, and run an operator-owned deployed payment/storage/cleanup smoke test before serving production traffic. Native PDF ingestion remains rejected for public production use until it has enforced process isolation and resource/admission limits. No remote migration, deployment, secret installation, or blockchain transfer was performed during this audit.

## Deployment follow-up — 2026-10-10

The operator-owned Cloudflare setup has since been provisioned:

- Worker `x402-docs-mvp` deployed with custom domain `task402.xyz` and version `25acac3c-d022-433a-8a0d-36b9debfbd10` after secret installation.
- D1 database `x402-docs-mvp` (`27c166ff-9da2-4d0f-82d6-876aac851a4d`) has both migrations applied, including `tool_stats_daily`.
- R2 bucket `x402-docs-mvp` is bound as `ARTIFACTS`.
- Base mainnet USDC terms are configured for the supplied recipient address and the reachable production facilitator `https://facilitator.openx402.ai`, whose public capabilities include the discovery extension.
- Fresh `CAPABILITY_SECRET` and `STATS_PASSWORD` secrets were installed without entering source control. The local operator copy of the stats password is ignored under `.data/stats-password.txt`.

The Cloudflare custom-domain object is enabled, but the `task402.xyz` zone is still pending registrar nameserver delegation. Public DNS smoke checks therefore cannot complete yet. Delegate the zone to `amanda.ns.cloudflare.com` and `braden.ns.cloudflare.com`, wait for activation, then verify `/healthz`, `/v1/pricing`, a `402` payment challenge, and the authenticated `/v1/admin/stats` endpoint. No payment was signed or settled during setup.
