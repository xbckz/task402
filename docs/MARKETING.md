# Task402 distribution plan

Task402 is easiest to adopt when an agent can discover a precise capability, see the price before paying, and copy one working call. The public site exposes the same contract at /v1/pricing, /v1/tools, /openapi.json, /llms.txt, /.well-known/x402, and /.well-known/mcp/server-card.json.

## Positioning

Use this one sentence in listings:

> Task402 gives AI agents bounded, citation-ready evidence from PDFs and public webpages, plus safe OpenAPI contract analysis and read-only Base chain data, paid per call with x402 USDC.

Lead with the PDF evidence workflow. The strongest repeat-use path is one paid PDF index followed by many included searches, cited context packs, field matches, quote checks, comparisons, and bounded page renders. Web evidence and API contract analysis are discovery hooks; chain reads are small, deterministic utilities.

## Discovery channels

1. **x402 Bazaar** — every paid REST and MCP challenge includes Bazaar metadata and absolute resources. Confirm cataloging through the facilitator discovery endpoint after the first successful payment; cataloging can be asynchronous.
2. **Official MCP Registry** — publish server.json as xyz.task402/x402-docs at version 0.3.2. Domain namespace proof or GitHub OIDC is required by the Registry publisher flow.
3. **Glama** — add this repository as an MCP connector. The root `glama.json` declares the GitHub maintainer for ownership verification; listing copy and connection guidance come from this document, the README, and `server.json`. Complete Glama's claim flow to synchronize ownership changes.
4. **Smithery** — publish the public Streamable HTTP URL after authenticating a Smithery namespace. Use the same concise description and link to /docs.
5. **Direct agent indexing** — keep /llms.txt, /openapi.json, the server card, robots, and sitemap current. These are free and cacheable, so they can be fetched by crawlers without touching paid stats.

The repository contains the metadata and copy required for these submissions. Directory publication still requires an account or publisher proof owned by the operator.

## Conversion improvements

- Keep all prices in atomic USDC and USD in every discovery response.
- Show the exact input schema and a copyable first call before asking for a wallet.
- Demonstrate discovery → 402 challenge → signed retry → result recovery in TypeScript and Python examples.
- Track unique payers, successful paid calls, challenge-to-payment conversion, repeat purchases, settlement value, and upstream failure rate. Raw call volume is not a proxy for revenue.
- Offer a small sponsored test budget only through a reversible campaign wallet; do not embed private keys in examples.

## Ready-to-run listing copy

**Short:** Citation-ready PDF and web evidence for agents, with OpenAPI contract analysis and read-only Base reads. x402 USDC, deterministic outputs, no model calls.

**Long:** Task402 is a production HTTP/MCP service for agents that need evidence without spending a full context window on a file. Pay once to index a PDF, then search, prepare cited context, match labeled fields, verify quotes, compare revisions, validate text, and render bounded page regions. Public web evidence, OpenAPI inspection/plans/diffs, and Base balance/transaction/ERC-20 reads are separately metered. Every operation has a machine-readable schema, explicit limits, idempotency, and x402 payment metadata.

## Launch checklist

- [ ] Publish server.json to the Official MCP Registry with domain or GitHub publisher proof.
- [ ] Add the HTTPS MCP connector to Glama and Smithery.
- [ ] Verify Task402 appears in the facilitator Bazaar for both type=http and type=mcp.
- [ ] Run the included live agent example with a funded test wallet.
- [ ] Publish one contract-review example, one PDF-citation example, and one transaction-reconciliation example.
- [ ] Review /v1/admin/stats weekly for conversion and failure trends before changing prices.
