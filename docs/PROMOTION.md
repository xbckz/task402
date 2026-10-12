# Discovery and promotion

Task402 is easiest to promote by making the first agent interaction cheap to understand and safe to test:

The current acquisition priority is **first paid completion**, not raw discovery volume. The public site now puts the $0.005 `web_evidence` path first, links directly to a signed-payment walkthrough, and exposes a legacy agent-directory manifest at `/.well-known/ai-plugin.json` alongside the MCP server card and x402 contract. A crawler can discover the service without payment; a wallet-enabled client still must approve the exact x402 terms before settlement.

- Keep the public overview at `https://task402.xyz/` and the compact summary at `https://task402.xyz/llms.txt`.
- Link the MCP Registry record, the public quickstart, and the pricing contract together so a client can verify the endpoint before it signs anything.
- Submit the factual listing below to agent directories, MCP catalogs, and relevant PDF/documentation communities after reviewing their rules.
- Ask early users to share the exact tool name and a small successful workflow (upload, search, cite, render) instead of asking for generic testimonials.
- Monitor the protected traffic funnel. A rise in discovery requests without tool calls means the docs or payment handoff needs work; a rise in payment challenges without paid calls means wallet or x402 guidance needs work.
- Treat a successful paid call, settlement receipt, and repeat call as the conversion events that matter. MCP initialize, `tools/list`, page views, and payment challenges are acquisition signals, not revenue.
- Register the origin with Agent402's seller router at `POST https://agent402.tools/api/index/register` using `{"origin":"https://task402.xyz"}`; verify the response says `listed: true` and `routable: true` before mentioning the listing publicly.

Verification snapshot (2026-10-12 UTC): the origin is registered with Agent402 (`listed: true`, `routable: true`, health 1), and `xyz.task402/x402-docs` version `0.2.0` was the latest active official MCP Registry release observed in the audit. Recheck both before publishing a claim because directory records and Bazaar indexing can change independently; Bazaar indexing remains asynchronous and is verified separately from Registry publication.

## Directory listing copy

**Task402 PDF Tools** — x402-paid PDF generation and deterministic native-text PDF operations for AI agents. Generate a paginated PDF from Markdown, or upload a PDF once and inspect metadata, map pages, search/read text, verify citations, compare documents, validate expectations, and render bounded page regions. REST and MCP Streamable HTTP are available at `https://task402.xyz`; pricing and limits are machine-readable at `/v1/pricing`. Native text only: OCR, visual semantic comparison, PDF/A conformance, and cryptographic signature validation are outside the service.

Do not buy traffic, generate fake calls, or claim a directory listing is verified until the directory confirms it. The public pages and Registry metadata are the durable discovery assets; external submissions should remain human-reviewed.

## Submission checklist

1. Confirm `server.json` validates and the public MCP endpoint answers an initialize request. The canonical paid MCP resource is `https://task402.xyz/mcp`; the Bazaar schema carries the `generate_pdf` tool name.
2. Submit the remote Streamable HTTP connector at [Glama's connector directory](https://glama.ai/mcp/connectors).
3. Submit the public endpoint through [Smithery's publishing flow](https://smithery.ai/docs/build/publish) when its review requirements are satisfied.
4. Include `https://task402.xyz/docs`, `https://task402.xyz/llms.txt`, and `https://task402.xyz/v1/pricing` in the listing notes.
5. After a real approved x402 test call, check whether the facilitator/Bazaar discovery search has indexed the resource. Do not claim indexing before verifying it.

The checked-in release also exposes `/demo`, `/v1/tools`, `/openapi.json`, `/llms.txt`, and `/.well-known/x402` as crawlable, credential-free entry points. Keep directory copy factual: indexing is paid, the bounded native-text tools are included after indexing, and OCR or visual semantic comparison are not provided.
