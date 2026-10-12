# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are AI agents and the developers configuring them. They need bounded, deterministic evidence operations for PDFs, public webpages, OpenAPI contracts, and read-only Base data without sending whole documents or requiring a separate SaaS account.

## Product Purpose

Task402 is a live x402-paid service that lets agents discover and call deterministic evidence tools over REST and Streamable HTTP MCP. Success means an agent can understand the contract, choose a narrowly scoped operation, pay the advertised USDC amount, and receive a bounded result it can cite or reuse.

## Positioning

Task402 combines machine-readable x402 payment requirements with deterministic evidence operations, keeping model context small and making the payment, limits, and output contract explicit.

## Operating Context

Agents discover the service through public web pages, machine-readable contracts, MCP, OpenAPI, and facilitator catalogs. PDF indexing returns a bearer capability used by subsequent document operations. Live payments use exact USDC on Base; local development is separate from production.

## Capabilities and Constraints

- PDF generation, PDF indexing, native-text evidence tools, public HTTPS web evidence, OpenAPI inspection/planning/diffing, and read-only Base chain tools are implemented.
- The production service runs on Cloudflare Workers with D1, R2, Browser Run, and a parser Container.
- PDFs are bounded and native-text focused; OCR, visual legal redlines, signature validation, and semantic truth checking are not provided.
- Web evidence does not send credentials or execute JavaScript.
- Chain tools never sign, submit, or move funds.
- Payment and pricing metadata must remain synchronized across REST, MCP, pricing, docs, registry metadata, and facilitator discovery.

## Brand Commitments

The product name is Task402. The requested public visual direction is VaultCord-inspired: black canvas, high-contrast white typography, restrained teal/green accents, pill controls, subtle technical texture, and proof-led sections. Task402 must use its own logo, copy, assets, and technical claims.

## Evidence on Hand

- Live production endpoint: https://task402.xyz
- Live MCP endpoint: https://task402.xyz/mcp
- Machine-readable pricing and tool contracts: /v1/pricing, /v1/tools, /openapi.json, /llms.txt
- Existing live payment tests and Base settlement transaction records are in examples/ and out/.
- No external customer testimonials or usage claims are available; the site must not invent them.

## Product Principles

- Let agents discover the exact contract before they spend.
- Make every paid operation bounded, deterministic, and reusable.
- Show the work through examples and outputs, not vague capability claims.
- Keep payment, limits, security, and failure recovery explicit.
- Treat mobile and machine-readable surfaces as first-class product surfaces.

## Accessibility & Inclusion

The public site must remain keyboard usable, readable on narrow screens, use visible focus states, maintain sufficient contrast, and expose meaningful headings, labels, and links for screen readers.
